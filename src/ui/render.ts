import type { Board } from '../pipeline/board';
import { cv, MatPool } from '../pipeline/cv';
import type { Pt, Ranking, RankedPiece, RGBAImage } from '../pipeline/types';

export const GOLD = '#ffc83d';
export const SILVER = '#cfd8e3';
const WARN = '#ff8a7a';

export function flagText(p: RankedPiece): string {
  return p.flag === 'two' ? '×2?' : p.flag === 'fragment' ? 'bit?' : '';
}

/**
 * Draws the photo with every piece outlined (mapped back from the top-down view with the inverse
 * homography): the winner in gold, runner-up in silver, flagged pieces in red. Seeds are small
 * dots; suggested seeds are hollow "+" rings. Optionally tints top faces / side faces.
 */
export function drawResult(
  canvas: HTMLCanvasElement,
  photo: CanvasImageSource & { width: number; height: number },
  board: Board,
  opts: { faces?: HTMLCanvasElement | null } = {},
) {
  const ranking = board.ranking;
  const ctx = canvas.getContext('2d')!;
  const s = canvas.width / photo.width;
  const ui = Math.max(1, canvas.width / 700);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(photo, 0, 0, canvas.width, canvas.height);
  if (opts.faces) ctx.drawImage(opts.faces, 0, 0, canvas.width, canvas.height);
  ctx.setTransform(s, 0, 0, s, 0, 0);
  const px = (v: number) => (v * ui) / s;

  // Board quad; everything outside it is dimmed (it is never measured).
  const c = board.warp.corners;
  ctx.beginPath();
  ctx.rect(0, 0, photo.width, photo.height);
  c.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fill('evenodd');
  ctx.beginPath();
  c.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
  ctx.setLineDash([px(6), px(6)]);
  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.lineWidth = px(1.5);
  ctx.stroke();
  ctx.setLineDash([]);

  const order = [...ranking.pieces].reverse();
  for (const p of order) {
    const pts = p.contour.map((q) => board.toPhoto(q));
    if (pts.length < 3) continue;
    ctx.beginPath();
    pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
    ctx.closePath();
    const isW = p === ranking.winner;
    const isR = p === ranking.runnerUp;
    const isC = p === ranking.check;
    if (!opts.faces) {
      ctx.fillStyle = isW ? 'rgba(255,200,61,0.30)' : isR ? 'rgba(207,216,227,0.22)' : p.flag ? 'rgba(255,120,100,0.20)' : 'rgba(120,200,255,0.14)';
      ctx.fill();
    }
    ctx.strokeStyle = isW ? GOLD : isR ? SILVER : p.flag ? WARN : 'rgba(150,215,255,0.9)';
    ctx.lineWidth = px(isW || isC ? 5 : isR ? 3.5 : 2);
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  // Seeds (taps) and proposals.
  for (const sd of board.seeds) {
    const q = board.toPhoto(sd);
    ctx.beginPath();
    ctx.arc(q.x, q.y, px(4), 0, Math.PI * 2);
    ctx.fillStyle = '#ff4fd8';
    ctx.fill();
    ctx.lineWidth = px(1.5);
    ctx.strokeStyle = '#fff';
    ctx.stroke();
  }
  for (const pr of board.proposals) {
    const q = board.toPhoto(pr);
    ctx.beginPath();
    ctx.arc(q.x, q.y, px(11), 0, Math.PI * 2);
    ctx.lineWidth = px(2.5);
    ctx.strokeStyle = '#fff';
    ctx.setLineDash([px(4), px(3)]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(q.x - px(5), q.y);
    ctx.lineTo(q.x + px(5), q.y);
    ctx.moveTo(q.x, q.y - px(5));
    ctx.lineTo(q.x, q.y + px(5));
    ctx.stroke();
  }

  // Rank badges, placed just above each piece's seed.
  for (const p of order) {
    const q = board.toPhoto(p.seed);
    const isW = p === ranking.winner;
    const isR = p === ranking.runnerUp;
    const f = flagText(p);
    const line1 = `${isW ? '👑 ' : ''}#${p.rank}`;
    const line2 = f ? `⚠ ${f}` : `${Math.round(p.pctOfMean)}%`;
    ctx.font = `700 ${px(isW ? 16 : 13)}px system-ui, sans-serif`;
    const w = Math.max(ctx.measureText(line1).width, ctx.measureText(line2).width) + px(12);
    const h = px(isW ? 40 : 34);
    const y = q.y - h / 2 - px(10);
    ctx.fillStyle = isW ? GOLD : isR ? SILVER : p.flag ? 'rgba(120,20,10,0.85)' : 'rgba(0,0,0,0.65)';
    roundRect(ctx, q.x - w / 2, y - h / 2, w, h, px(7));
    ctx.fill();
    ctx.fillStyle = isW || isR ? '#1a1206' : '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(line1, q.x, y - h / 4.2);
    ctx.font = `600 ${px(isW ? 13 : 11)}px system-ui, sans-serif`;
    ctx.fillText(line2, q.x, y + h / 4.2);
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
export function verdict(r: Ranking): { title: string; detail: string; tone: 'ok' | 'tie' | 'warn' } {
  const n = r.pieces.length;
  const flaggedNote = r.flagged ? ` ${r.flagged} piece${r.flagged > 1 ? 's' : ''} marked ⚠.` : '';
  switch (r.status) {
    case 'empty':
      return { title: 'Tap each brownie once', detail: 'One tap per piece, in its middle. Or press ✨ Suggest for proposed taps.', tone: 'ok' };
    case 'one':
      return { title: '1 brownie tapped', detail: 'Tap the others to compare.', tone: 'ok' };
    case 'broken':
      return {
        title: 'No winner: segmentation needs fixing',
        detail: `${r.flagged} of ${n} pieces look wrong. On a “×2?” piece, tap its other half to split it; on a “bit?” piece, tap its dot to remove it.`,
        tone: 'warn',
      };
    case 'check': {
      const c = r.check!;
      return {
        title: `Check #${c.rank}: might be two pieces`,
        detail: `#${c.rank} is ${c.ratioToMedian.toFixed(1)}× the typical piece. If it’s really two, tap its other half to split it.${flaggedNote}`,
        tone: 'warn',
      };
    }
    default: {
      const m = r.marginPct!;
      if (r.isTie) {
        return { title: '#1 and #2 are a tie', detail: `Only ${m.toFixed(1)}% apart, within measurement error. Pick either.${flaggedNote}`, tone: 'tie' };
      }
      return { title: `#1 is ~${Math.round(m)}% bigger than #2`, detail: `Take #1 (gold). ${n} brownies measured.${flaggedNote}`, tone: 'ok' };
    }
  }
}

// --- Debug images --------------------------------------------------------------------------

export function imageToCanvas(img: RGBAImage): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  return c;
}

export function grayToCanvas(g: ArrayLike<number>, W: number, H: number): HTMLCanvasElement {
  const d = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = g[i];
    d[i * 4 + 3] = 255;
  }
  return imageToCanvas({ data: d, width: W, height: H });
}

export function labelsToCanvas(labels: Int32Array, warped: RGBAImage, dots: Pt[] = []): HTMLCanvasElement {
  const { width: W, height: H } = warped;
  const d = new Uint8ClampedArray(warped.data);
  for (let i = 0; i < W * H; i++) {
    const l = labels[i];
    if (!l) continue;
    const [r, g, b] = hslToRgb(((l * 137.5) % 360) / 360, 0.75, 0.55);
    d[i * 4] = d[i * 4] * 0.4 + r * 0.6;
    d[i * 4 + 1] = d[i * 4 + 1] * 0.4 + g * 0.6;
    d[i * 4 + 2] = d[i * 4 + 2] * 0.4 + b * 0.6;
  }
  const c = imageToCanvas({ data: d, width: W, height: H });
  const ctx = c.getContext('2d')!;
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  for (const p of dots) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
    ctx.stroke();
  }
  return c;
}

/**
 * Top face (cyan) / side face (red) tint, warped back onto the photo so it lines up with the
 * original picture. Returns a transparent canvas the size of the photo.
 */
export function facesOverlay(board: Board, photoW: number, photoH: number): HTMLCanvasElement {
  const { W, H } = board;
  const ov = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    if (!board.labels[i]) continue;
    const t = board.top[i];
    ov[i * 4] = t ? 60 : 255;
    ov[i * 4 + 1] = t ? 220 : 60;
    ov[i * 4 + 2] = t ? 255 : 60;
    ov[i * 4 + 3] = t ? 95 : 150;
  }
  const pool = new MatPool();
  try {
    const src = pool.add(cv.matFromImageData({ data: ov, width: W, height: H }));
    const Hinv = pool.add(cv.matFromArray(3, 3, cv.CV_64F, board.warp.Hinv));
    const out = pool.add(new cv.Mat());
    cv.warpPerspective(src, out, Hinv, new cv.Size(photoW, photoH), cv.INTER_NEAREST, cv.BORDER_CONSTANT, new cv.Scalar(0, 0, 0, 0));
    return imageToCanvas({ data: new Uint8ClampedArray(out.data), width: photoW, height: photoH });
  } finally {
    pool.free();
  }
}

