import { cv, MatPool } from './cv';
import { orderCorners, warpSize } from './geometry';
import type { Pt, RGBAImage } from './types';

export interface WarpResult {
  warped: RGBAImage;
  /** photo -> warped */
  H: number[];
  /** warped -> photo */
  Hinv: number[];
  corners: Pt[];
}

export function warpBoard(img: RGBAImage, corners: Pt[], maxDim = 800): WarpResult {
  const c = orderCorners(corners);
  const { w, h } = warpSize(c, maxDim);
  const pool = new MatPool();
  try {
    const src = pool.add(cv.matFromArray(4, 1, cv.CV_32FC2, c.flatMap((p) => [p.x, p.y])));
    const dst = pool.add(cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, w - 1, 0, w - 1, h - 1, 0, h - 1]));
    const M = pool.add(cv.getPerspectiveTransform(src, dst));
    const Minv = pool.add(cv.getPerspectiveTransform(dst, src));
    const input = pool.add(cv.matFromImageData(img));
    const out = pool.add(new cv.Mat());
    cv.warpPerspective(input, out, M, new cv.Size(w, h), cv.INTER_LINEAR,cv.BORDER_REPLICATE);
    return {
      warped: { data: new Uint8ClampedArray(out.data), width: w, height: h },
      H: Array.from(M.data64F as Float64Array),
      Hinv: Array.from(Minv.data64F as Float64Array),
      corners: c,
    };
  } finally {
    pool.free();
  }
}
