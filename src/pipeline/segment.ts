import { cv, MatPool } from './cv';
import type { RGBAImage } from './types';

export interface SegParams {
  /** OpenCV hue (0–180). Brownie and wood are both ~5–20, so value (darkness) does most of the work. */
  hueCenter: number;
  hueWidth: number;
  satMin: number;
  /** Max brightness (0–255) counted as brownie. null = automatic (Otsu split between board and brownie). */
  valMax: number | null;
  /** Pieces smaller than this % of the board area are ignored. */
  minAreaPct: number;
  /** 0–1: how aggressively touching pieces are split (fraction of the per-blob distance-transform peak). */
  split: number;
  /** Dark-crease detector strength threshold (0 = off). Lower = more sensitive. */
  crease: number;
  /** Reclaim glare highlights touching brownie edges. */
  glare: boolean;
}

export const DEFAULT_PARAMS: SegParams = {
  hueCenter: 12,
  hueWidth: 22,
  satMin: 35,
  valMax: null,
  minAreaPct: 0.4,
  split: 0.45,
  crease: 24,
  glare: true,
};

export interface SegDebug {
  /** Binary brownie mask after cleanup (0/255). */
  mask: Uint8Array;
  /** Distance transform, normalised to 0–255. */
  dist: Uint8Array;
  /** Detected dark creases (0/255). */
  crease: Uint8Array;
  /** Areas near detected glare highlights (0/255). */
  glare: Uint8Array;
  valMaxUsed: number;
}

export interface SegResult {
  /** Per-pixel label: 0 = background, 1..n = piece. */
  labels: Int32Array;
  debug: SegDebug;
}

/** OpenCV-compatible RGB->HSV for 8-bit values (H in 0–180). */
export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = (60 * (g - b)) / d;
    else if (max === g) h = 120 + (60 * (b - r)) / d;
    else h = 240 + (60 * (r - g)) / d;
    if (h < 0) h += 360;
  }
  return [h / 2, max === 0 ? 0 : (255 * d) / max, max];
}

const hueDist = (a: number, b: number) => {
  const d = Math.abs(a - b);
  return Math.min(d, 180 - d);
};

/** Fills interior holes (e.g. glare spots, light crumbs) of every blob in a 0/255 mask. */
export function fillHoles(mask: any, pool: MatPool): any {
  const contours = pool.add(new cv.MatVector());
  const hier = pool.add(new cv.Mat());
  cv.findContours(mask, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
  const out = pool.add(cv.Mat.zeros(mask.rows, mask.cols, cv.CV_8UC1));
  cv.drawContours(out, contours, -1, new cv.Scalar(255), cv.FILLED);
  return out;
}

const ellipse = (k: number) => cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(k, k));

