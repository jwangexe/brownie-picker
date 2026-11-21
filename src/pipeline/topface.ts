import { cv, MatPool } from './cv';
import type { ColourModel, LabImage } from './markers';

/**
 * Splits each piece into top face and side faces, so only the top is measured.
 *
 * Shot from an angle, a brownie shows its cut faces next to its top. Cut faces are darker than the
 * crust AND less yellow (the crust is glossy, caramelised sugar; the crumb inside is duller), which
 * separates them even when they are only ~0.7× as bright as the top. So every piece pixel on the
 * board is split into two clusters on (lightness relative to the brightest crust nearby, yellowness),
 * seeded with the tapped crust colour and a duller, darker guess for the sides:
 *   side = side-cluster regions (after opening away thin cracks) that touch the piece's outline.
 * Very dark pixels (gaps, shadow) never count as top. If "side" would be nearly the whole piece,
 * nothing is removed: better to over-measure a little than to lose the piece.
 *
 * @returns top: 1 where a piece pixel counts as top face (0 for side faces and background)
 */
export function topFaces(lab: LabImage, labels: Int32Array, W: number, H: number, darkL = 0, model?: ColourModel, pw = 60): Uint8Array {
  const n = W * H;
  const top = new Uint8Array(n);
  // Very dark pixels (gaps, deep shadow) the watershed handed to a piece are never top face.
  for (let i = 0; i < n; i++) if (labels[i] && lab.L[i] >= darkL) top[i] = 1;

  // Group pixels by label.
  const byLabel = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const l = labels[i];
    if (!l) continue;
    let a = byLabel.get(l);
    if (!a) byLabel.set(l, (a = []));
    a.push(i);
  }

  const lowAll = new Uint8Array(n);
  const pieceSize = new Map<number, number>();
  for (const [label, px] of byLabel) pieceSize.set(label, px.length);
  for (const i of splitSides(lab, labels, W, H, pw, darkL, model)) lowAll[i] = 255;

  // Side faces = dark/smooth regions touching the piece's outline (a side face is always at a piece
  // edge: the near face below the top, or a neighbour's face leaning into this piece's mask).
  // Opening first removes thin cracks, so a crack reaching the edge isn't mistaken for a face.
  const opened = openMask(lowAll, W, H, 5);
  // "Touching the outline" = within 4 px of it: a blurred light rim (board seen through the edge
  // blur) often separates a side face from the true mask boundary by a pixel or three.
  const edge = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const l = labels[i];
    if (!l) continue;
    const x = i % W;
    if ((x > 0 && labels[i - 1] !== l) || (x < W - 1 && labels[i + 1] !== l) || i < W || labels[i - W] !== l || i >= n - W || labels[i + W] !== l) edge[i] = 255;
  }
  const nearEdge = dilate(edge, W, H, 9);
  const seen = new Uint8Array(n);
  const sideByLabel = new Map<number, number[]>();
  const stack: number[] = [];
  for (let s = 0; s < n; s++) {
    if (!opened[s] || seen[s]) continue;
    const label = labels[s];
    const comp: number[] = [];
    let touches = false;
    stack.push(s);
    seen[s] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      comp.push(i);
      if (nearEdge[i]) touches = true;
      const x = i % W;
      const nb = [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i - W, i + W];
      for (const j of nb) {
        if (j < 0 || j >= n) continue;
        if (labels[j] !== label) continue;
        if (opened[j] && !seen[j]) {
          seen[j] = 1;
          stack.push(j);
        }
      }
    }
    if (!touches || comp.length < 0.02 * (pieceSize.get(label) ?? Infinity)) continue;
    let a = sideByLabel.get(label);
    if (!a) sideByLabel.set(label, (a = []));
    a.push(...comp);
  }
  for (const [label, side] of sideByLabel) {
    // Implausible only if almost nothing would be left: a piece whose mask is mostly side face is
    // usually one that grabbed its neighbours' front faces (fixed later, in the cuboid fit).
    if ((pieceSize.get(label) ?? 0) - side.length < 0.08 * (pieceSize.get(label) ?? 0)) continue;
    for (const i of side) top[i] = 0;
  }
  return openTop(top, W, H);
}

