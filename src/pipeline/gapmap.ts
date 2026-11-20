import { cv, MatPool } from './cv';
import type { Rect } from './warp';
import type { RGBAImage } from './types';

/**
 * Gap map: where the dark cut lines between pieces are.
 *
 * Hue can't tell brownie from brownie (or from a wooden board); brightness can. A black-hat on the
 * LAB lightness channel turns every thin dark structure into a bright ridge. That includes the
 * crust cracks on brownie tops, which look like cut lines locally. The difference is shape: a cut
 * runs straight across a whole piece, while a crack is short and wiggly. So the raw ridges are
 * filtered to long, straight, well-supported line segments only.
 */
export interface GapMap {
  /** Raw candidate ridges (0/255) before filtering: cuts and cracks alike. */
  raw: Uint8Array;
  /** Filtered gap strength (0–255): only long straight cuts survive. */
  gap: Uint8Array;
  /** Accepted cut segments in warped coordinates. */
  segments: [number, number, number, number][];
  /** Black-hat kernel / typical piece width used. */
  kernel: number;
  pieceWidth: number;
}

const odd = (v: number) => (Math.round(v) | 1);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const ellipse = (k: number) => cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(k, k));

/** LAB lightness (OpenCV 8-bit scale, 0–255) of an RGBA image, lightly blurred. */
export function lightness(img: RGBAImage, pool: MatPool): any {
  const rgba = pool.add(cv.matFromImageData(img));
  const rgb = pool.add(new cv.Mat());
  cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);
  const lab = pool.add(new cv.Mat());
  cv.cvtColor(rgb, lab, cv.COLOR_RGB2Lab);
  const ch = pool.add(new cv.MatVector());
  cv.split(lab, ch);
  const L = pool.add(ch.get(0));
  cv.GaussianBlur(L, L, new cv.Size(3, 3), 0);
  return L;
}

/**
 * @param pieceWidth typical piece width in warped pixels (from tap spacing, or a guess)
 * @param sensitivity 0–1. Higher keeps fainter and shorter cut lines.
 */
