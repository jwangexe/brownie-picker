import { fromWorld, type Camera } from './camera';
import type { Pt } from './types';
import type { Rect } from './warp';

/**
 * Cuboid model of each brownie.
 *
 * A brownie is a box, so the outline of its pixels is the wrong thing to measure: the outline
 * includes whatever side faces the camera sees, loses the bits hidden in dark cracks, and grows
 * whenever the segmentation leaks into a neighbour's shadow. Instead:
 *
 *  1. Top face. Each piece's top face is fitted with a rectangle that best covers its light
 *     top-face pixels. The measured area is that top face filled in: everything inside the
 *     rectangle counts (cracks and holes too, even where the segmentation called them background:
 *     a box has no holes), side faces and neighbours' pixels never do, and top crust poking out past the rectangle still counts (cut
 *     lines aren't always parallel, so a top isn't always a perfect rectangle).
 *
 *     Why measuring the top in the top-down view is right even though the top is above the
 *     board: seen from the camera, a plane at height h maps to the board plane by a uniform
 *     scaling about the point under the camera, by (1 + c) with c = h / (camera height − h). For
 *     pieces of one tray (same h) every top face is scaled by the same factor, so ratios between
 *     pieces are exact. The visible side faces, which used to inflate pieces near the camera, are
 *     simply not part of the rectangle.
 *
 *  2. Height. Below each top rectangle's front edge (towards the camera) is the piece's front face:
 *     the run of non-top, non-background pixels straight down from that edge. Its upper quartile
 *     over the board is the shared height (as it appears in the top-down view; fronts are often
 *     partly hidden by the piece in front, never longer).
 *
 *  3. Faces. With the top rectangle and the shared height, the box is complete: the footprint is
 *     the top face pushed back towards the camera, and the visible faces (top, front, and a side
 *     when the piece is off to one side of the camera or rotated) follow from geometry.
 */
export type FaceKind = 'top' | 'front' | 'side';

export interface Face {
  kind: FaceKind;
  /** Polygon in warped (top-down view) coordinates. */
  poly: Pt[];
}

export interface BoxFit {
  /** Footprint corners on the board, world coordinates. */
  footprint: Pt[];
  /** Visible faces (top first), warped coordinates, ready to draw. */
  faces: Face[];
  /** Projected outline of the whole box, warped coordinates. */
  outline: Pt[];
  /** Measured top-face area (world units², = warped px² × ay): everything inside the top
   *  rectangle except other pieces (cracks and holes included, side faces not), plus any of its
   *  top crust outside it (a top that isn't quite rectangular). Every piece's top is scaled by the
   *  same perspective factor, so this compares pieces exactly. */
  area: number;
  /** The rectangle's own area (world units²). */
  rectArea: number;
  /** Top face side lengths, world units. */
  w: number;
  d: number;
  /** How well the rectangle covers the piece's top-face pixels (IoU, 0–1). */
  iou: number;
  /** This piece's own front-face height (world units), or null if none was visible. */
  front: number | null;
}

/** The shared projection of box tops: top = F + (footprint − F)(1 + c), world coordinates. */
export interface Lift {
  F: Pt;
  c: number;
  /** Shared front-face height as seen in the top-down view (world units). */
  height: number;
}

/** Below this the top face isn't a rectangle (leaning, broken, two merged): don't trust its size. */
export const MIN_BOX_IOU = 0.6;

export interface BoxesResult {
  boxes: (BoxFit | null)[];
  lift: Lift;
  /** Labels with every side-face pixel given to the top straight above it (warped). */
  owner: Int32Array;
}

interface RectP {
  u: number;
  v: number;
  a: number; // half width
  b: number; // half depth
  t: number; // angle
}

/** 0 = background, 1 = own side, 2 = own top, 3 = other piece's side, 4 = other piece's top. */
interface Samples {
  x: Float32Array;
  y: Float32Array;
  cat: Uint8Array;
  n: number;
  ownTopN: number;
}

/** Cost of covering a pixel that isn't this piece's top face, by category. Own dark pixels
 *  (cracks, holes) are cheap: a box has no holes, so the rectangle should cover them. */
const COST = [1, 0.35, 0, 0.6, 1];

/** How far (radians) a piece's rectangle may turn from the board's common orientation. */
const MAX_TILT = 0.1;

/**
 * @param pw typical piece width (warped px)
 */
