import type { Pt } from './types';
import type { Rect } from './warp';

/**
 * Where the camera was, relative to the board, recovered from the corner quad.
 *
 * The four corners give the homography between the board plane and the photo. With a pinhole
 * camera of known focal length that homography fixes the camera's pose (Zhang's planar pose
 * recovery). The focal length isn't known, but every phone main camera is close to a 26 mm
 * equivalent lens, i.e. f ≈ 0.75 × the long side of the photo.
 *
 * "World" coordinates are the top-down (warped) view made isotropic: x = warped x, y = warped y ×
 * ay (the warp's output size doesn't preserve the board's true aspect ratio), z = height above the
 * board in the same units.
 *
 * Why it matters: a brownie is a box, not a flat shape. Its top face is `height` above the board,
 * so in the top-down view it appears pushed away from the point under the camera (C's footprint)
 * and slightly enlarged; the front / side faces show up as extra area in between. This pose is
 * only a starting guess for that point: users draw the quad around the brownies rather than along
 * an exact rectangle, so the cuboid fit re-estimates it from the brownies themselves.
 */
export interface Camera {
  /** Camera centre in world units. */
  C: [number, number, number];
  /** World y units per warped y pixel. */
  ay: number;
  focal: number;
  /** |cos| of the angle between the recovered board axes before they were made orthogonal (0 = a
   *  perfectly consistent rectangle). Large values mean rough corners or a wrong focal guess. */
  orthoErr: number;
  /** True when the pose couldn't be recovered and a generic 45° view is assumed instead. */
  fallback: boolean;
}

/** 35 mm-equivalent 26 mm lens: f / long side ≈ 26 / 34.6 (4:3 sensor). */
export const DEFAULT_FOCAL_FRAC = 0.75;

const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: number[]) => Math.hypot(a[0], a[1], a[2]);
const scale = (a: number[], s: number) => [a[0] * s, a[1] * s, a[2] * s];
const add = (a: number[], b: number[]) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/**
 * @param Hinv warped -> photo homography (row-major)
 */
export function estimateCamera(Hinv: ArrayLike<number>, photoW: number, photoH: number, inner: Rect, focalFrac = DEFAULT_FOCAL_FRAC): Camera {
  const f = focalFrac * Math.max(photoW, photoH);
  const cx = photoW / 2;
  const cy = photoH / 2;
  const h = Hinv;
  // M = K⁻¹ · Hinv, column by column.
  const col = (j: number) => [(h[j] - cx * h[6 + j]) / f, (h[3 + j] - cy * h[6 + j]) / f, h[6 + j]];
  let m1 = col(0);
  let m2 = col(1);
  let m3 = col(2);
  // The board must be in front of the camera (t_z > 0).
  if (m3[2] < 0) [m1, m2, m3] = [scale(m1, -1), scale(m2, -1), scale(m3, -1)];
  const n1 = norm(m1);
  const n2 = norm(m2);
  const fallback = (): Camera => {
    const w = inner.x1 - inner.x0;
    const hh = inner.y1 - inner.y0;
    return { C: [(inner.x0 + inner.x1) / 2, inner.y1 + 1.2 * hh + 0.3 * w, 1.2 * hh + 0.3 * w], ay: 1, focal: f, orthoErr: 1, fallback: true };
  };
  if (!(n1 > 0 && n2 > 0)) return fallback();
  let r1 = scale(m1, 1 / n1);
  let r2 = scale(m2, 1 / n2);
  const orthoErr = Math.abs(dot(r1, r2));
  // Symmetric orthogonalisation: rotate both axes equally towards 90°.
  const a = add(r1, r2);
  const b = sub(r1, r2);
  const an = scale(a, 1 / norm(a));
  const bn = scale(b, 1 / norm(b));
  r1 = scale(add(an, bn), Math.SQRT1_2);
  r2 = scale(sub(an, bn), Math.SQRT1_2);
  let r3 = cross(r1, r2);
  const t = scale(m3, 1 / n1);
  let C = [-dot(r1, t), -dot(r2, t), -dot(r3, t)];
  if (C[2] < 0) {
    r3 = scale(r3, -1);
    C = [C[0], C[1], -C[2]];
  }
  const ay = n2 / n1;
  const size = Math.max(inner.x1 - inner.x0, (inner.y1 - inner.y0) * ay);
  // Sanity: the camera must be above the board, not absurdly far, and the axes roughly consistent.
  if (!C.every(Number.isFinite) || C[2] < 0.1 * size || C[2] > 50 * size || orthoErr > 0.5 || ay < 0.2 || ay > 5) return fallback();
  return { C: C as [number, number, number], ay, focal: f, orthoErr, fallback: false };
}

export const toWorld = (cam: Camera, p: Pt): Pt => ({ x: p.x, y: p.y * cam.ay });
export const fromWorld = (cam: Camera, p: Pt): Pt => ({ x: p.x, y: p.y / cam.ay });
