import type { Piece, Ranking } from './types';

/** Below this margin between #1 and #2 the result is called a tie (measurement noise is a few %). */
export const TIE_THRESHOLD_PCT = 5;

export function rankPieces(pieces: Piece[], tiePct = TIE_THRESHOLD_PCT): Ranking {
  const sorted = [...pieces].sort((a, b) => b.area - a.area);
  const mean = sorted.reduce((s, p) => s + p.area, 0) / Math.max(1, sorted.length);
  const ranked = sorted.map((p, i) => ({ ...p, rank: i + 1, pctOfMean: (p.area / mean) * 100 }));
  const winner = ranked[0] ?? null;
  const runnerUp = ranked[1] ?? null;
  const marginPct = winner && runnerUp ? (winner.area / runnerUp.area - 1) * 100 : null;
  return { pieces: ranked, winner, runnerUp, marginPct, isTie: marginPct != null && marginPct < tiePct };
}
