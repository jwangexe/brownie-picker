import { cv, MatPool } from './cv';
import type { Pt, RGBAImage } from './types';
import type { Rect } from './warp';

/** CIE Lab on OpenCV's 8-bit scale: L 0–255, a and b centred on 0 (not +128). */
export interface LabImage {
  L: Uint8Array;
  a: Int8Array;
  b: Int8Array;
}

export function toLab(img: RGBAImage): LabImage {
  const pool = new MatPool();
  try {
    const rgba = pool.add(cv.matFromImageData(img));
    const rgb = pool.add(new cv.Mat());
    cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);
    cv.GaussianBlur(rgb, rgb, new cv.Size(3, 3), 0);
    const lab = pool.add(new cv.Mat());
    cv.cvtColor(rgb, lab, cv.COLOR_RGB2Lab);
    const d = lab.data as Uint8Array;
    const n = img.width * img.height;
    const L = new Uint8Array(n);
    const a = new Int8Array(n);
    const b = new Int8Array(n);
    for (let i = 0; i < n; i++) {
      L[i] = d[i * 3];
      a[i] = d[i * 3 + 1] - 128;
      b[i] = d[i * 3 + 2] - 128;
    }
    return { L, a, b };
  } finally {
    pool.free();
  }
}

/** What "brownie" looks like in this photo, learned from the pixels around the user's taps. */
export interface ColourModel {
  /** Medians. */
  L: number;
  a: number;
  b: number;
  chroma: number;
  /** Robust spreads (1.4826 × MAD), floored so a uniform sample doesn't make the model brittle. */
  sL: number;
  sa: number;
  sb: number;
}

const med = (v: number[]) => (v.length ? [...v].sort((p, q) => p - q)[v.length >> 1] : 0);
const spread = (v: number[], m: number, floor: number) => Math.max(floor, 1.4826 * med(v.map((x) => Math.abs(x - m))));

export function modelFrom(Ls: number[], As: number[], Bs: number[]): ColourModel {
  const L = med(Ls);
  const a = med(As);
  const b = med(Bs);
  return { L, a, b, chroma: med(As.map((x, i) => Math.hypot(x, Bs[i]))), sL: spread(Ls, L, 12), sa: spread(As, a, 4), sb: spread(Bs, b, 5) };
}

export function colourModel(lab: LabImage, W: number, seeds: Pt[], r = 5): ColourModel {
  const Ls: number[] = [];
  const As: number[] = [];
  const Bs: number[] = [];
  const H = lab.L.length / W;
  for (const s of seeds) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = Math.round(s.x) + dx;
        const y = Math.round(s.y) + dy;
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const i = y * W + x;
        Ls.push(lab.L[i]);
        As.push(lab.a[i]);
        Bs.push(lab.b[i]);
      }
    }
  }
  return modelFrom(Ls, As, Bs);
}

/**
 * Sure-background pixels (1 = background):
 *  - everything outside the board quad,
 *  - washed-out pixels: paper / plate, light and much less coloured than the tapped brownies,
 *  - clearly-not-brownie colours: more than 6 robust spreads from the tapped brownies in Lab
 *    (a wooden board unlike the brownies, a plate rim...). Darker pixels are judged on hue only:
 *    side faces and crust cracks are dark brownie, not background.
 *  - very dark pixels, either everywhere (`true`, Suggest's over-segmentation) or only inside a
 *    given zone (the accepted cut lines, for tapped pieces). Not everywhere for tapped pieces: a
 *    deep crust crack is as dark as a cut, and a background marker inside a crack floods the
 *    piece's own top. Dark pixels are left out of the measured area anyway (topFaces).
 */
export function darkLimit(model: ColourModel) {
  return Math.min(40, 0.25 * model.L);
}