export function buildGapMap(img: RGBAImage, inner: Rect, pieceWidth: number, sensitivity = 0.5): GapMap {
  const W = img.width;
  const H = img.height;
  const N = W * H;
  const s = clamp(sensitivity, 0, 1);
  const pool = new MatPool();
  try {
    const L = lightness(img, pool);

    // 1. Black-hat: thin dark structures (narrower than the kernel) become bright ridges.
    const k = clamp(odd(pieceWidth * 0.14), 7, 25);
    const bh = pool.add(new cv.Mat());
    cv.morphologyEx(L, bh, cv.MORPH_BLACKHAT, pool.add(ellipse(k)));

    // 2. Adaptive threshold: a ridge must stand out from its own neighbourhood (so a dark-ish
    //    shadowed area doesn't light up as a whole), plus an absolute floor set by sensitivity.
    const block = clamp(odd(pieceWidth * 0.6), 15, 151);
    const cand = pool.add(new cv.Mat());
    cv.adaptiveThreshold(bh, cand, 255, cv.ADAPTIVE_THRESH_MEAN_C, cv.THRESH_BINARY, block, -(10 - 6 * s));
    const floor = 34 - 26 * s;
    const bd = bh.data as Uint8Array;
    const cd = cand.data as Uint8Array;
    for (let y = 0, i = 0; y < H; y++) {
      for (let x = 0; x < W; x++, i++) {
        if (bd[i] < floor || x < inner.x0 || x > inner.x1 || y < inner.y0 || y > inner.y1) cd[i] = 0;
      }
    }
    const raw = new Uint8Array(cd);

    // 3. Keep only long straight segments. Hough finds the straight runs; each is then checked for
    //    support along its whole length (a crack's chord wanders off the crack, a cut's doesn't).
    // 0.5 × piece width at s = 0.5. Real cuts run the full length of a piece; crust cracks that
    // happen to be straight-ish (common along the front edge) are usually shorter.
    const minLen = Math.max(12, pieceWidth * (0.75 - 0.5 * s));
    const lines = pool.add(new cv.Mat());
    cv.HoughLinesP(cand, lines, 1, Math.PI / 180, Math.round(minLen * 0.5), minLen, Math.max(3, minLen * 0.12));
    const near = pool.add(new cv.Mat());
    cv.dilate(cand, near, pool.add(ellipse(5)));
    const nd = near.data as Uint8Array;
    const ld = lines.data32S as Int32Array;
    const segs: [number, number, number, number][] = [];
    const cands: { seg: [number, number, number, number]; depth: number }[] = [];
    const minSupport = 0.9 - 0.14 * s;
    for (let j = 0; j < ld.length; j += 4) {
      const [x0, y0, x1, y1] = [ld[j], ld[j + 1], ld[j + 2], ld[j + 3]];
      const len = Math.hypot(x1 - x0, y1 - y0);
      const steps = Math.max(2, Math.round(len));
      let hit = 0;
      for (let t = 0; t <= steps; t++) {
        const x = Math.round(x0 + ((x1 - x0) * t) / steps);
        const y = Math.round(y0 + ((y1 - y0) * t) / steps);
        if (nd[y * W + x]) hit++;
      }
      if (hit / (steps + 1) >= minSupport) {
        let sum = 0;
        for (let t = 0; t <= steps; t++) {
          const x = Math.round(x0 + ((x1 - x0) * t) / steps);
          const y = Math.round(y0 + ((y1 - y0) * t) / steps);
          // Strongest black-hat within ±2 px of the line (the line may be a pixel off the crease).
          let m = 0;
          for (let d = -2; d <= 2; d++) {
            const yy = Math.min(H - 1, Math.max(0, y + d));
            const xx = Math.min(W - 1, Math.max(0, x + d));
            m = Math.max(m, bd[yy * W + x], bd[y * W + xx]);
          }
          sum += m;
        }
        cands.push({ seg: [x0, y0, x1, y1], depth: sum / (steps + 1) });
      }
    }
    // Depth check: a cut between pieces is a deep, near-black gap; a straight-ish crust crack is
    // usually much fainter. Keep segments at least ~45% as deep as the deepest cuts.
    const depths = cands.map((c) => c.depth).sort((a, b) => a - b);
    const deep = depths.length ? depths[Math.floor(depths.length * 0.9)] : 0;
    for (const c of cands) if (c.depth >= (0.55 - 0.2 * s) * deep) segs.push(c.seg);

    // 4. Within a band around each accepted segment, the gap strength is the black-hat response
    //    itself, which peaks exactly on the real crease (Hough lines can be a couple of px off at
    //    their ends). Keeping that V-shaped profile matters: a flat band would be won entirely by
    //    whichever piece's flood reaches it first, shifting every cut sideways.
    const band = pool.add(cv.Mat.zeros(H, W, cv.CV_8UC1));
    for (const [x0, y0, x1, y1] of segs) {
      cv.line(band, new cv.Point(x0, y0), new cv.Point(x1, y1), new cv.Scalar(255), 9);
    }
    const bandD = band.data as Uint8Array;
    const vals: number[] = [];
    for (let i = 0; i < N; i++) if (bandD[i] && cd[i]) vals.push(bd[i]);
    vals.sort((p, q) => p - q);
    const ref = Math.max(8, vals.length ? vals[Math.floor(vals.length * 0.9)] : 8);
    const gap = new Uint8Array(N);
    for (let i = 0; i < N; i++) if (bandD[i] && nd[i]) gap[i] = Math.min(255, Math.round((255 * bd[i]) / ref));

    // 5. Grid prior: if the cuts line up in rows/columns, strengthen ridge pixels along those lines.
    strengthenGrid(gap, raw, W, H, inner);

    return { raw, gap, segments: segs, kernel: k, pieceWidth };
  } finally {
    pool.free();
  }
}

/**
 * Row/column projection profiles of the filtered gap map. Strong peaks (lines of cut running most
 * of the way across the board) get their nearby raw ridge pixels boosted to full strength.
 */
