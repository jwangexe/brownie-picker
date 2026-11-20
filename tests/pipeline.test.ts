import { beforeAll, describe, expect, it } from 'vitest';
import { initCV } from './cvnode';
import { Board } from '../src/pipeline/board';
import { evaluate, makeScene, type SynthOptions } from '../src/synth/synth';

beforeAll(async () => {
  await initCV();
});

/** Tap-seeded run: one tap per ground-truth piece, at its centroid (what a user would do). */
function tapped(opts: SynthOptions) {
  const scene = makeScene(opts);
  const board = new Board(scene.photo, scene.corners);
  board.setSeeds(scene.taps.map((p) => board.toWarped(p)));
  const ev = evaluate(scene, board.pieces, board.warp.inner);
  return { scene, board, ev };
}

const summary = (ev: ReturnType<typeof evaluate>) =>
  `missed=${ev.missed.length} spurious=${ev.spurious} dup=${ev.duplicates} ` +
  `median=${(ev.medianErr * 100).toFixed(2)}% max=${(ev.maxErr * 100).toFixed(2)}%`;

function expectGood(scene: ReturnType<typeof makeScene>, board: Board, ev: ReturnType<typeof evaluate>, maxErr = 0.05) {
  const msg = summary(ev);
  expect(board.pieces.length, msg).toBe(board.seeds.length);
  expect(board.pieces.length, msg).toBe(scene.gtAreas.length - 1);
  expect(ev.missed, msg).toHaveLength(0);
  expect(ev.duplicates, msg).toBe(0);
  expect(ev.maxErr, msg).toBeLessThan(maxErr);
}

describe('tap-seeded watershed', () => {
  for (const [seed, tilt] of [[1, 0], [2, 0.3], [3, 0.5], [4, 0.7], [5, 0.4], [6, 0.6]] as const) {
    it(`separated pieces, seed ${seed}, tilt ${tilt}: one piece per tap, areas within 5%, right winner`, () => {
      const { scene, board, ev } = tapped({ seed, tilt, winnerMargin: 0.1 });
      expectGood(scene, board, ev);
      expect(ev.predictedBiggest, summary(ev)).toBe(scene.biggest);
      expect(board.ranking.status).toBe('ok');
    });
  }

  it('touching pieces separated only by thin dark gaps', () => {
    for (const seed of [21, 22, 23]) {
      const { scene, board, ev } = tapped({ seed, tilt: 0.3, touching: true });
      expectGood(scene, board, ev);
    }
  });

  it('crack texture on top does not move boundaries (areas within 5%)', () => {
    for (const seed of [51, 52, 53]) {
      const { scene, board, ev } = tapped({ seed, tilt: 0.4, touching: true, cracks: true });
      expectGood(scene, board, ev);
    }
    for (const seed of [54, 55]) {
      const { scene, board, ev } = tapped({ seed, tilt: 0.4, cracks: true, winnerMargin: 0.1 });
      expectGood(scene, board, ev);
    }
  });

  it('shallow camera angle (far edge ~2.3× shorter): areas still within 5%', () => {
    for (const seed of [61, 62]) {
      const { scene, board, ev } = tapped({ seed, tilt: 1.5, winnerMargin: 0.1 });
      expect(board.foreshortening).toBeGreaterThan(2);
      expect(board.tooShallow).toBe(false);
      expectGood(scene, board, ev);
    }
  });

  it('flags a quad whose near edge is > 2.5× the far edge as too shallow', () => {
    const { board } = tapped({ seed: 63, tilt: 1.9 });
    expect(board.foreshortening).toBeGreaterThan(2.5);
    expect(board.tooShallow).toBe(true);
  });

  it('visible side faces are excluded: only top faces are measured', () => {
    for (const seed of [71, 72]) {
      const { scene, board, ev } = tapped({ seed, tilt: 0.5, sideFace: 14, winnerMargin: 0.1 });
      expectGood(scene, board, ev);
      // The masks do include the side faces; the measured area doesn't.
      const side = board.pieces.reduce((s, p) => s + p.maskArea - p.area, 0);
      expect(side).toBeGreaterThan(0);
    }
  });
});

describe('tapping', () => {
  it('add / remove / outside, and piece count always equals tap count', () => {
    const scene = makeScene({ seed: 81, tilt: 0.3 });
    const board = new Board(scene.photo, scene.corners);
    const [a, b, c] = scene.taps;
    expect(board.tapAt(a)).toBe('added');
    expect(board.tapAt(b)).toBe('added');
    expect(board.tapAt(c)).toBe('added');
    expect(board.pieces).toHaveLength(3);
    expect(board.tapAt({ x: b.x + 2, y: b.y - 2 })).toBe('removed');
    expect(board.pieces).toHaveLength(2);
    expect(board.tapAt({ x: 3, y: 3 })).toBe('outside');
    expect(board.pieces).toHaveLength(2);
    board.undo(); // undoes the removal
    expect(board.pieces).toHaveLength(3);
  });

  it('two taps on one piece split it into two (that is how a merged piece is fixed)', () => {
    const scene = makeScene({ seed: 82, tilt: 0.3 });
    const board = new Board(scene.photo, scene.corners);
    const w = board.toWarped(scene.taps[0]);
    const r = 0.45 * board.pieceWidth();
    board.setSeeds([{ x: w.x - r, y: w.y }, { x: w.x + r, y: w.y }]);
    expect(board.pieces).toHaveLength(2);
    expect(board.pieces.every((p) => p.area > 0)).toBe(true);
  });
});

describe('suggest seeds', () => {
  it('after one tap, proposes one seed per remaining piece and adds nothing until accepted', () => {
    for (const opts of [
      { seed: 91, tilt: 0.4, winnerMargin: 0.1 },
      { seed: 92, tilt: 0.3, touching: true },
      { seed: 93, tilt: 0.4, touching: true, cracks: true }, // cracks must not cause splits
      { seed: 94, tilt: 0.4, cracks: true, winnerMargin: 0.1 },
    ] satisfies SynthOptions[]) {
      const scene = makeScene(opts);
      const board = new Board(scene.photo, scene.corners);
      board.tapAt(scene.taps[0]); // one tap teaches it what a brownie looks like
      const n = board.suggest();
      expect(board.pieces, JSON.stringify(opts)).toHaveLength(1);
      expect(n, JSON.stringify(opts)).toBe(scene.gtAreas.length - 2);
      board.acceptAll();
      const ev = evaluate(scene, board.pieces, board.warp.inner);
      expect(ev.missed, `${JSON.stringify(opts)} ${summary(ev)}`).toHaveLength(0);
      expect(ev.duplicates).toBe(0);
    }
  });
});

describe('performance', () => {
  it('re-segments after a tap well under a second', () => {
    const { board } = tapped({ seed: 7 });
    board.recompute();
    expect(board.lastMs).toBeLessThan(1000);
  });
});
