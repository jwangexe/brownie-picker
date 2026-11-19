import { cv, MatPool } from './cv';
import { fillHoles } from './segment';
import type { Pt, RGBAImage } from './types';

/** Blurred Lab image, computed once per warp and reused for every tap. */
export function labImage(img: RGBAImage): Uint8Array {
  const pool = new MatPool();
  try {
    const rgba = pool.add(cv.matFromImageData(img));
    const rgb = pool.add(new cv.Mat());
    cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);
    cv.GaussianBlur(rgb, rgb, new cv.Size(5, 5), 0);
    const lab = pool.add(new cv.Mat());
    cv.cvtColor(rgb, lab, cv.COLOR_RGB2Lab);
    return new Uint8Array(lab.data);
  } finally {
    pool.free();
  }
}

export interface TapOptions {
  /** Lab colour distance tolerance for the flood fill. */
  tolerance: number;
  /** Refine the flood-fill region with GrabCut (slower, follows real edges better). */
  grabCut: boolean;
}

export const DEFAULT_TAP: TapOptions = { tolerance: 22, grabCut: true };

/**
 * Segments one brownie from a tap. Flood fill in Lab colour space from the seed (never entering
 * already-labelled pixels), then GrabCut in a padded box around it. Returns a 0/1 mask over the
 * whole image, or null if nothing sensible was found.
 */
export function tapSelect(
  img: RGBAImage,
  lab: Uint8Array,
  labels: Int32Array,
  seed: Pt,
  opt: TapOptions = DEFAULT_TAP,
): Uint8Array | null {
  const W = img.width;
  const H = img.height;
  const N = W * H;
  const sx = Math.round(seed.x);
  const sy = Math.round(seed.y);
  if (sx < 0 || sy < 0 || sx >= W || sy >= H || labels[sy * W + sx]) return null;

  // Seed colour = mean over a small unlabelled patch.
  let mL = 0, mA = 0, mB = 0, n = 0;
  for (let dy = -3; dy <= 3; dy++) {
    for (let dx = -3; dx <= 3; dx++) {
      const x = sx + dx, y = sy + dy;
      if (x < 0 || y < 0 || x >= W || y >= H || labels[y * W + x]) continue;
      const k = (y * W + x) * 3;
      mL += lab[k]; mA += lab[k + 1]; mB += lab[k + 2]; n++;
    }
  }
  mL /= n; mA /= n; mB /= n;

  // Flood fill (4-connected BFS).
  const tol2 = opt.tolerance * opt.tolerance;
  const flood = new Uint8Array(N);
  const queue = new Int32Array(N);
  let qh = 0, qt = 0;
  const maxArea = 0.35 * N;
  flood[sy * W + sx] = 1;
  queue[qt++] = sy * W + sx;
  while (qh < qt) {
    const i = queue[qh++];
    const x = i % W;
    const nb = [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i - W, i + W];
    for (const j of nb) {
      if (j < 0 || j >= N || flood[j] || labels[j]) continue;
      const k = j * 3;
      const d = (lab[k] - mL) ** 2 + (lab[k + 1] - mA) ** 2 + (lab[k + 2] - mB) ** 2;
      if (d <= tol2) {
        flood[j] = 1;
        queue[qt++] = j;
      }
    }
    if (qt > maxArea) return null; // leaked into the board: tolerance too high
  }

  // A tiny flood (very textured top) still gives GrabCut a seed disc to work from.
  if (qt < 150) {
    for (let dy = -12; dy <= 12; dy++) {
      for (let dx = -12; dx <= 12; dx++) {
        const x = sx + dx, y = sy + dy;
        if (dx * dx + dy * dy <= 144 && x >= 0 && y >= 0 && x < W && y < H && !labels[y * W + x]) flood[y * W + x] = 1;
      }
    }
  }

  const pool = new MatPool();
  try {
    // Clean up the flood region.
    let m = pool.add(new cv.Mat(H, W, cv.CV_8UC1));
    const md = m.data as Uint8Array;
    for (let i = 0; i < N; i++) md[i] = flood[i] ? 255 : 0;
    const k5 = pool.add(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5, 5)));
    cv.morphologyEx(m, m, cv.MORPH_CLOSE, k5);
    cv.morphologyEx(m, m, cv.MORPH_OPEN, k5);
    m = fillHoles(m, pool);
    let region = keepComponentAt(m, sx, sy, pool);
    if (!region) return null;
    const floodArea = count(region);

    if (opt.grabCut) {
      const refined = grabCutRefine(img, labels, region, sx, sy, pool);
      if (refined) {
        const a = count(refined);
        // Accept only if GrabCut agrees roughly with the flood fill; otherwise it probably ran off.
        if (a > 0.5 * floodArea && a < 2.5 * floodArea) region = refined;
      }
    }
    for (let i = 0; i < N; i++) if (labels[i]) region[i] = 0;
    return count(region) > 50 ? region : null;
  } finally {
    pool.free();
  }
}

