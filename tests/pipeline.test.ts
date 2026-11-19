import { beforeAll, describe, expect, it } from 'vitest';
import { initCV } from './cvnode';
import { runPipeline } from '../src/pipeline';
import { DEFAULT_PARAMS } from '../src/pipeline/segment';
import { piecesFromLabels } from '../src/pipeline/pieces';
import { labImage, tapSelect } from '../src/pipeline/tapselect';
import { warpBoard } from '../src/pipeline/warp';
import { evaluate, makeScene, type SynthOptions } from '../src/synth/synth';

beforeAll(async () => {
  await initCV();
});

function check(opts: SynthOptions) {
  const scene = makeScene(opts);
  const res = runPipeline(scene.photo, scene.corners, DEFAULT_PARAMS);
  const ev = evaluate(scene, res.pieces, res.warp.warped.width, res.warp.warped.height);
  return { scene, res, ev };
}

const summary = (ev: ReturnType<typeof evaluate>) =>
  `missed=${ev.missed.length} spurious=${ev.spurious} dup=${ev.duplicates} ` +
  `median=${(ev.medianErr * 100).toFixed(2)}% max=${(ev.maxErr * 100).toFixed(2)}%`;

describe('automatic pipeline on separated pieces', () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const tilt = [0, 0.3, 0.5, 0.7, 0.4, 0.6][seed - 1];
    it(`seed ${seed}, tilt ${tilt}: finds all 12, correct winner, small area error`, () => {
      const { scene, ev } = check({ seed, tilt, winnerMargin: 0.1 });
      const msg = summary(ev);
      expect(ev.missed, msg).toHaveLength(0);
      expect(ev.spurious, msg).toBe(0);
      expect(ev.duplicates, msg).toBe(0);
      expect(ev.predictedBiggest, msg).toBe(scene.biggest);
      expect(ev.medianErr, msg).toBeLessThan(0.03);
      expect(ev.maxErr, msg).toBeLessThan(0.06);
    });
  }
});

describe('hard cases', () => {
  it('glare: ranking survives, and any piece glare hurts is flagged', () => {
    for (const seed of [11, 12, 13, 14, 15]) {
      const { scene, res, ev } = check({ seed, tilt: 0.4, glare: true, winnerMargin: 0.1 });
      const msg = `seed ${seed}: ${summary(ev)}`;
      expect(ev.missed, msg).toHaveLength(0);
      expect(ev.predictedBiggest, msg).toBe(scene.biggest);
      // Glare on a corner can't be fully recovered; the requirement is that it is never silent.
      for (const p of res.pieces) {
        if ((ev.errById.get(p.id) ?? 0) > 0.05) expect(p.nearGlare, `${msg} piece ${p.id}`).toBe(true);
      }
    }
  });

  it('touching pieces separated only by a thin crease are split', () => {
    for (const seed of [21, 22, 23]) {
      const { scene, ev } = check({ seed, tilt: 0.3, touching: true });
      const msg = `seed ${seed}: ${summary(ev)}`;
      expect(ev.missed, msg).toHaveLength(0);
      expect(ev.duplicates, msg).toBe(0);
      expect(ev.medianErr, msg).toBeLessThan(0.05);
      const areas = scene.gtAreas.slice(1).sort((a, b) => b - a);
      if (areas[0] / areas[1] > 1.05) expect(ev.predictedBiggest, msg).toBe(scene.biggest);
    }
  });

  it('a 2% difference is reported as a tie', () => {
    for (const seed of [31, 32]) {
      const { res } = check({ seed, tilt: 0.3, winnerMargin: 0.02 });
      expect(res.ranking.isTie, `margin ${res.ranking.marginPct?.toFixed(2)}%`).toBe(true);
    }
  });
});

describe('tap-to-select', () => {
  it('segments each piece from a tap at its centre', () => {
    const scene = makeScene({ seed: 41, tilt: 0.4, winnerMargin: 0.1 });
    const warp = warpBoard(scene.photo, scene.corners);
    const { width: W, height: H } = warp.warped;
    const lab = labImage(warp.warped);
    const labels = new Int32Array(W * H);
    // Tap the centre of every ground-truth piece (mapped from board to warped coordinates).
    for (let k = 1; k < scene.gtAreas.length; k++) {
      let sx = 0, sy = 0, n = 0;
      for (let i = 0; i < scene.gtLabels.length; i++) {
        if (scene.gtLabels[i] === k) {
          sx += i % scene.boardW;
          sy += Math.floor(i / scene.boardW);
          n++;
        }
      }
      const seed = { x: (sx / n / (scene.boardW - 1)) * (W - 1), y: (sy / n / (scene.boardH - 1)) * (H - 1) };
      const mask = tapSelect(warp.warped, lab, labels, seed);
      expect(mask, `piece ${k}`).not.toBeNull();
      for (let i = 0; i < mask!.length; i++) if (mask![i]) labels[i] = k;
    }
    const pieces = piecesFromLabels(labels, W, H);
    const ev = evaluate(scene, pieces, W, H);
    const msg = summary(ev);
    expect(ev.missed, msg).toHaveLength(0);
    expect(ev.predictedBiggest, msg).toBe(scene.biggest);
    expect(ev.medianErr, msg).toBeLessThan(0.04);
    expect(ev.maxErr, msg).toBeLessThan(0.08);
  });

  it('refuses a tap on already-selected pixels', () => {
    const scene = makeScene({ seed: 42 });
    const warp = warpBoard(scene.photo, scene.corners);
    const labels = new Int32Array(warp.warped.width * warp.warped.height).fill(1);
    expect(tapSelect(warp.warped, labImage(warp.warped), labels, { x: 50, y: 50 })).toBeNull();
  });
});

describe('performance', () => {
  it('runs the automatic pipeline well under a second in Node', () => {
    const scene = makeScene({ seed: 7 });
    runPipeline(scene.photo, scene.corners); // warm-up
    const { ms } = runPipeline(scene.photo, scene.corners);
    expect(ms).toBeLessThan(1000);
  });
});
