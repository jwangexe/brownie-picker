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
  id, area, pixelArea: area, box: null, maskArea: area, centroid: { x: 0, y: 0 }, contour: [], seed: { x: 0, y: 0 },
});
const pieces = (...areas: number[]) => areas.map((a, i) => piece(i + 1, a));

describe('rankPieces', () => {
  it('ranks by area (#1 = biggest), reports % of mean and the margin', () => {
    const r = rankPieces(pieces(100, 150, 120));
    expect(r.status).toBe('ok');
    expect(r.winner?.id).toBe(2);
    expect(r.winner?.rank).toBe(1);
    expect(r.runnerUp?.id).toBe(3);
    expect(r.marginPct).toBeCloseTo(25);
    expect(r.isTie).toBe(false);
  });
  it('calls margins under 5% a tie', () => {
    expect(rankPieces(pieces(1000, 1040, 900)).isTie).toBe(true);
    expect(rankPieces(pieces(1000, 1060, 900)).isTie).toBe(false);
  });
  it('handles 0 and 1 pieces without naming a winner', () => {
    expect(rankPieces([]).status).toBe('empty');
    const one = rankPieces([piece(1, 10)]);
    expect(one.status).toBe('one');
    expect(one.winner).toBeNull();
  });
  it('flags > 1.8× median as "two" and < 0.4× as "fragment"', () => {
    const r = rankPieces(pieces(100, 105, 95, 110, 30, 210, 220));
    const flag = (a: number) => r.pieces.find((p) => p.area === a)!.flag;
    expect(flag(220)).toBe('two');
    expect(flag(210)).toBe('two');
    expect(flag(30)).toBe('fragment');
    expect(flag(110)).toBeNull();
  });
  it('never crowns a flagged piece: biggest flagged -> "check #1"', () => {
    const r = rankPieces(pieces(100, 105, 95, 110, 98, 102, 250));
    expect(r.status).toBe('check');
    expect(r.winner).toBeNull();
    expect(r.check?.rank).toBe(1);
    expect(r.check?.area).toBe(250);
  });
  it('more than 30% flagged -> no winner at all', () => {
    const r = rankPieces(pieces(100, 100, 100, 20, 25, 300, 100));
    expect(r.flagged).toBe(3);
    expect(r.status).toBe('broken');
    expect(r.winner).toBeNull();
  });
  it('the median ignores fragments, so half-hidden pieces do not inflate everyone else', () => {
    // 6 normal pieces + 6 slivers: plain median would be ~60 and flag every normal piece as "two".
    const r = rankPieces(pieces(100, 110, 95, 105, 98, 102, 10, 12, 8, 15, 11, 9));
    expect(r.median).toBeGreaterThan(95);
    expect(r.pieces.filter((p) => p.flag === 'two')).toHaveLength(0);
  });
});
