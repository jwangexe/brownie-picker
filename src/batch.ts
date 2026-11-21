// Dev-only page: runs the tap-seeded pipeline over test-images/ and shows result + debug panels.
// Each photo's corners and taps come from NAME.taps.json; tap the photo to add/remove seeds, then
// "Save" writes the fixture back (this is how the cafe-01 regression fixture is maintained).
import { Board } from './pipeline/board';
import type { Pt, RGBAImage } from './pipeline/types';
import { inRect } from './pipeline/warp';
import { CornerEditor } from './ui/cornerEditor';
import { loadOpenCV } from './ui/loadOpenCV';
import { debugPanels, drawResult, flagText, verdict } from './ui/render';

interface Fixture {
  corners: Pt[];
  taps: Pt[];
}

const images = import.meta.glob('/test-images/**/*.{jpg,jpeg,png,webp,JPG,JPEG,PNG}', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;
const fixtures = import.meta.glob('/test-images/**/*.taps.json', { eager: true, import: 'default' }) as Record<string, Fixture>;

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

function button(label: string, primary = false) {
  const b = document.createElement('button');
  b.textContent = label;
  if (primary) b.className = 'primary';
  return b;
}

async function runOne(path: string, url: string) {
  const base = path.replace(/\.[^.]+$/, '');
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `<h2>${path.replace('/test-images/', '')}</h2><div class="stats">Running…</div>`;
  grid.append(card);
  const { canvas: photo, data } = await loadPhoto(url);
  const fx = fixtures[`${base}.taps.json`];
  if (!fx) {
    card.querySelector('.stats')!.innerHTML = 'No <code>.taps.json</code> yet: set corners to start.';
    const b = button('Set corners', true);
    card.append(b);
    b.onclick = () => editCorners([], []);
    return;
  }

  let board = new Board(data, fx.corners);
  board.setSeeds(fx.taps.map((p) => board.toWarped(p)));

  const show = () => {
    const out = document.createElement('canvas');
    out.width = photo.width;
    out.height = photo.height;
    drawResult(out, photo, board);
    const facesC = document.createElement('canvas');
    facesC.width = photo.width;
    facesC.height = photo.height;
    drawResult(facesC, photo, board, { faces: true });
    out.onclick = (e) => {
      const r = out.getBoundingClientRect();
      board.tapAt({ x: ((e.clientX - r.left) / r.width) * photo.width, y: ((e.clientY - r.top) / r.height) * photo.height });
      show();
    };
    const v = verdict(board.ranking);
    const rows = board.ranking.pieces
      .map((p) => `<tr><td>#${p.rank}</td><td>${Math.round(p.area)}</td><td>${p.box ? `${p.box.w.toFixed(0)}×${p.box.d.toFixed(0)}` : '–'}</td><td>${p.box ? p.box.iou.toFixed(2) : '–'}</td><td>${p.ratioToMedian.toFixed(2)}×</td><td>${flagText(p)}</td></tr>`)
      .join('');
    const stats = document.createElement('div');
    stats.className = 'stats';
    stats.innerHTML = `<span class="win">${v.title}</span><br>${v.detail}<br>${board.seeds.length} taps = ${board.pieces.length} pieces · ${Math.round(board.lastMs)} ms · foreshortening ${board.foreshortening.toFixed(2)}${board.tooShallow ? ' <span class="bad">(too shallow)</span>' : ''}
      <details><summary>Pieces</summary><table><tr><th>rank</th><th>top area</th><th>top w×d</th><th>box fit</th><th>× median</th><th></th></tr>${rows}</table></details>`;
    const btns = document.createElement('div');
    btns.className = 'btns';
    const save = button('Save taps', true);
    const sug = button('Suggest');
    const acc = button(`Accept ${board.proposals.length}`);
    const undo = button('Undo');
    const edit = button('Edit corners');
    btns.append(save, sug, acc, undo, edit);
    save.onclick = () => saveFixture(path, board.warp.corners, board.seeds.map((s) => board.toPhoto(s)));
    sug.onclick = () => (board.suggest(), show());
    acc.onclick = () => (board.acceptAll(), show());
    undo.onclick = () => (board.undo(), show());
    edit.onclick = () => editCorners(board.warp.corners, board.seeds.map((s) => board.toPhoto(s)));
    const imgs = document.createElement('div');
    imgs.className = 'imgs';
    imgs.append(fig('fitted boxes: top (gold) / front (blue) / side (purple)', facesC), ...debugPanels(board).map(([n, c]) => fig(n, c)));
    card.replaceChildren(card.firstElementChild!, out, stats, btns, imgs);
  };

  const editCorners = (cs: Pt[], taps: Pt[]) => {
    const wrap = document.createElement('div');
    wrap.className = 'editor';
    wrap.style.aspectRatio = `${photo.width} / ${photo.height}`;
    const c = document.createElement('canvas');
    wrap.append(c);
    const btns = document.createElement('div');
    btns.className = 'btns';
    const ok = button('Corners set', true);
    btns.append(ok);
    card.replaceChildren(card.firstElementChild!, wrap, btns);
    const ed = new CornerEditor(c, photo);
    ed.layout();
    ed.setCorners(cs);
    ok.onclick = () => {
      if (ed.corners.length !== 4) return alert('Place 4 corners');
      ed.destroy();
      board = new Board(data, ed.corners);
      const kept = taps.map((p) => board.toWarped(p)).filter((q) => inRect(board.warp.inner, q.x, q.y));
      board.setSeeds(kept);
      show();
    };
  };

  show();
}

async function saveFixture(path: string, corners: Pt[], taps: Pt[]) {
  const r = (p: Pt) => ({ x: Math.round(p.x), y: Math.round(p.y) });
  const res = await fetch('/__save-taps', { method: 'POST', body: JSON.stringify({ image: path, corners: corners.map(r), taps: taps.map(r) }) });
  alert(res.ok ? `Saved ${taps.length} taps` : `Save failed: ${await res.text()}`);
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
    if (path.includes('/out/') || path.includes('/attachments/')) continue;
    try {
      await runOne(path, url);
    } catch (e) {
      grid.insertAdjacentHTML('beforeend', `<div class="card"><h2>${path}</h2><span class="bad">${e}</span></div>`);
    }
  }
})();