export function autoSegment(img: RGBAImage, p: SegParams = DEFAULT_PARAMS): SegResult {
  const W = img.width;
  const H = img.height;
  const N = W * H;
  const pool = new MatPool();
  try {
    const rgba = pool.add(cv.matFromImageData(img));
    const rgb = pool.add(new cv.Mat());
    cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);
    const blur = pool.add(new cv.Mat());
    cv.GaussianBlur(rgb, blur, new cv.Size(5, 5), 0);
    const hsv = pool.add(new cv.Mat());
    cv.cvtColor(blur, hsv, cv.COLOR_RGB2HSV);
    const ch = pool.add(new cv.MatVector());
    cv.split(hsv, ch);
    const V = pool.add(ch.get(2));

    // 1. Colour threshold. Brownies on wood share hue, so brightness is the main separator; Otsu picks
    //    the brightness split automatically unless the user set one.
    let valMax = p.valMax;
    if (valMax == null) {
      const tmp = pool.add(new cv.Mat());
      valMax = cv.threshold(V, tmp, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU) as number;
    }
    const raw = pool.add(new cv.Mat(H, W, cv.CV_8UC1));
    const hd = hsv.data as Uint8Array;
    const rd = raw.data as Uint8Array;
    for (let i = 0, j = 0; i < N; i++, j += 3) {
      rd[i] =
        hd[j + 2] <= valMax && hd[j + 1] >= p.satMin && hueDist(hd[j], p.hueCenter) <= p.hueWidth ? 255 : 0;
    }

    // 2. Morphological cleanup: drop speckle, close small gaps, fill holes left by glare.
    const k5 = pool.add(ellipse(5));
    const k9 = pool.add(ellipse(9));
    const opened = pool.add(new cv.Mat());
    cv.morphologyEx(raw, opened, cv.MORPH_OPEN, k5);

    // 2b. Glare recovery: a highlight on a brownie's edge bites a notch out of it that hole-filling
    //     can't fix (the soft halo is too bright for "brownie" yet not bright enough for "glare").
    //     Brownies are roughly convex, so near a detected highlight each blob is filled out to its
    //     convex hull. Away from highlights, shapes are left exactly as segmented.
    const glareOut = new Uint8Array(N);
    if (p.glare) {
      const core = pool.add(cv.Mat.zeros(H, W, cv.CV_8UC1));
      const cd = core.data as Uint8Array;
      let nCore = 0;
      for (let i = 0, j = 0; i < N; i++, j += 3) {
        if (hd[j + 2] > 205 && hd[j + 1] < 90) {
          cd[i] = 255;
          nCore++;
        }
      }
      if (nCore > 0) {
        const halo = pool.add(new cv.Mat());
        const k25 = pool.add(ellipse(25));
        cv.dilate(core, halo, k25);
        const hulls = pool.add(cv.Mat.zeros(H, W, cv.CV_8UC1));
        const contours = pool.add(new cv.MatVector());
        const hier = pool.add(new cv.Mat());
        cv.findContours(opened, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
        const hv = pool.add(new cv.MatVector());
        for (let k = 0; k < contours.size(); k++) {
          const c = contours.get(k);
          const h = new cv.Mat();
          cv.convexHull(c, h, false, true);
          hv.push_back(h);
          h.delete();
          c.delete();
        }
        cv.drawContours(hulls, hv, -1, new cv.Scalar(255), cv.FILLED);
        const od = opened.data as Uint8Array;
        const ha = halo.data as Uint8Array;
        const hu = hulls.data as Uint8Array;
        for (let i = 0; i < N; i++) {
          if (ha[i]) glareOut[i] = 255;
          if (ha[i] && hu[i] && !od[i]) od[i] = 255;
        }
      }
    }
    const closed = pool.add(new cv.Mat());
    cv.morphologyEx(opened, closed, cv.MORPH_CLOSE, k9);
    const mask = fillHoles(closed, pool);
    const md = mask.data as Uint8Array;

    // 3. Dark creases between cut pieces (black-hat picks out thin dark lines). They are removed only
    //    when placing watershed seeds, so they help split touching pieces without eating area.
    const creaseOut = new Uint8Array(N);
    const seedSrc = pool.add(mask.clone());
    if (p.crease > 0) {
      const k11 = pool.add(ellipse(11));
      const bh = pool.add(new cv.Mat());
      cv.morphologyEx(V, bh, cv.MORPH_BLACKHAT, k11);
      const bd = bh.data as Uint8Array;
      const sd = seedSrc.data as Uint8Array;
      for (let i = 0; i < N; i++) {
        if (bd[i] > p.crease && md[i]) {
          creaseOut[i] = 255;
          sd[i] = 0;
        }
      }
      const k3 = pool.add(ellipse(3));
      cv.morphologyEx(seedSrc, seedSrc, cv.MORPH_OPEN, k3);
    }

    // 4. Distance transform; seeds = pixels above `split` × that blob's own peak (per-blob, so small
    //    pieces still get a seed next to big ones).
    const dist = pool.add(new cv.Mat());
    cv.distanceTransform(seedSrc, dist, cv.DIST_L2, 5);
    const dd = dist.data32F as Float32Array;
    const cc = pool.add(new cv.Mat());
    const nCC = cv.connectedComponents(seedSrc, cc, 8, cv.CV_32S) as number;
    const ccd = cc.data32S as Int32Array;
    const peak = new Float32Array(nCC);
    let globalPeak = 1e-6;
    for (let i = 0; i < N; i++) {
      if (dd[i] > peak[ccd[i]]) peak[ccd[i]] = dd[i];
      if (dd[i] > globalPeak) globalPeak = dd[i];
    }
    const fg = pool.add(cv.Mat.zeros(H, W, cv.CV_8UC1));
    const fd = fg.data as Uint8Array;
    for (let i = 0; i < N; i++) {
      const l = ccd[i];
      if (l > 0 && dd[i] > p.split * peak[l]) fd[i] = 255;
    }

    // 5. Watershed: markers 2..n from seeds, 1 = sure background, 0 = unknown.
    const markers = pool.add(new cv.Mat());
    const nSeeds = cv.connectedComponents(fg, markers, 8, cv.CV_32S) as number;
    const sureBg = pool.add(new cv.Mat());
    cv.dilate(mask, sureBg, k5, new cv.Point(-1, -1), 2);
    const mk = markers.data32S as Int32Array;
    const sb = sureBg.data as Uint8Array;
    for (let i = 0; i < N; i++) {
      if (mk[i] > 0) mk[i] += 1;
      else if (!sb[i]) mk[i] = 1;
    }
    if (nSeeds > 1) cv.watershed(blur, markers);

    // 6. Labels = watershed regions inside the mask; drop tiny ones and renumber.
    const counts = new Int32Array(nSeeds + 2);
    for (let i = 0; i < N; i++) if (md[i] && mk[i] >= 2) counts[mk[i]]++;
    const minArea = (p.minAreaPct / 100) * N;
    const remap = new Int32Array(nSeeds + 2);
    let next = 1;
    for (let l = 2; l < counts.length; l++) if (counts[l] >= minArea) remap[l] = next++;
    const labels = new Int32Array(N);
    for (let i = 0; i < N; i++) if (md[i] && mk[i] >= 2) labels[i] = remap[mk[i]];

    const distOut = new Uint8Array(N);
    for (let i = 0; i < N; i++) distOut[i] = Math.min(255, (dd[i] / globalPeak) * 255);

    return {
      labels,
      debug: { mask: new Uint8Array(md), dist: distOut, crease: creaseOut, glare: glareOut, valMaxUsed: valMax },
    };
  } finally {
    pool.free();
  }
}

/** Suggests colour params from a tapped sample of brownie (median over a small patch). */
export function paramsFromSample(img: RGBAImage, x: number, y: number, base: SegParams): SegParams {
  const r = 7;
  const hs: number[] = [];
  const ss: number[] = [];
  const vs: number[] = [];
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const px = Math.round(x + dx);
      const py = Math.round(y + dy);
      if (px < 0 || py < 0 || px >= img.width || py >= img.height) continue;
      const k = (py * img.width + px) * 4;
      const [h, s, v] = rgbToHsv(img.data[k], img.data[k + 1], img.data[k + 2]);
      hs.push(h);
      ss.push(s);
      vs.push(v);
    }
  }
  const med = (a: number[]) => a.sort((m, n) => m - n)[a.length >> 1];
  const v = med(vs);
  return {
    ...base,
    hueCenter: Math.round(med(hs)),
    hueWidth: 18,
    satMin: Math.max(0, Math.round(med(ss) - 70)),
    valMax: Math.min(255, Math.round(v + 45)),
  };
}
