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
  /** Label value in the label map. */
  id: number;
  /** Pixel count in the warped (top-down) view. */
  area: number;
  centroid: Pt;
  /** Outer contour in warped coordinates. */
  contour: Pt[];
  /** area / convex hull area. Low values hint at two pieces merged into one. */
  solidity: number;
  /** Touches the warped image border: the piece may be cut off by a corner placed too tight. */
  touchesEdge: boolean;
  /** Overlaps a detected glare highlight: its area may be underestimated. */
  nearGlare?: boolean;
}

export interface RankedPiece extends Piece {
  rank: number;
  /** Area as % of the mean piece area (100 = average). */
  pctOfMean: number;
}

export interface Ranking {
  pieces: RankedPiece[];
  winner: RankedPiece | null;
  runnerUp: RankedPiece | null;
  /** How much bigger the winner is than the runner-up, in %. */
  marginPct: number | null;
  isTie: boolean;
}
