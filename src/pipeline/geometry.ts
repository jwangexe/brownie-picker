import type { Pt } from './types';

/** Orders 4 points as top-left, top-right, bottom-right, bottom-left (clockwise on screen). */
export function orderCorners(pts: Pt[]): Pt[] {
  if (pts.length !== 4) throw new Error('need exactly 4 corners');
  const cx = pts.reduce((s, p) => s + p.x, 0) / 4;
  const cy = pts.reduce((s, p) => s + p.y, 0) / 4;
  const sorted = [...pts].sort(
    (a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx),
  );
  // Clockwise on screen from the angle sort; start at the point closest to the top-left.
  let start = 0;
  for (let i = 1; i < 4; i++) {
    if (sorted[i].x + sorted[i].y < sorted[start].x + sorted[start].y) start = i;
  }
  return [0, 1, 2, 3].map((i) => sorted[(start + i) % 4]);
}

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Output size of the top-down view. The board's true aspect ratio is unknown, but that does not
 * matter: any error in it is an affine stretch, which scales every area by the same factor and so
 * leaves relative sizes unchanged.
 */
export function warpSize(c: Pt[], maxDim = 800): { w: number; h: number } {
  const [tl, tr, br, bl] = c;
  const w0 = Math.max(dist(tl, tr), dist(bl, br));
  const h0 = Math.max(dist(tl, bl), dist(tr, br));
  const s = maxDim / Math.max(w0, h0);
  return { w: Math.max(32, Math.round(w0 * s)), h: Math.max(32, Math.round(h0 * s)) };
}

/**
 * How oblique the shot is: the ratio of the longer to the shorter of each pair of opposite sides.
 * About 1.0 means straight down. Above ~1.5, brownie height starts to bias the areas noticeably.
 */
export function obliqueness(c: Pt[]): number {
  const [tl, tr, br, bl] = c;
  const r1 = dist(tl, tr) / dist(bl, br);
  const r2 = dist(tl, bl) / dist(tr, br);
  return Math.max(r1, 1 / r1, r2, 1 / r2);
}

/** Applies a 3x3 homography (row-major, 9 numbers). */
export function applyH(H: ArrayLike<number>, p: Pt): Pt {
  const w = H[6] * p.x + H[7] * p.y + H[8];
  return { x: (H[0] * p.x + H[1] * p.y + H[2]) / w, y: (H[3] * p.x + H[4] * p.y + H[5]) / w };
}

export function polygonArea(pts: Pt[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

export function isConvexQuad(c: Pt[]): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = c[i];
    const b = c[(i + 1) % 4];
    const d = c[(i + 2) % 4];
    const cross = (b.x - a.x) * (d.y - b.y) - (b.y - a.y) * (d.x - b.x);
    if (cross === 0) return false;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}
