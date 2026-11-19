/**
 * Synthetic test scenes: a wooden board with brownies of known area, rendered into a "photo" with a
 * perspective transform, uneven lighting, optional glare, noise and blur.
 */
import { cv, MatPool } from '../pipeline/cv';
import { polygonArea } from '../pipeline/geometry';
import type { Pt, RGBAImage } from '../pipeline/types';

export interface SynthOptions {
  seed: number;
  /** 0 = straight down, 1 = quite oblique. */
  tilt?: number;
  /** Make the biggest piece exactly this much bigger than the runner-up (0.1 = 10%). */
  winnerMargin?: number;
  /** Cut pieces in rows from one slab so neighbours touch, separated only by a thin dark crease. */
  touching?: boolean;
  glare?: boolean;
  noise?: number;
  cols?: number;
  rows?: number;
}

export interface SynthScene {
  photo: RGBAImage;
  /** Board corners in the photo: TL, TR, BR, BL. */
  corners: Pt[];
  /** Top-down ground-truth labels (boardW × boardH), 0 = board. */
  gtLabels: Int32Array;
  /** gtAreas[label] = pixel area in the top-down board. Index 0 unused. */
  gtAreas: number[];
  boardW: number;
  boardH: number;
  /** Label of the true biggest piece. */
  biggest: number;
}

export function rng(seed: number) {
  let a = seed >>> 0 || 1;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const range = (lo: number, hi: number) => lo + (hi - lo) * next();
  const gauss = () => Math.sqrt(-2 * Math.log(next() + 1e-12)) * Math.cos(2 * Math.PI * next());
  return { next, range, gauss };
}

const BOARD_W = 640;
const BOARD_H = 480;
const WOOD: [number, number, number] = [196, 150, 104];
const BROWNIE: [number, number, number] = [74, 45, 31];
const CREASE: [number, number, number] = [38, 22, 15];

function rotRect(cx: number, cy: number, w: number, h: number, ang: number, jitter: () => number): Pt[] {
  const c = Math.cos(ang), s = Math.sin(ang);
  return [
    [-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2],
  ].map(([x, y]) => ({ x: cx + x * c - y * s + jitter(), y: cy + x * s + y * c + jitter() }));
}

function scalePoly(p: Pt[], f: number): Pt[] {
  const cx = p.reduce((a, q) => a + q.x, 0) / p.length;
  const cy = p.reduce((a, q) => a + q.y, 0) / p.length;
  return p.map((q) => ({ x: cx + (q.x - cx) * f, y: cy + (q.y - cy) * f }));
}

function layoutSeparate(r: ReturnType<typeof rng>, cols: number, rows: number, margin: number): Pt[][] {
  const cw = (BOARD_W - 40) / cols;
  const chh = (BOARD_H - 40) / rows;
  const polys: Pt[][] = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const w = cw * r.range(0.5, 0.78);
      const h = chh * r.range(0.5, 0.78);
      const cx = 20 + cw * (i + 0.5) + r.range(-0.06, 0.06) * cw;
      const cy = 20 + chh * (j + 0.5) + r.range(-0.06, 0.06) * chh;
      polys.push(rotRect(cx, cy, w, h, r.range(-0.15, 0.15), () => r.range(-3, 3)));
    }
  }
  // Force a known winner margin by scaling piece 0 relative to the current largest of the rest.
  const maxOther = Math.max(...polys.slice(1).map(polygonArea));
  polys[0] = scalePoly(polys[0], Math.sqrt(((1 + margin) * maxOther) / polygonArea(polys[0])));
  return polys;
}

/** Rows cut from a slab: neighbours share a slanted cut line (drawn later as a thin dark crease). */
function layoutTouching(r: ReturnType<typeof rng>, cols: number, rows: number): { polys: Pt[][]; cuts: [Pt, Pt][] } {
  const polys: Pt[][] = [];
  const cuts: [Pt, Pt][] = [];
  const rowH = (BOARD_H - 80) / rows;
  for (let j = 0; j < rows; j++) {
    const y0 = 40 + j * rowH + 10;
    const y1 = 40 + (j + 1) * rowH - 10;
    const x0 = 50 + r.range(-10, 10);
    const x1 = BOARD_W - 50 + r.range(-10, 10);
    // Uneven cut positions; each cut slightly slanted.
    const xs: [number, number][] = [[x0, x0]];
    for (let i = 1; i < cols; i++) {
      const base = x0 + ((x1 - x0) * i) / cols + r.range(-0.22, 0.22) * ((x1 - x0) / cols);
      const slant = r.range(-8, 8);
      xs.push([base - slant, base + slant]);
      cuts.push([{ x: base - slant, y: y0 }, { x: base + slant, y: y1 }]);
    }
    xs.push([x1, x1]);
    for (let i = 0; i < cols; i++) {
      polys.push([
        { x: xs[i][0], y: y0 }, { x: xs[i + 1][0], y: y0 },
        { x: xs[i + 1][1], y: y1 }, { x: xs[i][1], y: y1 },
      ]);
    }
  }
  return { polys, cuts };
}

