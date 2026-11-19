import { applyH } from '../pipeline/geometry';
import type { Ranking, RankedPiece, RGBAImage } from '../pipeline/types';

export const GOLD = '#ffc83d';
export const SILVER = '#cfd8e3';

/** Short warning text for a piece, or ''. */
export function pieceWarning(p: RankedPiece): string {
  if (p.nearGlare) return 'glare';
  if (p.touchesEdge) return 'cut off?';
  if (p.solidity < 0.85) return 'merged?';
  return '';
}

/**
 * Draws the photo with every piece outlined (mapped back from the top-down view with the inverse
 * homography), the winner in gold, the runner-up in silver, and % labels.
 */
export function drawResult(
  canvas: HTMLCanvasElement,
  photo: CanvasImageSource & { width: number; height: number },
  ranking: Ranking,
  Hinv: number[],
  corners?: { x: number; y: number }[],
) {
  const ctx = canvas.getContext('2d')!;
  const s = canvas.width / photo.width;
  const ui = Math.max(1, canvas.width / 700); // keep strokes/labels readable at any size
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(photo, 0, 0, canvas.width, canvas.height);
  ctx.setTransform(s, 0, 0, s, 0, 0);
  const px = (v: number) => (v * ui) / s; // screen-size units -> photo units

  if (corners) {
    ctx.beginPath();
    corners.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.setLineDash([px(6), px(6)]);
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = px(1.5);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Dim everything that isn't a piece slightly so outlines pop.
  const order = [...ranking.pieces].reverse(); // draw winner last (on top)
  for (const p of order) {
    const pts = p.contour.map((q) => applyH(Hinv, q));
    if (pts.length < 3) continue;
    ctx.beginPath();
    pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
    ctx.closePath();
    const isW = p === ranking.winner;
    const isR = p === ranking.runnerUp;
    ctx.fillStyle = isW ? 'rgba(255,200,61,0.28)' : isR ? 'rgba(207,216,227,0.22)' : 'rgba(120,200,255,0.14)';
    ctx.fill();
    ctx.strokeStyle = isW ? GOLD : isR ? SILVER : 'rgba(150,215,255,0.9)';
    ctx.lineWidth = px(isW ? 5 : isR ? 3.5 : 2);
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  for (const p of order) {
    const c = applyH(Hinv, p.centroid);
    const isW = p === ranking.winner;
    const isR = p === ranking.runnerUp;
    const warn = pieceWarning(p);
    const line1 = `#${p.rank}`;
    const line2 = `${Math.round(p.pctOfMean)}%${warn ? ' ⚠' : ''}`;
    ctx.font = `700 ${px(isW ? 17 : 14)}px system-ui, sans-serif`;
    const w = Math.max(ctx.measureText(line1).width, ctx.measureText(line2).width) + px(14);
    const h = px(isW ? 44 : 38);
    ctx.fillStyle = isW ? GOLD : isR ? SILVER : 'rgba(0,0,0,0.65)';
    roundRect(ctx, c.x - w / 2, c.y - h / 2, w, h, px(8));
    ctx.fill();
    ctx.fillStyle = isW || isR ? '#1a1206' : '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(isW ? `👑 ${line1}` : line1, c.x, c.y - h / 4.2);
    ctx.font = `600 ${px(isW ? 14 : 12)}px system-ui, sans-serif`;
    ctx.fillText(line2, c.x, c.y + h / 4.2);
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Plain-language verdict for the banner. */
export function verdict(r: Ranking): { title: string; detail: string } {
  const n = r.pieces.length;
  if (n === 0) return { title: 'No brownies found', detail: 'Tap each brownie to add it, or open Tuning and use “Sample brownie colour”.' };
  if (n === 1) return { title: 'Only one piece found', detail: 'Tap the other brownies to add them.' };
  const m = r.marginPct!;
  const warnTop = [r.winner!, r.runnerUp!].some((p) => pieceWarning(p));
  const caveat = warnTop ? ' Check the ⚠ pieces.' : '';
  if (r.isTie) {
    return {
      title: `#1 and #2 are basically a tie`,
      detail: `Only ${m.toFixed(1)}% apart, within measurement error. Pick either.${caveat}`,
    };
  }
  return {
    title: `Take #1 👑: ${m.toFixed(0)}% bigger than #2`,
    detail: `${n} pieces measured. #1 is ${Math.round(r.winner!.pctOfMean)}% of the average size.${caveat}`,
  };
}

// --- Debug images --------------------------------------------------------------------------

export function imageToCanvas(img: RGBAImage): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  return c;
}

export function grayToCanvas(g: Uint8Array, W: number, H: number): HTMLCanvasElement {
  const d = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = g[i];
    d[i * 4 + 3] = 255;
  }
  return imageToCanvas({ data: d, width: W, height: H });
}

export function labelsToCanvas(labels: Int32Array, warped: RGBAImage): HTMLCanvasElement {
  const { width: W, height: H } = warped;
  const d = new Uint8ClampedArray(warped.data);
  for (let i = 0; i < W * H; i++) {
    const l = labels[i];
    if (!l) continue;
    const hue = (l * 137.5) % 360;
    const [r, g, b] = hslToRgb(hue / 360, 0.75, 0.55);
    d[i * 4] = d[i * 4] * 0.35 + r * 0.65;
    d[i * 4 + 1] = d[i * 4 + 1] * 0.35 + g * 0.65;
    d[i * 4 + 2] = d[i * 4 + 2] * 0.35 + b * 0.65;
  }
  return imageToCanvas({ data: d, width: W, height: H });
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return 255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
  };
  return [f(0), f(8), f(4)];
}