/**
 * Two-cluster split of all piece pixels on (L, 2·b): crust vs cut face. Returns the indices of
 * pixels in the side cluster, or none if the clusters aren't clearly apart (a top-down photo has
 * no side faces to find).
 */
function splitSides(lab: LabImage, labels: Int32Array, W: number, H: number, pw: number, darkL: number, model?: ColourModel): number[] {
  const idx: number[] = [];
  for (let i = 0; i < labels.length; i++) if (labels[i] && lab.L[i] >= darkL) idx.push(i);
  if (idx.length < 100) return [];
  // Light varies across a display (one end in shadow): judge each pixel's lightness relative to
  // the brightest crust around it (local max over ~1.5 piece widths, smoothed), not to the board.
  const local = localReference(lab.L, labels, W, H, pw);
  const refs = idx.map((i) => local[i]).sort((p, q) => p - q);
  const ref = refs[refs.length >> 1] || 1;
  const step = Math.max(1, Math.floor(idx.length / 40000));
  const topL0 = model?.L ?? ref;
  const topB0 = model?.b ?? 0;
  let c1 = [topL0, 2 * topB0];
  let c2 = [0.65 * topL0, 2 * (topB0 - 10)];
  const feat = (i: number) => [(lab.L[i] * ref) / Math.max(1, local[i]), 2 * lab.b[i]];
  const d2 = (f: number[], c: number[]) => (f[0] - c[0]) ** 2 + (f[1] - c[1]) ** 2;
  for (let it = 0; it < 8; it++) {
    const s1 = [0, 0, 0];
    const s2 = [0, 0, 0];
    for (let k = 0; k < idx.length; k += step) {
      const f = feat(idx[k]);
      const t = d2(f, c1) <= d2(f, c2) ? s1 : s2;
      t[0] += f[0];
      t[1] += f[1];
      t[2]++;
    }
    if (!s1[2] || !s2[2]) return [];
    c1 = [s1[0] / s1[2], s1[1] / s1[2]];
    c2 = [s2[0] / s2[2], s2[1] / s2[2]];
  }
  // The side cluster must be clearly darker than the crust; otherwise there's nothing to split.
  if (c2[0] > c1[0]) [c1, c2] = [c2, c1];
  if (c1[0] - c2[0] < 18) return [];
  return idx.filter((i) => d2(feat(i), c2) < d2(feat(i), c1));
}

/** Local lightness reference: max of the (blurred) piece pixels within ~1.5 piece widths, then
 *  smoothed: tracks the lighting across the board without following any one piece's faces. */
function localReference(L: Uint8Array, labels: Int32Array, W: number, H: number, pw: number): Float32Array {
  const pool = new MatPool();
  try {
    const m = pool.add(cv.matFromArray(H, W, cv.CV_8UC1, L));
    cv.GaussianBlur(m, m, new cv.Size(5, 5), 0);
    const d = m.data as Uint8Array;
    for (let i = 0; i < d.length; i++) if (!labels[i]) d[i] = 0;
    const k = Math.max(15, Math.round(1.5 * pw) | 1);
    cv.dilate(m, m, pool.add(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(k, k))));
    cv.blur(m, m, new cv.Size(k, k));
    return Float32Array.from(m.data as Uint8Array);
  } finally {
    pool.free();
  }
}

/** Light opening so stray single pixels don't flip between top and side. */
function openTop(top: Uint8Array, W: number, H: number): Uint8Array {
  return openMask(top, W, H, 3);
}

function dilate(m0: Uint8Array, W: number, H: number, k: number): Uint8Array {
  const pool = new MatPool();
  try {
    const m = pool.add(cv.matFromArray(H, W, cv.CV_8UC1, m0));
    cv.dilate(m, m, pool.add(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(k, k))));
    return new Uint8Array(m.data);
  } finally {
    pool.free();
  }
}

function openMask(m0: Uint8Array, W: number, H: number, k: number): Uint8Array {
  const pool = new MatPool();
  try {
    const m = pool.add(cv.matFromArray(H, W, cv.CV_8UC1, m0));
    cv.morphologyEx(m, m, cv.MORPH_OPEN, pool.add(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(k, k))));
    return new Uint8Array(m.data);
  } finally {
    pool.free();
  }
}