export function backgroundMask(lab: LabImage, W: number, inner: Rect, model: ColourModel, darkIsBackground: boolean | Uint8Array = false): Uint8Array {
  const n = lab.L.length;
  const out = new Uint8Array(n);
  const dark = darkLimit(model);
  const paleChroma = 0.5 * model.chroma;
  const paleL = model.L - 10;
  for (let i = 0; i < n; i++) {
    const x = i % W;
    const y = (i - x) / W;
    if (x < inner.x0 || x > inner.x1 || y < inner.y0 || y > inner.y1) {
      out[i] = 1;
      continue;
    }
    const L = lab.L[i];
    if (L < dark) {
      if (darkIsBackground === true || (darkIsBackground && darkIsBackground[i])) out[i] = 1;
    } else if (L > paleL && Math.hypot(lab.a[i], lab.b[i]) < paleChroma) out[i] = 1;
    else if (L > 2 * dark) {
      // Side faces and shadowed crust are the same brown, just darker: a and b shrink roughly in
      // proportion to L. So a darker pixel is compared on its colour scaled back up to the model's
      // brightness, and its darkness alone never makes it background.
      const darker = L < model.L;
      const g = darker ? Math.min(3, model.L / L) : 1;
      const dL = darker ? 0 : (L - model.L) / model.sL;
      const d2 = dL ** 2 + ((lab.a[i] * g - model.a) / model.sa) ** 2 + ((lab.b[i] * g - model.b) / model.sb) ** 2;
      if (d2 > 36) out[i] = 1;
    }
  }
  // Remove speckle: a background marker must be a real region, not single noisy pixels.
  return openBinary(out, W, n / W, 3);
}

function openBinary(m: Uint8Array, W: number, H: number, k: number): Uint8Array {
  const pool = new MatPool();
  try {
    const mat = pool.add(cv.matFromArray(H, W, cv.CV_8UC1, m));
    cv.morphologyEx(mat, mat, cv.MORPH_OPEN, pool.add(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(k, k))));
    return new Uint8Array(mat.data);
  } finally {
    pool.free();
  }
}

/**
 * Marker-controlled watershed: one marker per seed, plus the background marker. Exactly one region
 * per seed comes back, so the piece count always equals the seed count.
 *
 * @param elevation 8-bit RGB Mat to flood (see elevationImage)
 * @returns labels: 0 = background / boundary, k + 1 = region of seeds[k]
 */
export function seededWatershed(
  elevation: any,
  W: number,
  H: number,
  seeds: Pt[],
  background: Uint8Array,
  seedRadius = 3,
): Int32Array {
  const pool = new MatPool();
  try {
    const markers = pool.add(cv.Mat.zeros(H, W, cv.CV_32S));
    const mk = markers.data32S as Int32Array;
    for (let i = 0; i < mk.length; i++) if (background[i]) mk[i] = 1;
    // Discs never cover background or another seed's disc centre: shrink if two seeds are close.
    seeds.forEach((s, k) => {
      let r = seedRadius;
      for (const o of seeds) if (o !== s) r = Math.min(r, Math.floor(Math.hypot(o.x - s.x, o.y - s.y) / 2) - 1);
      r = Math.max(2, r);
      const cx = Math.round(s.x);
      const cy = Math.round(s.y);
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const x = cx + dx;
          const y = cy + dy;
          if (dx * dx + dy * dy > r * r || x < 0 || y < 0 || x >= W || y >= H) continue;
          const i = y * W + x;
          if (!background[i] || (dx * dx + dy * dy <= 9)) mk[i] = k + 2;
        }
      }
    });
    cv.watershed(elevation, markers);
    const labels = new Int32Array(W * H);
    for (let i = 0; i < labels.length; i++) labels[i] = mk[i] >= 2 ? mk[i] - 1 : 0;
    // Watershed lines (-1) are given to the neighbouring piece so areas aren't shaved by 1 px
    // borders. Lines against background stay background.
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        if (mk[i] !== -1) continue;
        const nb = [mk[i - 1], mk[i + 1], mk[i - W], mk[i + W]];
        if (nb.some((v) => v === 1)) continue;
        const v = nb.find((q) => q >= 2);
        if (v) labels[i] = v - 1;
      }
    }
    return labels;
  } finally {
    pool.free();
  }
}