export function fitBoxes(labels: Int32Array, top: Uint8Array, W: number, H: number, nPieces: number, cam: Camera, pw: number, rect: Rect): BoxesResult {
  const ay = cam.ay;
  const bb = Array.from({ length: nPieces + 1 }, () => ({ x0: W, y0: H, x1: -1, y1: -1, nTop: 0 }));
  for (let y = 0, i = 0; y < H; y++) {
    for (let x = 0; x < W; x++, i++) {
      const l = labels[i];
      if (!l || l > nPieces || !top[i]) continue;
      const b = bb[l];
      b.nTop++;
      if (x < b.x0) b.x0 = x;
      if (x > b.x1) b.x1 = x;
      if (y < b.y0) b.y0 = y;
      if (y > b.y1) b.y1 = y;
    }
  }

  // 1. Top-face rectangles.
  const rects: (RectP | null)[] = [];
  const samples: (Samples | null)[] = new Array(nPieces).fill(null);
  const ious: number[] = [];
  for (let id = 1; id <= nPieces; id++) {
    if (bb[id].nTop < 30) {
      rects.push(null);
      ious.push(0);
      continue;
    }
    const s = sample(labels, top, W, H, id, bb[id], pw, ay);
    const { p } = optimise(initialRect(s), rectMoves(pw), (q) => score(s, q));
    rects.push(p);
    ious.push(iou(s, p));
    samples[id - 1] = s;
  }

  // Pieces are cut along the board's edges, which the corners are aligned with: refit every piece
  // close to the board axes. A piece keeps its own angle only if that fits clearly better (one
  // that was knocked askew); irregular crust otherwise tilts rectangles at random.
  {
    const t0 = 0;
    rects.forEach((r, k) => {
      const s = samples[k];
      if (!r || !s) return;
      const { p } = optimise({ ...r, t: t0 }, rectMoves(pw, { lo: t0 - MAX_TILT, hi: t0 + MAX_TILT }), (q) => score(s, q));
      const i2 = iou(s, p);
      if (i2 > ious[k] - 0.03) {
        rects[k] = p;
        ious[k] = i2;
      }
    });
  }

  // 2. A front face sits straight below its own top (towards the camera). The watershed often
  //    hands a whole row of front faces to one piece (they touch, and the top/front edge is a
  //    stronger wall than the thin crevice between two fronts), so side pixels are given to the
  //    top rectangle straight above them.
  const owner = assignSides(rects, labels, top, W, H, ay, pw);

  // 3. Front-face heights, and the shared height (pieces whose front is hidden don't vote).
  const fronts = rects.map((r) => (r ? frontRun(r, owner, top, W, H, ay, pw) : null));
  // A front face can be partly hidden (by the piece in front) but never longer than it is, so the
  // upper quartile is a better estimate than the median.
  const seen = fronts.filter((f): f is number => f !== null && f > 0.05 * pw).sort((p, q) => p - q);
  const height = seen.length ? seen[Math.floor(seen.length * 0.75)] : 0;

  // 4. The camera is in front of the board (photo-down = +y in the top-down view), well back.
  const cx = (rect.x0 + rect.x1) / 2;
  const cy = ((rect.y0 + rect.y1) / 2) * ay;
  const F = { x: cx, y: rect.y1 * ay + 2 * (rect.x1 - rect.x0) };
  const lift: Lift = { F, c: height / Math.max(1, F.y - cy), height };

  const boxes = rects.map((r, k) => (r ? describe(r, lift, cam, ious[k], fronts[k], filledArea(r, k + 1, labels, top, W, H, ay, rect)) : null));
  return { boxes, lift, owner };
}

// ------------------------------------------------------------------------------- sampling

function sample(labels: Int32Array, top: Uint8Array, W: number, H: number, id: number, b: { x0: number; y0: number; x1: number; y1: number }, pw: number, ay: number): Samples {
  const m = Math.round(0.25 * pw);
  const x0 = Math.max(0, b.x0 - m);
  const x1 = Math.min(W - 1, b.x1 + m);
  const y0 = Math.max(0, b.y0 - m);
  const y1 = Math.min(H - 1, b.y1 + m);
  // ~2500 samples per piece is plenty and keeps the fit fast.
  const step = Math.max(1, Math.round(Math.sqrt(((x1 - x0 + 1) * (y1 - y0 + 1)) / 2500)));
  const cap = Math.ceil((x1 - x0 + 1) / step) * Math.ceil((y1 - y0 + 1) / step);
  const xs = new Float32Array(cap);
  const ys = new Float32Array(cap);
  const cat = new Uint8Array(cap);
  let n = 0;
  let ownTopN = 0;
  for (let y = y0; y <= y1; y += step) {
    for (let x = x0; x <= x1; x += step) {
      const i = y * W + x;
      const l = labels[i];
      const c = !l ? 0 : l === id ? (top[i] ? 2 : 1) : top[i] ? 4 : 3;
      xs[n] = x;
      ys[n] = y * ay;
      cat[n] = c;
      if (c === 2) ownTopN++;
      n++;
    }
  }
  return { x: xs, y: ys, cat, n, ownTopN };
}