function ptsMat(p: Pt[]) {
  return cv.matFromArray(p.length, 1, cv.CV_32SC2, p.flatMap((q) => [Math.round(q.x), Math.round(q.y)]));
}

export function makeScene(opt: SynthOptions): SynthScene {
  const r = rng(opt.seed);
  const tilt = opt.tilt ?? 0.4;
  const noise = opt.noise ?? 6;
  const cols = opt.cols ?? (opt.touching ? 4 : 4);
  const rows = opt.rows ?? (opt.touching ? 2 : 3);
  const pool = new MatPool();
  try {
    // --- Top-down board -------------------------------------------------------------------
    let polys: Pt[][];
    let cuts: [Pt, Pt][] = [];
    if (opt.touching) ({ polys, cuts } = layoutTouching(r, cols, rows));
    else polys = layoutSeparate(r, cols, rows, opt.winnerMargin ?? 0.12);

    const lab = pool.add(cv.Mat.zeros(BOARD_H, BOARD_W, cv.CV_8UC1));
    polys.forEach((p, k) => {
      const mv = pool.add(new cv.MatVector());
      const m = ptsMat(p);
      mv.push_back(m);
      m.delete();
      cv.fillPoly(lab, mv, new cv.Scalar(k + 1));
    });
    const creaseMask = pool.add(cv.Mat.zeros(BOARD_H, BOARD_W, cv.CV_8UC1));
    for (const [a, b] of cuts) cv.line(creaseMask, new cv.Point(Math.round(a.x), Math.round(a.y)), new cv.Point(Math.round(b.x), Math.round(b.y)), new cv.Scalar(255), 2);

    const ld = lab.data as Uint8Array;
    const cm = creaseMask.data as Uint8Array;
    const gtLabels = new Int32Array(BOARD_W * BOARD_H);
    const gtAreas = new Array(polys.length + 1).fill(0);
    const board = new Uint8ClampedArray(BOARD_W * BOARD_H * 4);
    const phase = r.range(0, 10);
    for (let y = 0; y < BOARD_H; y++) {
      for (let x = 0; x < BOARD_W; x++) {
        const i = y * BOARD_W + x;
        let col: [number, number, number];
        let n: number;
        if (cm[i] && ld[i]) {
          col = CREASE;
          n = r.gauss() * 4;
        } else if (ld[i]) {
          gtLabels[i] = ld[i];
          gtAreas[ld[i]]++;
          col = BROWNIE;
          n = r.gauss() * 7 + (r.next() < 0.02 ? 35 : 0); // texture + light crumbs
        } else {
          col = WOOD;
          const grain = 0.08 * Math.sin(y * 0.18 + 2.5 * Math.sin(x * 0.012 + phase)) + 0.03 * Math.sin(y * 0.9);
          n = col[1] * grain + r.gauss() * 3;
        }
        board[i * 4] = col[0] + n;
        board[i * 4 + 1] = col[1] + n * 0.75;
        board[i * 4 + 2] = col[2] + n * 0.55;
        board[i * 4 + 3] = 255;
      }
    }
    // Crease pixels belong to no piece: split them between the two neighbours for ground truth.
    for (let i = 0; i < gtLabels.length; i++) {
      if (cm[i] && ld[i]) {
        gtLabels[i] = ld[i];
        gtAreas[ld[i]]++;
      }
    }

    // --- Photo: perspective + lighting + glare + noise --------------------------------------
    const PW = 1200, PH = 900;
    const bw = 820, bh = 615;
    const cx = PW / 2 + r.range(-40, 40), cy = PH / 2 + r.range(-30, 30);
    const shrink = 1 - 0.38 * tilt; // far edge appears shorter
    const squash = 1 - 0.3 * tilt; // and the board appears less tall
    let quad: Pt[] = [
      { x: -bw / 2 * shrink, y: -bh / 2 * squash }, { x: bw / 2 * shrink, y: -bh / 2 * squash },
      { x: bw / 2, y: bh / 2 * squash }, { x: -bw / 2, y: bh / 2 * squash },
    ];
    const ang = r.range(-0.12, 0.12);
    quad = quad.map((p) => ({
      x: cx + p.x * Math.cos(ang) - p.y * Math.sin(ang) + r.range(-15, 15),
      y: cy + p.x * Math.sin(ang) + p.y * Math.cos(ang) + r.range(-15, 15),
    }));

    const srcPts = pool.add(cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, BOARD_W - 1, 0, BOARD_W - 1, BOARD_H - 1, 0, BOARD_H - 1]));
    const dstPts = pool.add(cv.matFromArray(4, 1, cv.CV_32FC2, quad.flatMap((p) => [p.x, p.y])));
    const M = pool.add(cv.getPerspectiveTransform(srcPts, dstPts));
    const boardMat = pool.add(cv.matFromImageData({ data: board, width: BOARD_W, height: BOARD_H }));
    const warped = pool.add(new cv.Mat());
    cv.warpPerspective(boardMat, warped, M, new cv.Size(PW, PH), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(0, 0, 0, 0));

    const glareAt = opt.glare ? { x: r.range(0.3, 0.7) * PW, y: r.range(0.3, 0.7) * PH } : null;
    const lightDir = r.range(0, Math.PI * 2);
    const out = new Uint8ClampedArray(PW * PH * 4);
    const wd = warped.data as Uint8Array;
    for (let y = 0; y < PH; y++) {
      for (let x = 0; x < PW; x++) {
        const i = (y * PW + x) * 4;
        const a = wd[i + 3] / 255;
        const light = 0.82 + 0.22 * (((x - PW / 2) * Math.cos(lightDir) + (y - PH / 2) * Math.sin(lightDir)) / PW + 0.5);
        let glare = 0;
        if (glareAt) {
          const d2 = (x - glareAt.x) ** 2 + (y - glareAt.y) ** 2;
          glare = 170 * Math.exp(-d2 / (2 * 22 * 22));
        }
        const table = [70, 72, 80];
        for (let c = 0; c < 3; c++) {
          const v = (a * wd[i + c] + (1 - a) * table[c]) * light + glare + r.gauss() * noise;
          out[i + c] = v;
        }
        out[i + 3] = 255;
      }
    }
    const photoMat = pool.add(cv.matFromImageData({ data: out, width: PW, height: PH }));
    cv.GaussianBlur(photoMat, photoMat, new cv.Size(3, 3), 0);

    let biggest = 1;
    for (let k = 2; k < gtAreas.length; k++) if (gtAreas[k] > gtAreas[biggest]) biggest = k;

    return {
      photo: { data: new Uint8ClampedArray(photoMat.data), width: PW, height: PH },
      corners: quad,
      gtLabels,
      gtAreas,
      boardW: BOARD_W,
      boardH: BOARD_H,
      biggest,
    };
  } finally {
    pool.free();
  }
}

