import { cv, MatPool } from './cv';
import { elevationImage, type GapMap } from './gapmap';
import { backgroundMask, modelFrom, seededWatershed, type ColourModel, type LabImage } from './markers';
import type { Pt, RGBAImage } from './types';
import type { Rect } from './warp';

/**
 * "Suggest seeds": proposes one marker per piece for the user to accept or delete. It never creates
 * pieces itself.
 *
 *  1. Foreground = not background, judged against the colour of the brownies already tapped (or,
 *     with no taps yet, a guess from the board's more coloured half), minus the cut lines.
 *  2. Over-segment: distance-transform peaks -> watershed fragments.
 *  3. Region adjacency graph: merge neighbours whose shared boundary has no cut line on the gap map
 *     (weak boundary), whose union is clearly more rectangular than either part, or which are both
 *     well under a typical piece (fragments). Brownies are roughly rectangular; a crack splits one
 *     into two irregular halves whose union is a rectangle. A boundary carrying a confirmed cut line
 *     is never merged, and no merge may create a piece much bigger than typical.
 *  4. One proposal per merged region, at its most interior point.
 */
export interface Suggestion {
  seeds: Pt[];
  /** Fragment labels before merging (debug). */
  fragments: Int32Array;
  /** Region labels after merging (debug). */
  merged: Int32Array;
  model: ColourModel;
}

export function suggestSeeds(img: RGBAImage, lab: LabImage, inner: Rect, gm: GapMap, known?: ColourModel): Suggestion {
  const W = img.width;
  const H = img.height;
  const N = W * H;
  // Brownie colour: from the user's taps when there are any (reliable), else a guess.
  const model = known ?? boardModel(lab, W, inner);
  const bg = backgroundMask(lab, W, inner, model, true);
  const pool = new MatPool();
  try {
    // 1. Foreground minus cut lines.
    const fg = pool.add(cv.Mat.zeros(H, W, cv.CV_8UC1));
    const fd = fg.data as Uint8Array;
    for (let i = 0; i < N; i++) if (!bg[i] && !gm.gap[i]) fd[i] = 255;
    cv.morphologyEx(fg, fg, cv.MORPH_OPEN, pool.add(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5, 5))));

    // 2. Distance-transform peaks (per blob, so small blobs still get one) -> fragments.
    const dist = pool.add(new cv.Mat());
    cv.distanceTransform(fg, dist, cv.DIST_L2, 5);
    const dd = dist.data32F as Float32Array;
    const cc = pool.add(new cv.Mat());
    const nCC = cv.connectedComponents(fg, cc, 8, cv.CV_32S) as number;
    const ccd = cc.data32S as Int32Array;
    const peak = new Float32Array(nCC);
    for (let i = 0; i < N; i++) if (dd[i] > peak[ccd[i]]) peak[ccd[i]] = dd[i];
    const core = pool.add(cv.Mat.zeros(H, W, cv.CV_8UC1));
    const co = core.data as Uint8Array;
    const minPeak = 0.12 * gm.pieceWidth;
    for (let i = 0; i < N; i++) {
      const l = ccd[i];
      if (l > 0 && peak[l] >= minPeak && dd[i] > 0.5 * peak[l]) co[i] = 255;
    }
    const coreLab = pool.add(new cv.Mat());
    const nCore = (cv.connectedComponents(core, coreLab, 8, cv.CV_32S) as number) - 1;
    const cl = coreLab.data32S as Int32Array;
    const coreSeeds: Pt[] = [];
    {
      const sx = new Float64Array(nCore + 1);
      const sy = new Float64Array(nCore + 1);
      const best = new Float32Array(nCore + 1);
      for (let i = 0; i < N; i++) {
        const l = cl[i];
        if (!l) continue;
        sx[l] += i % W;
        sy[l] += Math.floor(i / W);
        best[l]++;
      }
      for (let l = 1; l <= nCore; l++) coreSeeds.push({ x: sx[l] / best[l], y: sy[l] / best[l] });
    }
    if (!coreSeeds.length) return { seeds: [], fragments: new Int32Array(N), merged: new Int32Array(N), model };

    const elev = elevationImage(img, gm, pool);
    const fragments = seededWatershed(elev, W, H, coreSeeds, bg);

    // 3. Region adjacency graph merge.
    const merged = mergeFragments(fragments, coreSeeds.length, W, H, gm.gap);

    // 4. Proposal per merged region: its most interior point.
    const regMask = pool.add(cv.Mat.zeros(H, W, cv.CV_8UC1));
    const rm = regMask.data as Uint8Array;
    for (let i = 0; i < N; i++) rm[i] = merged[i] ? 255 : 0;
    // Separate regions from each other so the distance transform peaks inside each.
    for (let y = 0; y < H - 1; y++) {
      for (let x = 0; x < W - 1; x++) {
        const i = y * W + x;
        if (merged[i] && ((merged[i + 1] && merged[i + 1] !== merged[i]) || (merged[i + W] && merged[i + W] !== merged[i]))) rm[i] = 0;
      }
    }
    const d2 = pool.add(new cv.Mat());
    cv.distanceTransform(regMask, d2, cv.DIST_L2, 5);
    const d2d = d2.data32F as Float32Array;
    const bestD = new Map<number, { d: number; i: number; n: number }>();
    for (let i = 0; i < N; i++) {
      const l = merged[i];
      if (!l) continue;
      const b = bestD.get(l);
      if (!b) bestD.set(l, { d: d2d[i], i, n: 1 });
      else {
        b.n++;
        if (d2d[i] > b.d) {
          b.d = d2d[i];
          b.i = i;
        }
      }
    }
    const innerArea = (inner.x1 - inner.x0 + 1) * (inner.y1 - inner.y0 + 1);
    const seeds: Pt[] = [];
    for (const b of bestD.values()) {
      if (b.n < 0.002 * innerArea || b.d < 0.08 * gm.pieceWidth) continue; // crumbs
      seeds.push({ x: b.i % W, y: Math.floor(b.i / W) });
    }
    return { seeds, fragments, merged, model };
  } finally {
    pool.free();
  }
}