// ------------------------------------------------------------------------------- geometry

function corners(p: RectP): Pt[] {
  const c = Math.cos(p.t);
  const s = Math.sin(p.t);
  return [
    [-p.a, -p.b],
    [p.a, -p.b],
    [p.a, p.b],
    [-p.a, p.b],
  ].map(([x, y]) => ({ x: p.u + x * c - y * s, y: p.v + x * s + y * c }));
}

/** Point inside the rotated rectangle? */
function inRect(p: RectP, x: number, y: number, c: number, s: number): boolean {
  const dx = x - p.u;
  const dy = y - p.v;
  return Math.abs(dx * c + dy * s) <= p.a && Math.abs(-dx * s + dy * c) <= p.b;
}

function hull(pts: Pt[]): Pt[] {
  const P = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  const cr = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Pt[] = [];
  for (const p of P) {
    while (lower.length >= 2 && cr(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (let i = P.length - 1; i >= 0; i--) {
    const p = P[i];
    while (upper.length >= 2 && cr(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

// ------------------------------------------------------------------------------- fitting

/** Covered top pixels / (all top pixels + cost of everything else covered): an IoU in which a
 *  crack inside the piece is cheap to cover and a neighbour's top is expensive. */
function score(s: Samples, p: RectP): number {
  if (p.a <= 1 || p.b <= 1) return -1;
  const c = Math.cos(p.t);
  const sn = Math.sin(p.t);
  let hit = 0;
  let cost = 0;
  for (let k = 0; k < s.n; k++) {
    if (!inRect(p, s.x[k], s.y[k], c, sn)) continue;
    const cat = s.cat[k];
    if (cat === 2) hit++;
    else cost += COST[cat];
  }
  return hit / (s.ownTopN + cost);
}

/** Plain IoU of the rectangle with the piece's top-face pixels. */
function iou(s: Samples, p: RectP): number {
  const c = Math.cos(p.t);
  const sn = Math.sin(p.t);
  let hit = 0;
  let inside = 0;
  for (let k = 0; k < s.n; k++) {
    if (!inRect(p, s.x[k], s.y[k], c, sn)) continue;
    inside++;
    if (s.cat[k] === 2) hit++;
  }
  return hit / (s.ownTopN + inside - hit);
}

/** Start: orientation from second moments of the top-face pixels, extent from robust percentiles. */
function initialRect(s: Samples): RectP {
  let n = 0;
  let mx = 0;
  let my = 0;
  for (let k = 0; k < s.n; k++) {
    if (s.cat[k] !== 2) continue;
    mx += s.x[k];
    my += s.y[k];
    n++;
  }
  mx /= n;
  my /= n;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  const px: number[] = [];
  const py: number[] = [];
  for (let k = 0; k < s.n; k++) {
    if (s.cat[k] !== 2) continue;
    const dx = s.x[k] - mx;
    const dy = s.y[k] - my;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
    px.push(dx);
    py.push(dy);
  }
  let t = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  // A ±90° turn is the same rectangle: keep the angle near 0 (pieces are mostly cut along the axes).
  while (t > Math.PI / 4) t -= Math.PI / 2;
  while (t < -Math.PI / 4) t += Math.PI / 2;
  const c = Math.cos(t);
  const sn = Math.sin(t);
  const us = px.map((x, i) => x * c + py[i] * sn).sort((a, b) => a - b);
  const vs = px.map((x, i) => -x * sn + py[i] * c).sort((a, b) => a - b);
  const q = (arr: number[], f: number) => arr[Math.min(arr.length - 1, Math.max(0, Math.round(f * (arr.length - 1))))];
  const [u0, u1, v0, v1] = [q(us, 0.05), q(us, 0.95), q(vs, 0.05), q(vs, 0.95)];
  return {
    u: mx + ((u0 + u1) / 2) * c - ((v0 + v1) / 2) * sn,
    v: my + ((u0 + u1) / 2) * sn + ((v0 + v1) / 2) * c,
    a: Math.max(2, (u1 - u0) / 2),
    b: Math.max(2, (v1 - v0) / 2),
    t,
  };
}

interface Move {
  step: number;
  min: number;
  apply: (p: RectP, d: number) => RectP;
}

/** Each side of the rectangle moves on its own (so one edge can settle while the others don't),
 *  plus translation and rotation. */
function rectMoves(pw: number, tRange = { lo: -Math.PI / 3, hi: Math.PI / 3 }): Move[] {
  const side = (axis: 'a' | 'b', sign: 1 | -1): Move => ({
    step: 0.06 * pw,
    min: 0.01 * pw,
    apply: (p, d) => {
      const h = Math.max(1, p[axis] + d / 2);
      const dd = h - p[axis];
      const c = Math.cos(p.t);
      const s = Math.sin(p.t);
      const [ux, uy] = axis === 'a' ? [c, s] : [-s, c];
      return { ...p, [axis]: h, u: p.u + sign * ux * dd, v: p.v + sign * uy * dd };
    },
  });
  return [
    { step: 0.06 * pw, min: 0.01 * pw, apply: (p, d) => ({ ...p, u: p.u + d }) },
    { step: 0.06 * pw, min: 0.01 * pw, apply: (p, d) => ({ ...p, v: p.v + d }) },
    side('a', 1),
    side('a', -1),
    side('b', 1),
    side('b', -1),
    { step: 0.06, min: 0.005, apply: (p, d) => ({ ...p, t: Math.max(tRange.lo, Math.min(tRange.hi, p.t + d)) }) },
  ];
}

function optimise(p0: RectP, moves: Move[], f: (p: RectP) => number): { p: RectP; score: number } {
  const step = moves.map((m) => m.step);
  let p = { ...p0 };
  let best = f(p);
  for (let it = 0; it < 200; it++) {
    let improved = false;
    moves.forEach((m, k) => {
      for (const dir of [1, -1]) {
        const q = m.apply(p, dir * step[k]);
        const sc = f(q);
        if (sc > best + 1e-6) {
          best = sc;
          p = q;
          improved = true;
          break;
        }
      }
    });
    if (!improved) {
      let any = false;
      moves.forEach((m, k) => {
        if (step[k] > m.min) {
          step[k] /= 2;
          any = true;
        }
      });
      if (!any) break;
    }
  }
  return { p, score: best };
}

/** Top-face area with the box's interior filled: everything inside the rectangle except other
 *  pieces (so cracks and holes count, whether the segmentation called them this piece's side face
 *  or background), plus this piece's top pixels outside it. World units². */
function filledArea(r: RectP, id: number, labels: Int32Array, top: Uint8Array, W: number, H: number, ay: number, board: Rect): number {
  const c = Math.cos(r.t);
  const s = Math.sin(r.t);
  // Background only counts well inside the rectangle (a hole), not along its edges, where it is
  // just the board showing past a top that isn't perfectly rectangular.
  const m = Math.max(2, 0.08 * Math.min(r.a, r.b));
  const core = { ...r, a: r.a - m, b: r.b - m };
  let n = 0;
  for (let y = 0, i = 0; y < H; y++) {
    for (let x = 0; x < W; x++, i++) {
      const l = labels[i];
      if (l === id) {
        if (top[i] || inRect(r, x, y * ay, c, s)) n++;
      } else if (!l && x >= board.x0 && x <= board.x1 && y >= board.y0 && y <= board.y1 && inRect(core, x, y * ay, c, s)) n++;
    }
  }
  return n * ay;
}

// ------------------------------------------------------------------------------- height

/** Labels where each non-top piece pixel belongs to the nearest top rectangle straight above it
 *  (within ~a piece width); pixels with no top above keep their watershed label. */
function assignSides(rects: (RectP | null)[], labels: Int32Array, top: Uint8Array, W: number, H: number, ay: number, pw: number): Int32Array {
  const rmap = new Int32Array(W * H);
  rects.forEach((r, k) => {
    if (!r) return;
    const c = Math.cos(r.t);
    const s = Math.sin(r.t);
    const cs = corners(r);
    const x0 = Math.max(0, Math.floor(Math.min(...cs.map((q) => q.x))));
    const x1 = Math.min(W - 1, Math.ceil(Math.max(...cs.map((q) => q.x))));
    const y0 = Math.max(0, Math.floor(Math.min(...cs.map((q) => q.y)) / ay));
    const y1 = Math.min(H - 1, Math.ceil(Math.max(...cs.map((q) => q.y)) / ay));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) if (inRect(r, x, y * ay, c, s) && !rmap[y * W + x]) rmap[y * W + x] = k + 1;
    }
  });
  const out = labels.slice();
  const reach = Math.round(1.2 * pw);
  for (let x = 0; x < W; x++) {
    // Walk each column top to bottom, remembering the last top rectangle passed.
    let last = 0;
    let since = Infinity;
    for (let y = 0; y < H; y++) {
      const i = y * W + x;
      if (rmap[i]) {
        last = rmap[i];
        since = 0;
        continue;
      }
      since++;
      if (labels[i] && !top[i] && last && since <= reach) out[i] = last;
      else if (!labels[i] && since > 3) last = 0; // background in between: the chain is broken
    }
  }
  return out;
}

/**
 * Median length of the front face below the rectangle's front edge: from points along that edge,
 * march straight towards the camera (+y) through pixels that belong to some piece but aren't top
 * face. Returns null if no front face is visible (hidden behind the next piece, or none there).
 */
function frontRun(r: RectP, labels: Int32Array, top: Uint8Array, W: number, H: number, ay: number, pw: number): number | null {
  const cs = corners(r);
  // Front edge = the edge whose midpoint is lowest (largest y).
  let best = 0;
  for (let i = 1; i < 4; i++) {
    const m = (cs[i].y + cs[(i + 1) % 4].y) / 2;
    const mb = (cs[best].y + cs[(best + 1) % 4].y) / 2;
    if (m > mb) best = i;
  }
  const a = cs[best];
  const b = cs[(best + 1) % 4];
  const maxRun = 1.2 * pw;
  const runs: number[] = [];
  for (let f = 0.15; f <= 0.851; f += 0.07) {
    const x = Math.round(a.x + (b.x - a.x) * f);
    let y = Math.round((a.y + (b.y - a.y) * f) / ay);
    if (x < 0 || x >= W) continue;
    // Skip the blurry rim right at the edge.
    y += 2;
    let run = 0;
    let gap = 0;
    while (y < H && run + gap < maxRun) {
      const i = y * W + x;
      if (labels[i] && !top[i]) {
        run += 1 + gap;
        gap = 0;
      } else if (gap < 2) gap++;
      else break;
      y++;
    }
    runs.push(run * ay);
  }
  if (!runs.length) return null;
  runs.sort((p, q) => p - q);
  const m = runs[runs.length >> 1];
  return m > 0 ? m : null;
}

// ------------------------------------------------------------------------------- output

function describe(r: RectP, L: Lift, cam: Camera, fitIou: number, front: number | null, area: number): BoxFit {
  const topC = corners(r);
  const k = 1 + L.c;
  const foot = topC.map((q) => ({ x: L.F.x + (q.x - L.F.x) / k, y: L.F.y + (q.y - L.F.y) / k }));
  const toW = (q: Pt) => fromWorld(cam, q);
  // Vertical faces the camera sees: those whose outward normal points towards F.
  const vis: { i: number; facing: number }[] = [];
  const ctr = { x: (foot[0].x + foot[2].x) / 2, y: (foot[0].y + foot[2].y) / 2 };
  for (let i = 0; i < 4; i++) {
    const a = foot[i];
    const b = foot[(i + 1) % 4];
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    let nx = -(b.y - a.y);
    let ny = b.x - a.x;
    if (nx * (mid.x - ctr.x) + ny * (mid.y - ctr.y) < 0) [nx, ny] = [-nx, -ny];
    const tx = L.F.x - mid.x;
    const ty = L.F.y - mid.y;
    const facing = (nx * tx + ny * ty) / (Math.hypot(nx, ny) * Math.hypot(tx, ty));
    if (facing > 0.05) vis.push({ i, facing });
  }
  vis.sort((x, y) => y.facing - x.facing);
  const faces: Face[] = [{ kind: 'top', poly: topC.map(toW) }];
  if (L.c > 0) {
    vis.forEach(({ i }, n) => {
      const j = (i + 1) % 4;
      faces.push({ kind: n === 0 ? 'front' : 'side', poly: [foot[i], foot[j], topC[j], topC[i]].map(toW) });
    });
  }
  return {
    footprint: foot,
    faces,
    outline: hull([...foot, ...topC]).map(toW),
    area,
    rectArea: 4 * r.a * r.b,
    w: 2 * r.a,
    d: 2 * r.b,
    iou: fitIou,
    front,
  };
}
