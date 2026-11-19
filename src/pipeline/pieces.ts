import { cv, MatPool } from './cv';
import type { Piece, Pt } from './types';

/** Builds piece descriptors (area, centroid, contour, quality flags) from a label map. */
export function piecesFromLabels(labels: Int32Array, W: number, H: number): Piece[] {
  const stats = new Map<number, { n: number; sx: number; sy: number; x0: number; y0: number; x1: number; y1: number }>();
  for (let y = 0, i = 0; y < H; y++) {
    for (let x = 0; x < W; x++, i++) {
      const l = labels[i];
      if (!l) continue;
      let s = stats.get(l);
      if (!s) stats.set(l, (s = { n: 0, sx: 0, sy: 0, x0: x, y0: y, x1: x, y1: y }));
      s.n++;
      s.sx += x;
      s.sy += y;
      if (x < s.x0) s.x0 = x;
      if (x > s.x1) s.x1 = x;
      if (y < s.y0) s.y0 = y;
      if (y > s.y1) s.y1 = y;
    }
  }

  const pieces: Piece[] = [];
  for (const [id, s] of stats) {
    const pool = new MatPool();
    try {
      // Contour from a padded crop of just this label.
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
        const a = cv.contourArea(contours.get(k));
        if (a > bestA) {
          bestA = a;
          best = k;
        }
      }
      if (best < 0) continue;
      const c = contours.get(best);
      const hull = pool.add(new cv.Mat());
      cv.convexHull(c, hull, false, true);
      const hullA = cv.contourArea(hull);
      const cd32 = c.data32S as Int32Array;
      const contour: Pt[] = [];
      for (let k = 0; k < cd32.length; k += 2) contour.push({ x: cd32[k] + s.x0 - 1, y: cd32[k + 1] + s.y0 - 1 });
      c.delete();
      pieces.push({
        id,
        area: s.n,
        centroid: { x: s.sx / s.n, y: s.sy / s.n },
        contour,
        solidity: hullA > 0 ? Math.min(1, bestA / hullA) : 1,
        touchesEdge: s.x0 <= 1 || s.y0 <= 1 || s.x1 >= W - 2 || s.y1 >= H - 2,
      });
    } finally {
      pool.free();
    }
  }
  return pieces;
}

/** Marks pieces that overlap the glare-halo mask from segmentation (0/255 per pixel). */
export function flagGlare(pieces: Piece[], labels: Int32Array, glare: Uint8Array | undefined): Piece[] {
  if (!glare) return pieces;
  const hits = new Map<number, number>();
  for (let i = 0; i < labels.length; i++) if (labels[i] && glare[i]) hits.set(labels[i], (hits.get(labels[i]) ?? 0) + 1);
  return pieces.map((p) => ({ ...p, nearGlare: (hits.get(p.id) ?? 0) > 0.01 * p.area }));
}
