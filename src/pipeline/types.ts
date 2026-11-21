import type { BoxFit } from './cuboid';

export interface Pt {
  x: number;
  y: number;
}

/** Same shape as the DOM ImageData, so it works in both the browser and Node tests. */
export interface RGBAImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface Piece {
  /** Label value in the label map (= seed index + 1). */
  id: number;
  /** Measured area, world units²: the fitted box's footprint, or (when no box fits) the top-face
   *  pixel area. */
  area: number;
  /** Top-face pixel area, world units² (warped px² × ay). */
  pixelArea: number;
  /** Cuboid fit (null if the piece is too small to fit). */
  box: BoxFit | null;
  /** Whole mask, top + side face. */
  maskArea: number;
  centroid: Pt;
  /** Outer contour of the whole mask, warped coordinates. */
  contour: Pt[];
  /** The seed (tap) this piece grew from, warped coordinates. */
  seed: Pt;
}

/** 'two' = > 1.8× median (might be two pieces); 'fragment' = < 0.4× median; 'shape' = no box fits
 *  its pixels (leaning, broken, or badly segmented), so its size is a guess. */
export type PieceFlag = 'two' | 'fragment' | 'shape' | null;

export interface RankedPiece extends Piece {
  /** 1 = biggest. */
  rank: number;
  /** Area as % of the mean piece area (100 = average). */
  pctOfMean: number;
  ratioToMedian: number;
  flag: PieceFlag;
}

export type RankingStatus =
  | 'empty' // no pieces
  | 'one' // a single piece: nothing to compare
  | 'broken' // > 30% of pieces flagged: no winner
  | 'check' // the biggest piece is flagged: check it first
  | 'ok';

export interface Ranking {
  pieces: RankedPiece[];
  status: RankingStatus;
  median: number;
  flagged: number;
  /** Only set when status is 'ok'. */
  winner: RankedPiece | null;
  runnerUp: RankedPiece | null;
  /** The flagged piece to check, when status is 'check'. */
  check?: RankedPiece;
  /** How much bigger #1 is than #2, in %. */
  marginPct: number | null;
  isTie: boolean;
}