export interface Evaluation {
  /** Pred piece id -> GT label (0 = no match). */
  matches: Map<number, number>;
  missed: number[];
  spurious: number;
  duplicates: number;
  /** Relative error of each matched piece's share of total area. */
  shareErrors: number[];
  /** Same errors keyed by predicted piece id. */
  errById: Map<number, number>;
  medianErr: number;
  maxErr: number;
  predictedBiggest: number;
}

/**
 * Compares predicted pieces (warped coordinates) against ground truth. The warped view of the board
 * is an axis-aligned scaling of the top-down board, so centroids map back by simple scaling.
 */
export function evaluate(
  scene: SynthScene,
  pieces: { id: number; area: number; centroid: Pt }[],
  warpW: number,
  warpH: number,
): Evaluation {
  const matches = new Map<number, number>();
  const used = new Map<number, number>();
  for (const p of pieces) {
    const bx = Math.round((p.centroid.x / (warpW - 1)) * (scene.boardW - 1));
    const by = Math.round((p.centroid.y / (warpH - 1)) * (scene.boardH - 1));
    let gt = 0;
    for (let r = 0; r <= 6 && !gt; r++) {
      for (let dy = -r; dy <= r && !gt; dy++) {
        for (let dx = -r; dx <= r && !gt; dx++) {
          const x = bx + dx, y = by + dy;
          if (x >= 0 && y >= 0 && x < scene.boardW && y < scene.boardH) gt = scene.gtLabels[y * scene.boardW + x];
        }
      }
    }
    matches.set(p.id, gt);
    if (gt) used.set(gt, (used.get(gt) ?? 0) + 1);
  }
  const nGt = scene.gtAreas.length - 1;
  const missed: number[] = [];
  for (let k = 1; k <= nGt; k++) if (!used.has(k)) missed.push(k);
  let duplicates = 0;
  for (const n of used.values()) if (n > 1) duplicates += n - 1;
  const spurious = [...matches.values()].filter((g) => !g).length;

  const good = pieces.filter((p) => matches.get(p.id) && used.get(matches.get(p.id)!) === 1);
  const predTotal = good.reduce((s, p) => s + p.area, 0);
  const gtTotal = good.reduce((s, p) => s + scene.gtAreas[matches.get(p.id)!], 0);
  const shareErrors = good.map((p) => Math.abs(p.area / predTotal / (scene.gtAreas[matches.get(p.id)!] / gtTotal) - 1));
  const errById = new Map(good.map((p, i) => [p.id, shareErrors[i]]));
  const sorted = [...shareErrors].sort((a, b) => a - b);
  const top = [...pieces].sort((a, b) => b.area - a.area)[0];
  return {
    matches,
    missed,
    spurious,
    duplicates,
    shareErrors,
    errById,
    medianErr: sorted.length ? sorted[sorted.length >> 1] : NaN,
    maxErr: sorted.length ? sorted[sorted.length - 1] : NaN,
    predictedBiggest: top ? matches.get(top.id) ?? 0 : 0,
  };
}
