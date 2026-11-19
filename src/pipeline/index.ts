import { autoSegment, DEFAULT_PARAMS, type SegParams, type SegResult } from './segment';
import { flagGlare, piecesFromLabels } from './pieces';
import { rankPieces } from './measure';
import { warpBoard, type WarpResult } from './warp';
import type { Piece, Pt, Ranking, RGBAImage } from './types';

export * from './types';
export { setCV } from './cv';
export { DEFAULT_PARAMS, type SegParams } from './segment';

export interface PipelineResult {
  warp: WarpResult;
  seg: SegResult;
  pieces: Piece[];
  ranking: Ranking;
  ms: number;
}

/** Full automatic pipeline: warp -> segment -> measure -> rank. */
export function runPipeline(photo: RGBAImage, corners: Pt[], params: SegParams = DEFAULT_PARAMS, maxDim = 800): PipelineResult {
  const t0 = performance.now();
  const warp = warpBoard(photo, corners, maxDim);
  const seg = autoSegment(warp.warped, params);
  const pieces = flagGlare(piecesFromLabels(seg.labels, warp.warped.width, warp.warped.height), seg.labels, seg.debug.glare);
  const ranking = rankPieces(pieces);
  return { warp, seg, pieces, ranking, ms: performance.now() - t0 };
}
