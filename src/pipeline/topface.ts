import { cv, MatPool } from './cv';
import type { LabImage } from './markers';

/**
 * Splits each piece into top face and side face, so only the top is measured.
 *
 * Shot from an angle, a brownie shows its near vertical face below its top. That face is darker
 * (it faces away from overhead light) and smoother (a cut face, not cracked crust). Per piece:
 *   candidates = clearly darker than the top (L < 0.62 × top), or moderately darker and smooth
 *                (low local variance of L);
 *   side = candidate regions (after opening away thin cracks) that touch the piece's outline.
 * Very dark pixels (gaps, shadow) never count. If the "side" would be most of the piece, nothing
 * is removed: better to over-measure a little than to cut a piece in half.
 *
 * @returns top: 1 where a piece pixel counts as top face (0 for side faces and background)
 */
export function topFaces(lab: LabImage, labels: Int32Array, W: number, H: number, darkL = 0): Uint8Array {
  const n = W * H;
  const tex = localStd(lab.L, W, H, 7);
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
  for (const [label, px] of byLabel) {
    if (px.length < 60) continue;
    // Brightness of the top: upper part of the distribution (robust even if a side face is large).
    const Ls = px.map((i) => lab.L[i]).sort((p, q) => p - q);
    const topL = Ls[Math.floor(Ls.length * 0.7)];
    const Ts = px.map((i) => tex[i]).sort((p, q) => p - q);
    const medT = Ts[Ts.length >> 1];
    // Side-face candidates: clearly dark (side faces are ≈0.4× the top in café light, a shaded patch
    // of crust ≈0.7×), or moderately dark AND smooth (a clean cut face lacks crust texture).
    for (const i of px) {
      const L = lab.L[i];
      if (L < 0.62 * topL || (L < 0.75 * topL && tex[i] < 0.6 * medT)) lowAll[i] = 255;
    }
    pieceSize.set(label, px.length);
  }

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
    if (side.length > 0.6 * (pieceSize.get(label) ?? 0)) continue; // implausible: keep the piece whole
    for (const i of side) top[i] = 0;
  }
  return openTop(top, W, H);
}

/** Local standard deviation of an 8-bit channel in a k×k window. */
function localStd(L: Uint8Array, W: number, H: number, k: number): Float32Array {
  const pool = new MatPool();
  try {
    const src = pool.add(cv.matFromArray(H, W, cv.CV_8UC1, L));
    const f = pool.add(new cv.Mat());
    src.convertTo(f, cv.CV_32F);
    const sq = pool.add(new cv.Mat());
    cv.multiply(f, f, sq);
    const m = pool.add(new cv.Mat());
    const m2 = pool.add(new cv.Mat());
    const ks = new cv.Size(k, k);
    cv.blur(f, m, ks);
    cv.blur(sq, m2, ks);
    const md = m.data32F as Float32Array;
    const m2d = m2.data32F as Float32Array;
    const out = new Float32Array(W * H);
    for (let i = 0; i < out.length; i++) out[i] = Math.sqrt(Math.max(0, m2d[i] - md[i] * md[i]));
    return out;
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
