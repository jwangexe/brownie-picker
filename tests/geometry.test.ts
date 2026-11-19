import { describe, expect, it } from 'vitest';
import { applyH, obliqueness, orderCorners, polygonArea } from '../src/pipeline/geometry';
import { rankPieces } from '../src/pipeline/measure';
import type { Piece } from '../src/pipeline/types';

describe('orderCorners', () => {
  const tl = { x: 10, y: 12 }, tr = { x: 300, y: 30 }, br = { x: 320, y: 250 }, bl = { x: 0, y: 220 };
  it('returns TL, TR, BR, BL regardless of tap order', () => {
    for (const perm of [[tl, tr, br, bl], [br, tl, bl, tr], [bl, br, tr, tl], [tr, bl, tl, br]]) {
      expect(orderCorners(perm)).toEqual([tl, tr, br, bl]);
    }
  });
});

describe('geometry helpers', () => {
  it('polygonArea of a 10x20 rectangle', () => {
    expect(polygonArea([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 20 }, { x: 0, y: 20 }])).toBe(200);
  });
  it('identity homography', () => {
    expect(applyH([1, 0, 0, 0, 1, 0, 0, 0, 1], { x: 3, y: 4 })).toEqual({ x: 3, y: 4 });
  });
  it('obliqueness is 1 for a rectangle and grows for a trapezoid', () => {
    const rect = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 }];
    expect(obliqueness(rect)).toBeCloseTo(1);
    const trap = [{ x: 25, y: 0 }, { x: 75, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 }];
    expect(obliqueness(trap)).toBeCloseTo(2);
  });
});

const piece = (id: number, area: number): Piece => ({
  id, area, centroid: { x: 0, y: 0 }, contour: [], solidity: 1, touchesEdge: false,
});

describe('rankPieces', () => {
  it('ranks by area, reports % of mean and the margin', () => {
    const r = rankPieces([piece(1, 100), piece(2, 150), piece(3, 50)]);
    expect(r.winner?.id).toBe(2);
    expect(r.runnerUp?.id).toBe(1);
    expect(r.marginPct).toBeCloseTo(50);
    expect(r.isTie).toBe(false);
    expect(r.pieces.map((p) => Math.round(p.pctOfMean))).toEqual([150, 100, 50]);
  });
  it('calls margins under 5% a tie', () => {
    expect(rankPieces([piece(1, 1000), piece(2, 1040)]).isTie).toBe(true);
    expect(rankPieces([piece(1, 1000), piece(2, 1060)]).isTie).toBe(false);
  });
  it('handles 0 and 1 pieces', () => {
    expect(rankPieces([]).winner).toBeNull();
    const one = rankPieces([piece(1, 10)]);
    expect(one.winner?.id).toBe(1);
    expect(one.marginPct).toBeNull();
  });
});
