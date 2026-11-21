// Renders the debug view for a real test photo to a PNG, using its saved corners + taps fixture.
// Run: npm run debug -- cafe-01        (writes test-images/out/cafe-01.debug.png)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import jpeg from 'jpeg-js';
import { initCV } from '../tests/cvnode';
import { cv, MatPool } from '../src/pipeline/cv';
import { Board } from '../src/pipeline/board';
import type { Pt, RGBAImage } from '../src/pipeline/types';
import { encodePNG } from './png';

const name = process.argv[2] ?? 'cafe-01';
const tag = process.argv[3] ?? '';
await initCV();

export function loadJpeg(path: string): RGBAImage {
  const d = jpeg.decode(readFileSync(path), { useTArray: true, formatAsRGBA: true });
  return { data: new Uint8ClampedArray(d.data.buffer, d.data.byteOffset, d.data.length), width: d.width, height: d.height };
}

const fx = JSON.parse(readFileSync(`test-images/${name}.taps.json`, 'utf8')) as { corners: Pt[]; taps: Pt[] };
const photo = loadJpeg(`test-images/${name}.jpg`);
const t0 = performance.now();
const board = new Board(photo, fx.corners);
board.setSeeds(fx.taps.map((p) => board.toWarped(p)));
const tSeg = performance.now() - t0;
board.suggest();
const r = board.ranking;
console.log(`${name}: ${board.seeds.length} taps -> ${r.pieces.length} pieces in ${tSeg.toFixed(0)} ms; status=${r.status}`);
for (const p of r.pieces) {
  console.log(`  #${p.rank} id${p.id} top=${p.area} mask=${p.maskArea} (${Math.round((100 * p.area) / Math.max(1, p.maskArea))}% top) ×median=${p.ratioToMedian.toFixed(2)} ${p.flag ?? ''}`);
}
const cam = board.camera;
console.log(`  camera: C=(${cam.C.map((v) => v.toFixed(0)).join(', ')}) ay=${cam.ay.toFixed(3)} orthoErr=${cam.orthoErr.toFixed(3)} fallback=${cam.fallback}`);
const L = board.boxes?.lift;
if (L) console.log(`  lift: F=(${L.F.x.toFixed(0)}, ${L.F.y.toFixed(0)}) c=${L.c.toFixed(3)} height=${L.height.toFixed(1)}; inner=${JSON.stringify(board.warp.inner)} pw=${board.pieceWidth().toFixed(0)}`);
for (const p of r.pieces) {
  const b = p.box;
  console.log(`  #${p.rank} id${p.id} area=${p.area.toFixed(0)} px=${p.pixelArea.toFixed(0)} box=${b ? `${b.w.toFixed(0)}x${b.d.toFixed(0)} iou=${b.iou.toFixed(2)} front=${b.front?.toFixed(0) ?? '-'}` : '-'}`);
}
console.log(`  suggest: ${board.suggestion!.seeds.length} proposals; gap segments kept ${board.gapMap().segments.length}; pieceWidth ${board.pieceWidth().toFixed(0)}`);

// ---------------------------------------------------------------- drawing helpers
const pool = new MatPool();
const W = board.W;
const H = board.H;
const hue = (l: number): [number, number, number] => {
  const h = ((l * 137.5) % 360) / 60;
  const c = 200;
  const x = c * (1 - Math.abs((h % 2) - 1));
  const [r0, g0, b0] = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
  return [r0 + 40, g0 + 40, b0 + 40];
};
const fromRGBA = (d: ArrayLike<number>, w: number, h: number) => pool.add(cv.matFromArray(h, w, cv.CV_8UC4, Array.from(d)));
const gray = (g: Uint8Array) => {
  const d = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = g[i];
    d[i * 4 + 3] = 255;
  }
  return fromRGBA(d, W, H);
};
const tint = (labels: Int32Array, base: RGBAImage, a = 0.6) => {
  const d = new Uint8ClampedArray(base.data);
  for (let i = 0; i < W * H; i++) {
    if (!labels[i]) continue;
    const [r0, g0, b0] = hue(labels[i]);
    d[i * 4] = d[i * 4] * (1 - a) + r0 * a;
    d[i * 4 + 1] = d[i * 4 + 1] * (1 - a) + g0 * a;
    d[i * 4 + 2] = d[i * 4 + 2] * (1 - a) + b0 * a;
  }
  return fromRGBA(d, W, H);
};
const text = (m: any, s: string, x: number, y: number, scale = 0.6, col = [255, 255, 255, 255]) => {
  cv.putText(m, s, new cv.Point(x + 1, y + 1), cv.FONT_HERSHEY_SIMPLEX, scale, new cv.Scalar(0, 0, 0, 255), 3);
  cv.putText(m, s, new cv.Point(x, y), cv.FONT_HERSHEY_SIMPLEX, scale, new cv.Scalar(...col), 1);
};
const dot = (m: any, p: Pt, r: number, col: number[], fill = true) =>
  cv.circle(m, new cv.Point(Math.round(p.x), Math.round(p.y)), r, new cv.Scalar(...col), fill ? -1 : 2);