function count(a: Uint8Array) {
  let n = 0;
  for (let i = 0; i < a.length; i++) n += a[i];
  return n;
}

/** Returns a 0/1 mask of the 8-connected component containing (x, y), or of the largest one. */
function keepComponentAt(mask: any, x: number, y: number, pool: MatPool): Uint8Array | null {
  const cc = pool.add(new cv.Mat());
  const n = cv.connectedComponents(mask, cc, 8, cv.CV_32S) as number;
  if (n < 2) return null;
  const d = cc.data32S as Int32Array;
  let target = d[y * mask.cols + x];
  if (!target) {
    const counts = new Int32Array(n);
    for (let i = 0; i < d.length; i++) counts[d[i]]++;
    target = 1;
    for (let l = 2; l < n; l++) if (counts[l] > counts[target]) target = l;
  }
  const out = new Uint8Array(d.length);
  for (let i = 0; i < d.length; i++) out[i] = d[i] === target ? 1 : 0;
  return out;
}

function grabCutRefine(
  img: RGBAImage,
  labels: Int32Array,
  region: Uint8Array,
  sx: number,
  sy: number,
  pool: MatPool,
): Uint8Array | null {
  const W = img.width;
  const H = img.height;
  let x0 = W, y0 = H, x1 = 0, y1 = 0;
  for (let y = 0, i = 0; y < H; y++) {
    for (let x = 0; x < W; x++, i++) {
      if (!region[i]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  const pad = Math.max(12, Math.round(0.3 * Math.max(x1 - x0, y1 - y0)));
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
  x1 = Math.min(W - 1, x1 + pad); y1 = Math.min(H - 1, y1 + pad);
  const cw = x1 - x0 + 1;
  const chh = y1 - y0 + 1;

  const rgba = pool.add(cv.matFromImageData(img));
  const roi = pool.add(rgba.roi(new cv.Rect(x0, y0, cw, chh)));
  const rgb = pool.add(new cv.Mat());
  cv.cvtColor(roi, rgb, cv.COLOR_RGBA2RGB);

  // Mask init: probable background everywhere, probable foreground on the flood region, sure
  // foreground on its eroded core, sure background on the crop border and other pieces.
  const gc = pool.add(new cv.Mat(chh, cw, cv.CV_8UC1, new cv.Scalar(cv.GC_PR_BGD)));
  const core = pool.add(new cv.Mat(chh, cw, cv.CV_8UC1));
  const gd = gc.data as Uint8Array;
  const cdd = core.data as Uint8Array;
  for (let y = 0; y < chh; y++) {
    for (let x = 0; x < cw; x++) {
      const i = (y + y0) * W + (x + x0);
      cdd[y * cw + x] = region[i] ? 255 : 0;
      if (region[i]) gd[y * cw + x] = cv.GC_PR_FGD;
      if (labels[i]) gd[y * cw + x] = cv.GC_BGD;
    }
  }
  const k = pool.add(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(9, 9)));
  cv.erode(core, core, k);
  for (let i = 0; i < cw * chh; i++) if (cdd[i]) gd[i] = cv.GC_FGD;
  gd[(sy - y0) * cw + (sx - x0)] = cv.GC_FGD;
  for (let x = 0; x < cw; x++) { if (y0 > 0) gd[x] = cv.GC_BGD; if (y1 < H - 1) gd[(chh - 1) * cw + x] = cv.GC_BGD; }
  for (let y = 0; y < chh; y++) { if (x0 > 0) gd[y * cw] = cv.GC_BGD; if (x1 < W - 1) gd[y * cw + cw - 1] = cv.GC_BGD; }

  const bgd = pool.add(new cv.Mat());
  const fgd = pool.add(new cv.Mat());
  try {
    cv.grabCut(rgb, gc, new cv.Rect(0, 0, cw, chh), bgd, fgd, 3, cv.GC_INIT_WITH_MASK);
  } catch {
    return null;
  }

  const fgm = pool.add(cv.Mat.zeros(chh, cw, cv.CV_8UC1));
  const fdd = fgm.data as Uint8Array;
  for (let i = 0; i < cw * chh; i++) if (gd[i] === cv.GC_FGD || gd[i] === cv.GC_PR_FGD) fdd[i] = 255;
  const k5 = pool.add(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5, 5)));
  cv.morphologyEx(fgm, fgm, cv.MORPH_OPEN, k5);
  const filled = fillHoles(fgm, pool);
  const local = keepComponentAt(filled, sx - x0, sy - y0, pool);
  if (!local) return null;
  const out = new Uint8Array(W * H);
  for (let y = 0; y < chh; y++) for (let x = 0; x < cw; x++) out[(y + y0) * W + x + x0] = local[y * cw + x];
  return out;
}
