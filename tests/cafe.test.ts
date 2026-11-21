// Regression tests on real café photos: test-images/NAME.jpg + NAME.taps.json (corners and one tap
// per brownie, editable from the batch page).
//   cafe-01: two rows, one back piece leaning on the front row.
//   cafe-02: very oblique shot of thick pieces (big front faces), a stacked pile on the left.
import { readFileSync } from 'node:fs';
import jpeg from 'jpeg-js';
import { beforeAll, describe, expect, it } from 'vitest';
import { initCV } from './cvnode';
import { Board } from '../src/pipeline/board';
import { TWO_PIECES_RATIO } from '../src/pipeline/measure';
import type { Pt } from '../src/pipeline/types';

interface Fixture {
  corners: Pt[];
  taps: Pt[];
  /** Tap indices allowed to exceed 1.8× the median, each with a written reason. */
  knownOversize?: { tap: number; reason: string }[];
}

for (const name of ['cafe-01', 'cafe-02']) {
  describe(`${name} regression`, () => {
    let board: Board;
    let fx: Fixture;

    beforeAll(async () => {
      await initCV();
      fx = JSON.parse(readFileSync(`test-images/${name}.taps.json`, 'utf8'));
      const d = jpeg.decode(readFileSync(`test-images/${name}.jpg`), { useTArray: true, formatAsRGBA: true });
      const photo = { data: new Uint8ClampedArray(d.data.buffer, d.data.byteOffset, d.data.length), width: d.width, height: d.height };
      board = new Board(photo, fx.corners);
      board.setSeeds(fx.taps.map((p) => board.toWarped(p)));
    });

    it('piece count equals tap count', () => {
      expect(board.pieces).toHaveLength(fx.taps.length);
      expect(board.pieces.every((p) => p.area > 0)).toBe(true);
    });

    it('no piece lies outside the corner quad', () => {
      const { inner } = board.warp;
      let outside = 0;
      for (let y = 0; y < board.H; y++) {
        for (let x = 0; x < board.W; x++) {
          if (board.labels[y * board.W + x] && (x < inner.x0 || x > inner.x1 || y < inner.y0 || y > inner.y1)) outside++;
        }
      }
      expect(outside).toBe(0);
      // And mapped back to the photo, every contour point is inside the quad (1 px tolerance).
      const q = board.warp.corners;
      const inside = (p: Pt) =>
        q.every((a, i) => {
          const b = q[(i + 1) % 4];
          return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x) >= -1.5 * Math.hypot(b.x - a.x, b.y - a.y);
        });
      for (const p of board.pieces) for (const c of p.contour) expect(inside(board.toPhoto(c))).toBe(true);
    });

    it('no piece exceeds 1.8× the median (except documented known cases)', () => {
      const allowed = new Set((fx.knownOversize ?? []).map((k) => k.tap + 1));
      const over = board.ranking.pieces.filter((p) => p.ratioToMedian > TWO_PIECES_RATIO && !allowed.has(p.id));
      expect(over.map((p) => `tap ${p.id - 1}: ${p.ratioToMedian.toFixed(2)}×`)).toEqual([]);
    });

    it('never crowns a flagged piece', () => {
      const r = board.ranking;
      if (r.winner) expect(r.winner.flag).toBeNull();
      for (const p of r.pieces) if (p.flag) expect(p).not.toBe(r.winner);
    });

    it('fits a box to most pieces and finds their front faces', () => {
      const good = board.pieces.filter((p) => p.box && p.box.iou >= 0.6);
      expect(good.length).toBeGreaterThanOrEqual(0.7 * board.pieces.length);
      // Shot from the front: the boxes have visible front faces of a real height.
      expect(board.boxes!.lift.height).toBeGreaterThan(0.15 * board.pieceWidth());
      expect(good.filter((p) => p.box!.faces.some((f) => f.kind === 'front')).length).toBeGreaterThanOrEqual(0.7 * good.length);
    });
  });
}