const fit = (m: any, w: number) => {
  const out = pool.add(new cv.Mat());
  cv.resize(m, out, new cv.Size(w, Math.round((m.rows * w) / m.cols)), 0, 0, cv.INTER_AREA);
  return out;
};
const caption = (m: any, s: string) => {
  text(m, s, 8, 22, 0.6, [255, 220, 120, 255]);
  return m;
};

// ---------------------------------------------------------------- panel A: result on the photo
const PW = photo.width;
const PH = photo.height;
const ov = new Uint8ClampedArray(W * H * 4);
for (let i = 0; i < W * H; i++) {
  if (!board.labels[i]) continue;
  const isTop = board.top[i];
  ov[i * 4] = isTop ? 60 : 255;
  ov[i * 4 + 1] = isTop ? 220 : 60;
  ov[i * 4 + 2] = isTop ? 255 : 60;
  ov[i * 4 + 3] = isTop ? 90 : 140;
}
const ovPhoto = pool.add(new cv.Mat());
const Hinv = pool.add(cv.matFromArray(3, 3, cv.CV_64F, board.warp.Hinv));
cv.warpPerspective(fromRGBA(ov, W, H), ovPhoto, Hinv, new cv.Size(PW, PH), cv.INTER_NEAREST, cv.BORDER_CONSTANT, new cv.Scalar(0, 0, 0, 0));
const res = new Uint8ClampedArray(photo.data);
const od = ovPhoto.data as Uint8Array;
for (let i = 0; i < PW * PH; i++) {
  const a = od[i * 4 + 3] / 255;
  for (let c = 0; c < 3; c++) res[i * 4 + c] = res[i * 4 + c] * (1 - a) + od[i * 4 + c] * a;
}
const A = fromRGBA(res, PW, PH);
const quad = board.warp.corners;
for (let k = 0; k < 4; k++) {
  const p = quad[k];
  const q = quad[(k + 1) % 4];
  cv.line(A, new cv.Point(Math.round(p.x), Math.round(p.y)), new cv.Point(Math.round(q.x), Math.round(q.y)), new cv.Scalar(80, 255, 80, 255), 2);
}
for (const p of r.pieces) {
  const c = p.contour.map((q) => board.toPhoto(q));
  for (let k = 0; k < c.length; k++) {
    const a = c[k];
    const b = c[(k + 1) % c.length];
    const col = p === r.winner ? [255, 200, 61, 255] : p.flag ? [255, 90, 90, 255] : [255, 255, 255, 255];
    cv.line(A, new cv.Point(Math.round(a.x), Math.round(a.y)), new cv.Point(Math.round(b.x), Math.round(b.y)), new cv.Scalar(...col), p === r.winner ? 3 : 1);
  }
  const s = board.toPhoto(p.seed);
  dot(A, s, 5, [255, 0, 255, 255]);
  const lbl = `#${p.rank} ${Math.round(p.pctOfMean)}%${p.flag ? (p.flag === 'two' ? ' x2?' : p.flag === 'shape' ? ' shape?' : ' frag') : ''}`;
  text(A, lbl, Math.round(s.x) - 30, Math.round(s.y) - 10, 0.5, p.flag ? [255, 130, 130, 255] : [255, 255, 255, 255]);
}
const head =
  r.status === 'ok'
    ? r.isTie
      ? `TIE: #1 vs #2 ${r.marginPct!.toFixed(1)}%`
      : `#1 is ~${Math.round(r.marginPct!)}% bigger than #2`
    : r.status === 'check'
      ? `Check #${r.check!.rank} - might be two pieces`
      : r.status === 'broken'
        ? `No winner: ${r.flagged}/${r.pieces.length} flagged`
        : r.status;
caption(A, `${name}${tag ? ' ' + tag : ''}: ${board.seeds.length} taps = ${r.pieces.length} pieces | ${head} | cyan=top face, red=side face`);

