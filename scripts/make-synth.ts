// Writes a few synthetic scenes (PNG + corners/taps fixture + ground truth) to test-images/synthetic/,
// so the batch page and the app's upload button have something to chew on.
// Run: npm run synth
import { mkdirSync, writeFileSync } from 'node:fs';
import { initCV } from '../tests/cvnode';
import { makeScene, type SynthOptions } from '../src/synth/synth';
import { encodePNG } from './png';

await initCV();
const dir = 'test-images/synthetic';
mkdirSync(dir, { recursive: true });

const cases: [string, SynthOptions][] = [
  ['synth-straight', { seed: 1, tilt: 0, winnerMargin: 0.12 }],
  ['synth-tilted', { seed: 4, tilt: 0.7, winnerMargin: 0.1 }],
  ['synth-glare', { seed: 13, tilt: 0.4, glare: true, winnerMargin: 0.1 }],
  ['synth-touching', { seed: 22, tilt: 0.3, touching: true }],
  ['synth-cracks', { seed: 52, tilt: 0.4, touching: true, cracks: true }],
  ['synth-side-faces', { seed: 72, tilt: 0.5, sideFace: 14, winnerMargin: 0.1 }],
  ['synth-shallow', { seed: 61, tilt: 1.5, winnerMargin: 0.1 }],
  ['synth-near-tie', { seed: 31, tilt: 0.3, winnerMargin: 0.02 }],
];

for (const [name, opt] of cases) {
  const s = makeScene(opt);
  writeFileSync(`${dir}/${name}.png`, encodePNG(s.photo));
  const r = (p: { x: number; y: number }) => ({ x: Math.round(p.x), y: Math.round(p.y) });
  writeFileSync(`${dir}/${name}.taps.json`, JSON.stringify({ image: `${name}.png`, corners: s.corners.map(r), taps: s.taps.map(r) }, null, 2) + '\n');
  const total = s.gtAreas.slice(1).reduce((a, b) => a + b, 0);
  const shares = s.gtAreas.slice(1).map((a) => +((a / total) * 100).toFixed(2));
  writeFileSync(`${dir}/${name}.truth.json`, JSON.stringify({ options: opt, biggest: s.biggest, sharesPct: shares }, null, 2) + '\n');
  console.log(`wrote ${dir}/${name}.png`);
}
