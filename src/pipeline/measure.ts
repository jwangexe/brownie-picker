import { MIN_BOX_IOU } from './cuboid';
import type { Piece, PieceFlag, RankedPiece, Ranking } from './types';

/** Below this margin between #1 and #2 the result is called a tie (measurement noise is a few %). */
export const TIE_THRESHOLD_PCT = 5;
/** Bigger than this × the median piece: probably two pieces merged. */
export const TWO_PIECES_RATIO = 1.8;
/** Smaller than this × the median piece: probably a fragment. */
export const FRAGMENT_RATIO = 0.4;
/** With more than this share of pieces size-flagged (×2 / fragment), no winner is named at all. */
export const MAX_FLAGGED_SHARE = 0.3;

export function flagFor(ratioToMedian: number, piece?: Pick<Piece, 'box'>): PieceFlag {
  if (ratioToMedian > TWO_PIECES_RATIO) return 'two';
  if (ratioToMedian < FRAGMENT_RATIO) return 'fragment';
  // Size flags first (they say what to do); then: no box fits its top face, so its size is a guess.
  if (piece?.box && piece.box.iou < MIN_BOX_IOU) return 'shape';
  return null;
}

/**
 * Ranks pieces by area (#1 = biggest) and decides what to tell the user. A flagged piece is never
 * crowned: if the biggest piece might really be two pieces the verdict is "check #N"; if too many
 * pieces look wrong there is no verdict at all.
 */
export function rankPieces(pieces: Piece[], tiePct = TIE_THRESHOLD_PCT): Ranking {
  const sorted = [...pieces].sort((a, b) => b.area - a.area);
  const n = sorted.length;
  const mean = sorted.reduce((s, p) => s + p.area, 0) / Math.max(1, n);
  // Typical piece = median, recomputed once without the obvious fragments: half-hidden pieces at
  // the back of a pile shouldn't make every whole piece look "too big".
  const med = (a: number[]) => (a.length ? (a[Math.floor((a.length - 1) / 2)] + a[Math.ceil((a.length - 1) / 2)]) / 2 : 0);
  const areasAsc = sorted.map((p) => p.area).reverse();
  const m0 = med(areasAsc);
  const kept = areasAsc.filter((a) => a >= FRAGMENT_RATIO * m0);
  const median = med(kept.length >= 3 ? kept : areasAsc);
  // Size flags need a few pieces before "the median" means anything.
  const canFlag = n >= 3;
  const ranked: RankedPiece[] = sorted.map((p, i) => {
    const ratio = median ? p.area / median : 1;
    return { ...p, rank: i + 1, pctOfMean: (p.area / mean) * 100, ratioToMedian: ratio, flag: canFlag ? flagFor(ratio, p) : null };
  });
  const flagged = ranked.filter((p) => p.flag).length;
  // Only size flags say the segmentation is wrong; "shape" just means a size is approximate.
  const wrong = ranked.filter((p) => p.flag === 'two' || p.flag === 'fragment').length;
  const base = { pieces: ranked, median, flagged };

  if (n === 0) return { ...base, status: 'empty', winner: null, runnerUp: null, marginPct: null, isTie: false };
  if (n === 1) return { ...base, status: 'one', winner: null, runnerUp: null, marginPct: null, isTie: false };
  if (wrong / n > MAX_FLAGGED_SHARE) {
    return { ...base, status: 'broken', winner: null, runnerUp: null, marginPct: null, isTie: false };
  }
  const [first, second] = ranked;
  const marginPct = (first.area / second.area - 1) * 100;
  if (first.flag) {
    return { ...base, status: 'check', check: first, winner: null, runnerUp: null, marginPct, isTie: false };
  }
  return { ...base, status: 'ok', winner: first, runnerUp: second, marginPct, isTie: marginPct < tiePct };
}
