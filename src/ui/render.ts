import type { Board } from '../pipeline/board';
import type { FaceKind } from '../pipeline/cuboid';
import type { Pt, Ranking, RankedPiece, RGBAImage } from '../pipeline/types';

export const GOLD = '#ffc83d';
export const SILVER = '#cfd8e3';
const WARN = '#ff8a7a';

export function flagText(p: RankedPiece): string {
  return p.flag === 'two' ? '×2?' : p.flag === 'fragment' ? 'bit?' : p.flag === 'shape' ? 'shape?' : '';
}

/** Face tints: top = crust (measured), front / side = cut faces (not measured). */
export const FACE_COLOURS: Record<FaceKind, string> = {
  top: 'rgba(255,200,61,0.34)',
  front: 'rgba(70,150,255,0.42)',
  side: 'rgba(190,90,255,0.42)',
};

/**
 * Draws the photo with every piece's fitted box mapped back from the top-down view with the
 * inverse homography: the top face (what is measured) outlined in gold for the winner, silver for
 * the runner-up, red for flagged pieces. With `faces`, every box's faces are tinted: top, front
 * and side. Pieces too small for a box fall back to their pixel outline. Seeds are small dots;
 * suggested seeds are hollow "+" rings.
 */
export function drawResult(
  canvas: HTMLCanvasElement,
  photo: CanvasImageSource & { width: number; height: number },
  board: Board,
  opts: { faces?: boolean } = {},
) {
  const ranking = board.ranking;
  const ctx = canvas.getContext('2d')!;
  const s = canvas.width / photo.width;
  const ui = Math.max(1, canvas.width / 700);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(photo, 0, 0, canvas.width, canvas.height);
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

  const path = (pts: Pt[]) => {
    ctx.beginPath();
    pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
    ctx.closePath();
  };
  const photoPts = (pts: Pt[]) => pts.map((q) => board.toPhoto(q));

  // Far pieces first, so nearer boxes paint over what they hide.
  const depth = (p: RankedPiece) => (p.box ? Math.max(...p.box.outline.map((q) => q.y)) : p.centroid.y);
  const byDepth = [...ranking.pieces].sort((a, b) => depth(a) - depth(b));
  for (const p of byDepth) {
    const isW = p === ranking.winner;
    const isR = p === ranking.runnerUp;
    const isC = p === ranking.check;
    const stroke = isW ? GOLD : isR ? SILVER : p.flag ? WARN : 'rgba(150,215,255,0.9)';
    const width = px(isW || isC ? 4 : isR ? 3 : 1.8);
    ctx.lineJoin = 'round';
    if (!p.box) {
      const pts = photoPts(p.contour);
      if (pts.length < 3) continue;
      path(pts);
      ctx.fillStyle = p.flag ? 'rgba(255,120,100,0.20)' : 'rgba(120,200,255,0.14)';
      ctx.fill();
      ctx.strokeStyle = stroke;
      ctx.lineWidth = width;
      ctx.stroke();
      continue;
    }
    // Side faces first (thin edges), then the top on top of them.
    const [topFace, ...sides] = p.box.faces;
    for (const f of sides) {
      path(photoPts(f.poly));
      if (opts.faces) {
        ctx.fillStyle = FACE_COLOURS[f.kind];
        ctx.fill();
      }
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = px(1);
      ctx.stroke();
    }
    path(photoPts(topFace.poly));
    ctx.fillStyle = opts.faces
      ? FACE_COLOURS.top
      : isW ? 'rgba(255,200,61,0.30)' : isR ? 'rgba(207,216,227,0.22)' : p.flag ? 'rgba(255,120,100,0.20)' : 'rgba(120,200,255,0.14)';
    ctx.fill();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = width;
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
  for (const p of [...ranking.pieces].reverse()) {
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
        detail: `${r.flagged} of ${n} pieces look wrong. On a “×2?” piece, tap its other half to split it; on a “bit?” piece, tap its dot to remove it. “shape?” pieces don’t fit a box (leaning or broken).`,
        tone: 'warn',
      };
    case 'check': {
      const c = r.check!;
      if (c.flag === 'shape') {
        return {
          title: `Check #${c.rank}: not a clean block`,
          detail: `#${c.rank} looks biggest, but its top doesn't fit a box (leaning, broken or stacked?), so its size is a guess.${flaggedNote}`,
          tone: 'warn',
        };
      }
      if (c.flag === 'fragment') {
        return { title: `Check #${c.rank}`, detail: `#${c.rank} looks like a fragment.${flaggedNote}`, tone: 'warn' };
      }
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
    ['top-face pixels (white) vs side-face pixels (grey); boxes are fitted to the white', grayToCanvas(topVis, W, H)],
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