/** Colour model of "the board's dominant brownie" when there are no taps yet. */
export function boardModel(lab: LabImage, W: number, inner: Rect): ColourModel {
  const idx: number[] = [];
  const Cs: number[] = [];
  for (let y = inner.y0; y <= inner.y1; y += 2) {
    for (let x = inner.x0; x <= inner.x1; x += 2) {
      const i = y * W + x;
      idx.push(i);
      Cs.push(Math.hypot(lab.a[i], lab.b[i]));
    }
  }
  // The more coloured half of the board is brownie (paper and plates are pale).
  const order = Cs.map((c, k) => [c, idx[k]] as const).sort((p, q) => p[0] - q[0]);
  const upper = order.slice(order.length >> 1).map(([, i]) => i);
  const m = modelFrom(upper.map((i) => lab.L[i]), upper.map((i) => lab.a[i]), upper.map((i) => lab.b[i]));
  // Board-wide spread mixes brownie with board; don't let the colour-distance rule fire on it.
  return { ...m, sL: Math.max(m.sL, 40), sa: Math.max(m.sa, 10), sb: Math.max(m.sb, 12) };
}

interface Region {
  area: number;
  pts: number[]; // boundary points, flat x,y
}

/** Rectangularity: area / minimum-area bounding rectangle. 1 = perfect rectangle. */
function rectangularity(area: number, pts: number[]): number {
  if (pts.length < 6) return 0;
  const m = cv.matFromArray(pts.length / 2, 1, cv.CV_32SC2, pts);
  try {
    const r = cv.minAreaRect(m);
    const a = r.size.width * r.size.height;
    return a > 0 ? Math.min(1, area / a) : 0;
  } finally {
    m.delete();
  }
}