// ---------------------------------------------------------------- panel A2: cuboid faces on the photo
const FACE_COL: Record<string, number[]> = { top: [255, 200, 60, 255], front: [60, 140, 255, 255], side: [190, 80, 255, 255] };
const boxLayer = pool.add(cv.Mat.zeros(PH, PW, cv.CV_8UC4));
const ranked = [...r.pieces].filter((p) => p.box).sort((a, b) => a.box!.footprint[0].y - b.box!.footprint[0].y);
const poly = (m: any, pts: Pt[], col: number[], fill: boolean, th = 1) => {
  const mv = pool.add(new cv.MatVector());
  const mat = cv.matFromArray(pts.length, 1, cv.CV_32SC2, pts.flatMap((q) => [Math.round(q.x), Math.round(q.y)]));
  mv.push_back(mat);
  mat.delete();
  if (fill) cv.fillPoly(m, mv, new cv.Scalar(...col));
  else cv.polylines(m, mv, true, new cv.Scalar(...col), th);
};
for (const p of ranked) {
  for (const f of [...p.box!.faces].reverse()) poly(boxLayer, f.poly.map((q) => board.toPhoto(q)), FACE_COL[f.kind], true);
}
const A2d = new Uint8ClampedArray(photo.data);
const bl = boxLayer.data as Uint8Array;
for (let i = 0; i < PW * PH; i++) {
  if (!bl[i * 4 + 3]) continue;
  for (let c = 0; c < 3; c++) A2d[i * 4 + c] = A2d[i * 4 + c] * 0.55 + bl[i * 4 + c] * 0.45;
}
const A2 = fromRGBA(A2d, PW, PH);
for (const p of ranked) {
  for (const f of p.box!.faces) poly(A2, f.poly.map((q) => board.toPhoto(q)), [255, 255, 255, 255], false, 1);
  const c = p.contour.map((q) => board.toPhoto(q));
  if (c.length > 2) poly(A2, c, [255, 60, 60, 255], false, 1);
  const sd = board.toPhoto(p.seed);
  text(A2, `#${p.rank} ${p.box!.iou.toFixed(2)}`, Math.round(sd.x) - 25, Math.round(sd.y), 0.45, p.box!.iou < 0.6 ? [255, 120, 120, 255] : [255, 255, 255, 255]);
}
caption(A2, `cuboids: yellow=top, blue=front, purple=side; red=watershed mask; label = rank, silhouette IoU | front height ${board.boxes?.lift.height.toFixed(0)}`);

// ---------------------------------------------------------------- warped panels
const gm = board.gapMap();
const B = caption(tint(board.labels, board.warp.warped), 'pieces (warped, margin = background)');
const C = caption(gray(gm.raw), 'gap map BEFORE filtering (black-hat + adaptive)');
const D = caption(gray(gm.gap), `gap map AFTER: ${gm.segments.length} straight cut segments kept`);
const topVis = new Uint8Array(W * H);
for (let i = 0; i < W * H; i++) topVis[i] = board.labels[i] ? (board.top[i] ? 255 : 90) : 0;
const E = caption(gray(topVis), 'measured top face (white) vs side face (grey)');
const bgVis = new Uint8Array(W * H);
for (let i = 0; i < W * H; i++) bgVis[i] = board.background?.[i] ? 255 : 0;
const F = caption(gray(bgVis), 'background marker (outside quad + very dark + pale)');
const G = tint(board.suggestion!.fragments, board.warp.warped, 0.55);
caption(G, `suggest: ${new Set(board.suggestion!.fragments).size - 1} fragments before merge`);
const Hm = tint(board.suggestion!.merged, board.warp.warped, 0.55);
for (const p of board.suggestion!.seeds) dot(Hm, p, 6, [255, 255, 255, 255], false);
caption(Hm, `suggest: after RAG merge -> ${board.suggestion!.seeds.length} proposed seeds`);

const colW = 640;
const rows = [[B, C], [D, E], [F, G], [Hm]].map((row) => {
  const mats = row.map((m) => fit(m, colW));
  if (mats.length === 1) {
    const blank = pool.add(cv.Mat.zeros(mats[0].rows, colW, cv.CV_8UC4));
    mats.push(blank);
  }
  const v = pool.add(new cv.MatVector());
  mats.forEach((m) => v.push_back(m));
  const out = pool.add(new cv.Mat());
  cv.hconcat(v, out);
  return out;
});
const v = pool.add(new cv.MatVector());
v.push_back(fit(A, colW * 2));
v.push_back(fit(A2, colW * 2));
rows.forEach((m) => v.push_back(m));
const all = pool.add(new cv.Mat());
cv.vconcat(v, all);
mkdirSync('test-images/out', { recursive: true });
const file = `test-images/out/${name}${tag ? '-' + tag : ''}.debug.png`;
writeFileSync(file, encodePNG({ data: all.data, width: all.cols, height: all.rows }));
console.log(`wrote ${file}`);
pool.free();