/** The debug panels shared by the app and the batch page. */
export function debugPanels(board: Board): [string, HTMLCanvasElement][] {
  const { W, H } = board;
  const gm = board.gapMap();
  const topVis = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) topVis[i] = board.labels[i] ? (board.top[i] ? 255 : 90) : 0;
  const items: [string, HTMLCanvasElement][] = [
    ['pieces (top-down; margin = outside the corners)', labelsToCanvas(board.labels, board.warp.warped, board.seeds)],
    ['gap map BEFORE filtering: cuts + cracks', grayToCanvas(gm.raw, W, H)],
    [`gap map AFTER: ${gm.segments.length} straight cut segments kept`, grayToCanvas(gm.gap, W, H)],
    ['measured: top face (white) vs side face (grey)', grayToCanvas(topVis, W, H)],
  ];
  if (board.background) items.push(['background marker (outside + dark cuts + pale)', grayToCanvas(board.background.map((v) => v * 255), W, H)]);
  if (board.suggestion) {
    items.push(['suggest: fragments before merge', labelsToCanvas(board.suggestion.fragments, board.warp.warped)]);
    items.push([`suggest: after merge → ${board.suggestion.seeds.length} proposals`, labelsToCanvas(board.suggestion.merged, board.warp.warped, board.suggestion.seeds)]);
  }
  return items;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return 255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
  };
  return [f(0), f(8), f(4)];
}