/** Greedy RAG merge; returns a relabelled map (labels 1..m). */
export function mergeFragments(labels: Int32Array, n: number, W: number, H: number, gap: Uint8Array): Int32Array {
  const lab = labels.slice();
  const regions = new Map<number, Region>();
  for (let l = 1; l <= n; l++) regions.set(l, { area: 0, pts: [] });
  for (let y = 0, i = 0; y < H; y++) {
    for (let x = 0; x < W; x++, i++) {
      const l = lab[i];
      if (!l) continue;
      const r = regions.get(l)!;
      r.area++;
      const edge = x === 0 || y === 0 || x === W - 1 || y === H - 1 || lab[i - 1] !== l || lab[i + 1] !== l || lab[i - W] !== l || lab[i + W] !== l;
      if (edge) r.pts.push(x, y);
    }
  }
  for (const [l, r] of regions) if (!r.area) regions.delete(l);

  for (let iter = 0; iter < 200; iter++) {
    // Boundary statistics between every pair of touching regions.
    const pairs = new Map<string, { a: number; b: number; len: number; gapSum: number }>();
    const add = (p: number, q: number, i: number, j: number) => {
      const a = Math.min(p, q);
      const b = Math.max(p, q);
      const key = `${a},${b}`;
      let s = pairs.get(key);
      if (!s) pairs.set(key, (s = { a, b, len: 0, gapSum: 0 }));
      s.len++;
      s.gapSum += Math.max(gap[i], gap[j]);
    };
    for (let y = 0; y < H - 1; y++) {
      for (let x = 0; x < W - 1; x++) {
        const i = y * W + x;
        const l = lab[i];
        if (!l) continue;
        const r = lab[i + 1];
        const d = lab[i + W];
        if (r && r !== l) add(l, r, i, i + 1);
        if (d && d !== l) add(l, d, i, i + W);
      }
    }
    const areas = [...regions.values()].map((r) => r.area).sort((a, b) => a - b);
    const p75 = areas[Math.floor(areas.length * 0.75)] ?? 0;
    let best: { a: number; b: number; score: number } | null = null;
    for (const s of pairs.values()) {
      const A = regions.get(s.a)!;
      const B = regions.get(s.b)!;
      if (A.area + B.area > 1.5 * p75) continue; // would make an outsized piece
      const meanGap = s.gapSum / s.len;
      if (meanGap > 90) continue; // a real cut line runs along this boundary: never merge
      if (s.len < 0.25 * Math.sqrt(Math.min(A.area, B.area))) continue; // only touching at a corner
      const ra = rectangularity(A.area, A.pts);
      const rb = rectangularity(B.area, B.pts);
      const ru = rectangularity(A.area + B.area, A.pts.concat(B.pts));
      const gain = ru - Math.max(ra, rb);
      const weak = meanGap < 50;
      // Size prior: two neighbours that are each well under a typical piece, with no confirmed cut
      // between them, are most likely one piece split by a crack.
      const halves = Math.max(A.area, B.area) < 0.6 * p75 && A.area + B.area <= 1.25 * p75 && meanGap < 70;
      if (!((weak && ru >= Math.min(ra, rb) - 0.05) || gain > 0.03 || halves)) continue;
      const score = gain - meanGap / 255 + (weak ? 0.05 : 0) + (halves ? 0.05 : 0);
      if (!best || score > best.score) best = { a: s.a, b: s.b, score };
    }
    if (!best) break;
    const A = regions.get(best.a)!;
    const B = regions.get(best.b)!;
    A.area += B.area;
    A.pts = A.pts.concat(B.pts);
    regions.delete(best.b);
    for (let i = 0; i < lab.length; i++) if (lab[i] === best.b) lab[i] = best.a;
  }

  const remap = new Map<number, number>();
  let next = 1;
  for (const l of regions.keys()) remap.set(l, next++);
  for (let i = 0; i < lab.length; i++) lab[i] = lab[i] ? remap.get(lab[i]) ?? 0 : 0;
  return lab;
}
