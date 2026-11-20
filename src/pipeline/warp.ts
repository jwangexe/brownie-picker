import { cv, MatPool } from './cv';
import { orderCorners, warpSize } from './geometry';
import type { Pt, RGBAImage } from './types';

/** The board quad's footprint inside the warped image: an axis-aligned rectangle (inclusive). */
export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface WarpResult {
  /** Top-down view: the board quad becomes `inner`, surrounded by a margin of off-board context. */
  warped: RGBAImage;
  inner: Rect;
  /** photo -> warped */
  H: number[];
  /** warped -> photo */
  Hinv: number[];
  corners: Pt[];
}

/**
 * Warps the board quad to a top-down rectangle. A margin of what lies just outside the quad is kept
 * around it: segmentation uses that margin as guaranteed background, so nothing outside the
 * corners can ever become a piece, and pieces stop exactly at the quad edge.
 */
export function warpBoard(img: RGBAImage, corners: Pt[], maxDim = 800, marginFrac = 0.04): WarpResult {
  const c = orderCorners(corners);
  const { w, h } = warpSize(c, maxDim);
  const m = Math.max(6, Math.round(marginFrac * Math.max(w, h)));
  const W = w + 2 * m;
  const H = h + 2 * m;
  const pool = new MatPool();
  try {
    const src = pool.add(cv.matFromArray(4, 1, cv.CV_32FC2, c.flatMap((p) => [p.x, p.y])));
    const dst = pool.add(cv.matFromArray(4, 1, cv.CV_32FC2, [m, m, m + w - 1, m, m + w - 1, m + h - 1, m, m + h - 1]));
    const M = pool.add(cv.getPerspectiveTransform(src, dst));
    const Minv = pool.add(cv.getPerspectiveTransform(dst, src));
    const input = pool.add(cv.matFromImageData(img));
    const out = pool.add(new cv.Mat());
    cv.warpPerspective(input, out, M, new cv.Size(W, H), cv.INTER_LINEAR, cv.BORDER_REPLICATE);
    return {
      warped: { data: new Uint8ClampedArray(out.data), width: W, height: H },
      inner: { x0: m, y0: m, x1: m + w - 1, y1: m + h - 1 },
      H: Array.from(M.data64F as Float64Array),
      Hinv: Array.from(Minv.data64F as Float64Array),
      corners: c,
    };
  } finally {
    pool.free();
  }
}

export const inRect = (r: Rect, x: number, y: number) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;
