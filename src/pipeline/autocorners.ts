import { cv, MatPool } from './cv';
import { isConvexQuad, orderCorners } from './geometry';
import type { Pt, RGBAImage } from './types';

/**
 * Best-effort board detection: the largest convex 4-sided outline in the photo. Returns corners in
 * photo coordinates, or null. It only pre-fills the corners; the user always gets to adjust them.
 */
export function detectBoard(img: RGBAImage): Pt[] | null {
  const pool = new MatPool();
  try {
    const src = pool.add(cv.matFromImageData(img));
    const scale = 480 / Math.max(img.width, img.height);
    const small = pool.add(new cv.Mat());
    cv.resize(src, small, new cv.Size(Math.round(img.width * scale), Math.round(img.height * scale)), 0, 0, cv.INTER_AREA);
    const gray = pool.add(new cv.Mat());
    cv.cvtColor(small, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, gray, new cv.Size(7, 7), 0);
    const edges = pool.add(new cv.Mat());
    cv.Canny(gray, edges, 30, 90);
    const k = pool.add(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5)));
    cv.dilate(edges, edges, k);

    const contours = pool.add(new cv.MatVector());
    const hier = pool.add(new cv.Mat());
    cv.findContours(edges, contours, hier, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
    const imgArea = small.rows * small.cols;
    let best: Pt[] | null = null;
    let bestArea = 0.15 * imgArea;
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const hull = new cv.Mat();
      cv.convexHull(c, hull, false, true);
      const area = cv.contourArea(hull);
      if (area > bestArea && area < 0.98 * imgArea) {
        const approx = new cv.Mat();
        cv.approxPolyDP(hull, approx, 0.03 * cv.arcLength(hull, true), true);
        if (approx.rows === 4) {
          const d = approx.data32S as Int32Array;
          const q = [0, 1, 2, 3].map((j) => ({ x: d[2 * j] / scale, y: d[2 * j + 1] / scale }));
          if (isConvexQuad(orderCorners(q))) {
            best = q;
            bestArea = area;
          }
        }
        approx.delete();
      }
      hull.delete();
      c.delete();
    }
    return best ? orderCorners(best) : null;
  } finally {
    pool.free();
  }
}
