import { cv, MatPool } from './cv';
import type { Piece, Pt } from './types';

/**
 * Builds piece descriptors from a label map (label k = seeds[k - 1]). `top` marks the pixels that
 * count towards the measured area; the contour is of the whole mask.
 */
export function piecesFromLabels(labels: Int32Array, top: Uint8Array | null, W: number, H: number, seeds: Pt[]): Piece[] {
  type S = { n: number; nTop: number; sx: number; sy: number; x0: number; y0: number; x1: number; y1: number };
  const stats = new Map<number, S>();
  for (let y = 0, i = 0; y < H; y++) {
    for (let x = 0; x < W; x++, i++) {
      const l = labels[i];
      if (!l) continue;
      let s = stats.get(l);
      if (!s) stats.set(l, (s = { n: 0, nTop: 0, sx: 0, sy: 0, x0: x, y0: y, x1: x, y1: y }));
      s.n++;
      if (!top || top[i]) s.nTop++;
      s.sx += x;
      s.sy += y;
      if (x < s.x0) s.x0 = x;
      if (x > s.x1) s.x1 = x;
      if (y < s.y0) s.y0 = y;
      if (y > s.y1) s.y1 = y;
    }
  }

  const pieces: Piece[] = [];
  seeds.forEach((seed, k) => {
    const id = k + 1;
    const s = stats.get(id);
    if (!s) {
      // Keep the count honest even if a seed's region vanished (it can't with watershed, but be safe).
      pieces.push({ id, area: 0, pixelArea: 0, box: null, maskArea: 0, centroid: seed, contour: [], seed });
      return;
    }
    pieces.push({
      id,
      area: s.nTop,
      pixelArea: s.nTop,
      box: null,
      maskArea: s.n,
      centroid: { x: s.sx / s.n, y: s.sy / s.n },
      contour: outerContour(labels, W, id, s),
      seed,
    });
  });
  return pieces;
}

function outerContour(labels: Int32Array, W: number, id: number, s: { x0: number; y0: number; x1: number; y1: number }): Pt[] {
  const pool = new MatPool();
  try {
    const bw = s.x1 - s.x0 + 3;
    const bh = s.y1 - s.y0 + 3;
    const crop = pool.add(cv.Mat.zeros(bh, bw, cv.CV_8UC1));
    const cd = crop.data as Uint8Array;
    for (let y = s.y0; y <= s.y1; y++) {
      for (let x = s.x0; x <= s.x1; x++) {
        if (labels[y * W + x] === id) cd[(y - s.y0 + 1) * bw + (x - s.x0 + 1)] = 255;
      }
    }
    const contours = pool.add(new cv.MatVector());
    const hier = pool.add(new cv.Mat());
    cv.findContours(crop, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    let best = -1;
    let bestA = -1;
    for (let k = 0; k < contours.size(); k++) {
      const c = contours.get(k);
      const a = cv.contourArea(c);
      c.delete();
      if (a > bestA) {
        bestA = a;
        best = k;
      }
    }
    if (best < 0) return [];
    const c = pool.add(contours.get(best));
    const d = c.data32S as Int32Array;
    const out: Pt[] = [];
    for (let k = 0; k < d.length; k += 2) out.push({ x: d[k] + s.x0 - 1, y: d[k + 1] + s.y0 - 1 });
    return out;
  } finally {
    pool.free();
  }
}