function strengthenGrid(gap: Uint8Array, raw: Uint8Array, W: number, H: number, r: Rect) {
  const boost = (vertical: boolean) => {
    const len = vertical ? r.x1 - r.x0 + 1 : r.y1 - r.y0 + 1;
    const span = vertical ? r.y1 - r.y0 + 1 : r.x1 - r.x0 + 1;
    const prof = new Float32Array(len);
    for (let y = r.y0; y <= r.y1; y++) {
      for (let x = r.x0; x <= r.x1; x++) {
        if (gap[y * W + x]) prof[vertical ? x - r.x0 : y - r.y0]++;
      }
    }
    // Smooth over ±2 px.
    const sm = prof.map((_, i) => {
      let s = 0;
      for (let d = -2; d <= 2; d++) s += prof[Math.max(0, Math.min(len - 1, i + d))];
      return s / 5;
    });
    for (let i = 2; i < len - 2; i++) {
      const isPeak = sm[i] >= sm[i - 1] && sm[i] >= sm[i + 1] && sm[i] > 0.35 * span;
      if (!isPeak) continue;
      for (let o = 0; o < span; o++) {
        for (let d = -3; d <= 3; d++) {
          const x = vertical ? r.x0 + i + d : r.x0 + o;
          const y = vertical ? r.y0 + o : r.y0 + i + d;
          if (x < 0 || y < 0 || x >= W || y >= H) continue;
          const j = y * W + x;
          if (raw[j]) gap[j] = 255;
        }
      }
    }
  };
  boost(true);
  boost(false);
}

/**
 * The image watershed floods: dark thin structures (cracks AND cuts) are first closed away, then
 * only the filtered cut lines are painted back in as dark barriers. Cracks therefore stop acting as
 * boundaries, while real cuts become stronger ones. Returns 8-bit RGB (what cv.watershed needs).
 */
export function elevationImage(img: RGBAImage, gm: GapMap, pool: MatPool): any {
  const rgba = pool.add(cv.matFromImageData(img));
  const rgb = pool.add(new cv.Mat());
  cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);
  const closed = pool.add(new cv.Mat());
  cv.morphologyEx(rgb, closed, cv.MORPH_CLOSE, pool.add(ellipse(gm.kernel)));
  const out = pool.add(new cv.Mat());
  cv.GaussianBlur(rgb, out, new cv.Size(3, 3), 0);
  // Ridges the filter rejected (cracks) are replaced by the closed image, i.e. erased. Ridges it
  // kept (cuts) are darkened. Everything else stays as photographed, so real edges the gap map
  // didn't catch still guide the watershed.
  const near = dilateMask(gm.gap, img.width, img.height, 5, pool);
  const crackZone = dilateMask(gm.raw, img.width, img.height, 3, pool);
  const d = out.data as Uint8Array;
  const c = closed.data as Uint8Array;
  for (let i = 0; i < gm.gap.length; i++) {
    const g = gm.gap[i];
    if (g) {
      const f = 1 - (0.9 * g) / 255;
      d[i * 3] *= f;
      d[i * 3 + 1] *= f;
      d[i * 3 + 2] *= f;
    } else if (crackZone[i] && !near[i]) {
      d[i * 3] = c[i * 3];
      d[i * 3 + 1] = c[i * 3 + 1];
      d[i * 3 + 2] = c[i * 3 + 2];
    }
  }
  // Smooth crust texture so it doesn't act as a maze of tiny walls; edges between pieces are
  // large-scale and survive a median filter.
  cv.medianBlur(out, out, 5);
  return out;
}

export function dilateMask(m: Uint8Array, W: number, H: number, k: number, pool: MatPool): Uint8Array {
  const mat = pool.add(cv.matFromArray(H, W, cv.CV_8UC1, m));
  const out = pool.add(new cv.Mat());
  cv.dilate(mat, out, pool.add(ellipse(k)));
  return out.data as Uint8Array;
}
