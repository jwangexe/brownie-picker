// Dev-only page: runs the pipeline over test-images/ and shows the results in a grid.
import { detectBoard } from './pipeline/autocorners';
import { DEFAULT_PARAMS } from './pipeline/segment';
import type { Pt, RGBAImage } from './pipeline/types';
import { CornerEditor } from './ui/cornerEditor';
import { loadOpenCV } from './ui/loadOpenCV';
import { drawResult, grayToCanvas, imageToCanvas, labelsToCanvas, pieceWarning, verdict } from './ui/render';
import { BoardSession } from './ui/session';

const images = import.meta.glob('/test-images/**/*.{jpg,jpeg,png,webp,JPG,JPEG,PNG}', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;
const sidecars = import.meta.glob('/test-images/**/*.corners.json', { eager: true, import: 'default' }) as Record<
  string,
  { corners: Pt[] }
>;
const truths = import.meta.glob('/test-images/**/*.truth.json', { eager: true, import: 'default' }) as Record<
  string,
  { biggest: number; sharesPct: number[] }
>;

const grid = document.getElementById('grid')!;
const intro = document.getElementById('intro')!;

async function loadPhoto(url: string): Promise<{ canvas: HTMLCanvasElement; data: RGBAImage }> {
  const img = new Image();
  img.src = url;
  await img.decode();
  const s = Math.min(1, 1280 / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * s);
  c.height = Math.round(img.naturalHeight * s);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return { canvas: c, data: ctx.getImageData(0, 0, c.width, c.height) };
}

function fig(name: string, c: HTMLCanvasElement) {
  const f = document.createElement('figure');
  const cap = document.createElement('figcaption');
  cap.textContent = name;
  c.style.width = '100%';
  f.append(c, cap);
  return f;
}

async function runOne(path: string, url: string) {
  const base = path.replace(/\.[^.]+$/, '');
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `<h2>${path.replace('/test-images/', '')}</h2><div class="stats">Running…</div>`;
  grid.append(card);

  const { canvas: photo, data } = await loadPhoto(url);
  let corners: Pt[] | null = sidecars[`${base}.corners.json`]?.corners ?? null;
  let cornerSrc = corners ? 'sidecar' : 'auto-detected';
  corners ??= detectBoard(data);
  if (!corners) {
    cornerSrc = 'none found: whole image';
    corners = [{ x: 0, y: 0 }, { x: data.width - 1, y: 0 }, { x: data.width - 1, y: data.height - 1 }, { x: 0, y: data.height - 1 }];
  }

  const render = (cs: Pt[]) => {
    const t0 = performance.now();
    const s = new BoardSession(data, cs, { ...DEFAULT_PARAMS });
    s.runAuto();
    const ms = performance.now() - t0;
    const out = document.createElement('canvas');
    out.width = photo.width;
    out.height = photo.height;
    drawResult(out, photo, s.ranking, s.warp.Hinv, s.warp.corners);
    const v = verdict(s.ranking);
    const truth = truths[`${base}.truth.json`];
    let truthLine = '';
    if (truth) {
      const top = truth.sharesPct.indexOf(Math.max(...truth.sharesPct));
      // Ground truth piece order differs from ranking; compare by top share only.
      const predTop = s.ranking.winner ? (s.ranking.winner.area / s.ranking.pieces.reduce((a, p) => a + p.area, 0)) * 100 : 0;
      truthLine = `<br>Ground truth: ${truth.sharesPct.length} pieces, biggest share ${truth.sharesPct[top].toFixed(2)}% · measured ${predTop.toFixed(2)}% <span class="${Math.abs(predTop - truth.sharesPct[top]) / truth.sharesPct[top] < 0.05 ? 'ok' : 'bad'}">(${(((predTop - truth.sharesPct[top]) / truth.sharesPct[top]) * 100).toFixed(1)}%)</span>`;
    }
    const rows = s.ranking.pieces
      .map((p) => `<tr><td>#${p.rank}</td><td>${p.area}</td><td>${p.pctOfMean.toFixed(1)}%</td><td>${p.solidity.toFixed(2)}</td><td>${pieceWarning(p)}</td></tr>`)
      .join('');
    const stats = document.createElement('div');
    stats.className = 'stats';
    stats.innerHTML = `<span class="win">${v.title}</span><br>${v.detail}<br>Corners: ${cornerSrc} · ${Math.round(ms)} ms · darkness cutoff ${s.debug?.valMaxUsed}${truthLine}
      <details><summary>Pieces</summary><table><tr><th>rank</th><th>px</th><th>% mean</th><th>solidity</th><th></th></tr>${rows}</table></details>`;
    const imgs = document.createElement('div');
    imgs.className = 'imgs';
    imgs.append(
      fig('warped', imageToCanvas(s.warp.warped)),
      fig('pieces', labelsToCanvas(s.labels, s.warp.warped)),
      fig('mask', grayToCanvas(s.debug!.mask, s.W, s.H)),
      fig('distance', grayToCanvas(s.debug!.dist, s.W, s.H)),
    );
    return { out, stats, imgs };
  };

  const show = (cs: Pt[]) => {
    const { out, stats, imgs } = render(cs);
    const btns = document.createElement('div');
    btns.className = 'btns';
    const edit = document.createElement('button');
    edit.textContent = 'Edit corners';
    btns.append(edit);
    card.replaceChildren(card.firstElementChild!, out, stats, btns, imgs);
    edit.onclick = () => startEdit(cs);
  };

  const startEdit = (cs: Pt[]) => {
    const wrap = document.createElement('div');
    wrap.className = 'editor';
    wrap.style.aspectRatio = `${photo.width} / ${photo.height}`;
    const c = document.createElement('canvas');
    wrap.append(c);
    const btns = document.createElement('div');
    btns.className = 'btns';
    const save = document.createElement('button');
    save.className = 'primary';
    save.textContent = 'Save corners & re-run';
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    btns.append(save, cancel);
    card.replaceChildren(card.firstElementChild!, wrap, btns);
    const ed = new CornerEditor(c, photo);
    ed.layout();
    ed.setCorners(cs);
    cancel.onclick = () => (ed.destroy(), show(cs));
    save.onclick = async () => {
      if (ed.corners.length !== 4) return alert('Place 4 corners');
      const res = await fetch('/__save-corners', { method: 'POST', body: JSON.stringify({ image: path, corners: ed.corners }) });
      if (!res.ok) alert(`Save failed: ${await res.text()}`);
      ed.destroy();
      show(ed.corners);
    };
  };

  show(corners!);
}

(async () => {
  const entries = Object.entries(images);
  if (!entries.length) {
    intro.insertAdjacentHTML('beforeend', '<br><br><b>No images yet.</b> Add photos to <code>test-images/</code> or run <code>npm run synth</code>, then reload.');
    return;
  }
  intro.insertAdjacentHTML('beforeend', '<br><br><span id="ld">Loading OpenCV…</span>');
  await loadOpenCV((f) => (document.getElementById('ld')!.textContent = `Loading OpenCV ${Math.round(f * 100)}%`));
  document.getElementById('ld')!.textContent = `${entries.length} image(s)`;
  for (const [path, url] of entries.sort()) {
    try {
      await runOne(path, url);
    } catch (e) {
      grid.insertAdjacentHTML('beforeend', `<div class="card"><h2>${path}</h2><span class="bad">${e}</span></div>`);
    }
  }
})();
