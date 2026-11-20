import './style.css';
import { detectBoard } from './pipeline/autocorners';
import { Board, DEFAULT_SENSITIVITY, MAX_FORESHORTENING } from './pipeline/board';
import { obliqueness, orderCorners, polygonArea } from './pipeline/geometry';
import type { RGBAImage } from './pipeline/types';
import { inRect } from './pipeline/warp';
import { CornerEditor } from './ui/cornerEditor';
import { loadOpenCV } from './ui/loadOpenCV';
import { debugPanels, drawResult, facesOverlay, verdict } from './ui/render';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------- persistent settings (per device; harmless if storage is unavailable) -------------
const store = {
  get<T>(k: string, fallback: T): T {
    try {
      const v = localStorage.getItem(k);
      return v ? { ...fallback, ...JSON.parse(v) } : fallback;
    } catch {
      return fallback;
    }
  },
  set(k: string, v: unknown) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* private mode */
    }
  },
};

let settings = store.get('bp.settings', { sensitivity: DEFAULT_SENSITIVITY });

// ---------- app state ----------------------------------------------------------------------
let photo: HTMLCanvasElement | null = null;
let photoData: RGBAImage | null = null;
let board: Board | null = null;
let editor: CornerEditor | null = null;
let cvReady = false;
let stream: MediaStream | null = null;

const MAX_PHOTO = 1280;

// ---------- OpenCV ---------------------------------------------------------------------------
const status = $('cv-status');
const cvPromise = loadOpenCV((f) => {
  if (!cvReady) status.textContent = `Loading vision engine ${Math.round(f * 100)}%`;
})
  .then(() => {
    cvReady = true;
    status.textContent = 'Ready';
    status.className = 'pill ready';
    setTimeout(() => (status.hidden = true), 1500);
    updateCornerUI();
  })
  .catch((e) => {
    status.textContent = 'Vision engine failed: reload';
    status.className = 'pill error';
    console.error(e);
  });

// ---------- screens --------------------------------------------------------------------------
type Screen = 'capture' | 'corners' | 'result';
function show(s: Screen) {
  for (const id of ['capture', 'corners', 'result']) $(`screen-${id}`).hidden = id !== s;
  $('sheet').hidden = true;
  $('debug-panel').hidden = s !== 'result' || !$<HTMLInputElement>('debug').checked;
  if (s === 'capture') startCamera();
  else stopCamera();
  requestAnimationFrame(() => {
    if (s === 'corners') editor?.layout();
    if (s === 'result') renderResult();
  });
}

function toast(msg: string, ms = 2600) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout((toast as any)._t);
  (toast as any)._t = setTimeout(() => (t.hidden = true), ms);
}

/** Lets the spinner paint before a blocking OpenCV call. */
async function busy<T>(el: HTMLElement, fn: () => T): Promise<T> {
  el.classList.add('busy');
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  try {
    return fn();
  } finally {
    el.classList.remove('busy');
  }
}

// ---------- 1. capture -----------------------------------------------------------------------
const video = $<HTMLVideoElement>('video');

async function startCamera() {
  if (stream) return;
  const msg = $('cam-msg');
  if (!navigator.mediaDevices?.getUserMedia) {
    msg.hidden = false;
    msg.textContent = window.isSecureContext
      ? 'No camera available here. Use “Photo” to pick a saved picture.'
      : 'The camera needs HTTPS. Open the https:// address (see README), or use “Photo” to pick a saved picture.';
    $<HTMLButtonElement>('shutter').disabled = true;
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } },
    });
    video.srcObject = stream;
    await video.play().catch(() => {});
    msg.hidden = true;
    $<HTMLButtonElement>('shutter').disabled = false;
  } catch (e) {
    msg.hidden = false;
    msg.textContent = `Camera unavailable (${(e as Error).name}). Use “Photo” to pick a saved picture.`;
    $<HTMLButtonElement>('shutter').disabled = true;
  }
}

function stopCamera() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  video.srcObject = null;
}

function setPhoto(src: CanvasImageSource, w: number, h: number) {
  const s = Math.min(1, MAX_PHOTO / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * s);
  c.height = Math.round(h * s);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(src, 0, 0, c.width, c.height);
  photo = c;
  photoData = ctx.getImageData(0, 0, c.width, c.height);
  board = null;
  openCorners();
}

$('shutter').addEventListener('click', () => {
  if (!video.videoWidth) return;
  setPhoto(video, video.videoWidth, video.videoHeight);
});

$<HTMLInputElement>('file').addEventListener('change', async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  (e.target as HTMLInputElement).value = '';
  if (!f) return;
  const img = new Image();
  img.src = URL.createObjectURL(f);
  try {
    await img.decode(); // browsers apply EXIF orientation when drawing
    setPhoto(img, img.naturalWidth, img.naturalHeight);
  } catch {
    toast('Could not open that image');
  } finally {
    URL.revokeObjectURL(img.src);
  }
});

// ---------- 2. corners (mandatory: nothing is measured until the user confirms them) -----------
function openCorners(keepCorners = false) {
  if (!photo) return;
  if (!editor) {
    editor = new CornerEditor($<HTMLCanvasElement>('corner-canvas'), photo);
    editor.onChange = updateCornerUI;
  } else editor.setPhoto(photo);
  if (!keepCorners) editor.setCorners([]);
  show('corners');
  updateCornerUI();
}

function autoCorners() {
  if (!cvReady || !photoData || !editor) return;
  const c = detectBoard(photoData);
  // A "board" covering nearly the whole photo is just the photo border: useless, so refuse it.
  if (c && polygonArea(c) < 0.85 * photoData.width * photoData.height) {
    editor.setCorners(c);
    toast('Suggested corners: check them and drag to fix.');
  } else toast('Couldn’t find the board. Tap its 4 corners.');
}

function updateCornerUI() {
  const n = editor?.corners.length ?? 0;
  const hint = $('corner-hint');
  hint.classList.remove('warn');
  $<HTMLButtonElement>('measure').disabled = n !== 4 || !cvReady;
  $<HTMLButtonElement>('auto-corners').disabled = !cvReady;
  if (n < 4) hint.textContent = `Tap the 4 corners of the board (${n}/4). Only what’s inside is measured.`;
  else if (!cvReady) hint.textContent = 'Corners placed. Waiting for the vision engine…';
  else {
    const ob = obliqueness(orderCorners(editor!.corners));
    if (ob > MAX_FORESHORTENING) {
      hint.textContent = `Angle too shallow (near edge ${ob.toFixed(1)}× the far edge): sizes won’t be accurate. Retake from higher up.`;
      hint.classList.add('warn');
    } else if (ob > 1.6) {
      hint.textContent = 'Quite angled: brownie height will bias sizes a little. Shoot more from above if you can.';
      hint.classList.add('warn');
    } else hint.textContent = 'Drag the corners onto the board’s corners, then “Corners set”';
  }
}

$('retake').addEventListener('click', () => show('capture'));
$('clear-corners').addEventListener('click', () => editor?.setCorners([]));
$('auto-corners').addEventListener('click', autoCorners);
$('measure').addEventListener('click', async () => {
  if (!photoData || !editor || editor.corners.length !== 4) return;
  await cvPromise;
  const stage = $('corner-canvas').parentElement!;
  const prev = board?.seeds.map((s) => board!.toPhoto(s));
  await busy(stage, () => {
    const b = new Board(photoData!, editor!.corners, settings.sensitivity);
    // Coming back from "Corners": keep the taps that are still on the board.
    const kept = (prev ?? []).map((p) => b.toWarped(p)).filter((q) => inRect(b.warp.inner, q.x, q.y));
    if (kept.length) b.setSeeds(kept);
    else b.recompute();
    board = b;
  });
  show('result');
});
window.addEventListener('resize', () => {
  if (!$('screen-corners').hidden) editor?.layout();
  if (!$('screen-result').hidden) renderResult();
});

// ---------- 3. tap brownies + result -----------------------------------------------------------
const resultCanvas = $<HTMLCanvasElement>('result-canvas');

function renderResult() {
  if (!board || !photo) return;
  const box = resultCanvas.parentElement!.getBoundingClientRect();
  const s = Math.min(box.width / photo.width, box.height / photo.height);
  const cssW = Math.floor(photo.width * s);
  const cssH = Math.floor(photo.height * s);
  const dpr = window.devicePixelRatio || 1;
  resultCanvas.style.width = `${cssW}px`;
  resultCanvas.style.height = `${cssH}px`;
  resultCanvas.width = Math.round(cssW * dpr);
  resultCanvas.height = Math.round(cssH * dpr);
  const faces = $<HTMLInputElement>('faces').checked && board.seeds.length ? facesOverlay(board, photo.width, photo.height) : null;
  drawResult(resultCanvas, photo, board, { faces });

  const v = verdict(board.ranking);
  $('verdict-title').textContent = v.title;
  $('verdict-detail').textContent = v.detail;
  $('verdict').className = `verdict ${v.tone}`;
  const n = board.seeds.length;
  $('counter').textContent = `${n} brownie${n === 1 ? '' : 's'} tapped`;
  $('shallow-warn').hidden = !board.tooShallow;
  const np = board.proposals.length;
  $('proposal-bar').hidden = np === 0;
  $('proposal-count').textContent = `${np} suggested: tap to accept`;
  $('result-hint').hidden = np > 0;
  $<HTMLButtonElement>('undo').disabled = !board.canUndo;
  $('timing').textContent = `Last update: ${Math.round(board.lastMs)} ms · typical piece ≈ ${Math.round(board.pieceWidth())} px`;
  if (!$('debug-panel').hidden) renderDebug();
}

function renderDebug() {
  const panel = $('debug-panel');
  panel.replaceChildren();
  if (!board) return;
  for (const [name, c] of debugPanels(board)) {
    const fig = document.createElement('figure');
    const cap = document.createElement('figcaption');
    cap.textContent = name;
    fig.append(c, cap);
    panel.append(fig);
  }
}

// Tap = accept a suggestion / remove a seed / add a seed. Ignore drags.
let downAt: { x: number; y: number } | null = null;
resultCanvas.addEventListener('pointerdown', (e) => (downAt = { x: e.clientX, y: e.clientY }));
resultCanvas.addEventListener('pointerup', async (e) => {
  if (!downAt || !board || !photo) return;
  const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
  downAt = null;
  if (moved > 12) return;
  const r = resultCanvas.getBoundingClientRect();
  const p = { x: ((e.clientX - r.left) / r.width) * photo.width, y: ((e.clientY - r.top) / r.height) * photo.height };
  const out = await busy(resultCanvas.parentElement!, () => board!.tapAt(p));
  if (out === 'outside') toast('That’s outside the corners. Only the board is measured.');
  renderResult();
});

$('back-corners').addEventListener('click', () => openCorners(true));
$('new-photo').addEventListener('click', () => show('capture'));
$('undo').addEventListener('click', async () => {
  await busy(resultCanvas.parentElement!, () => board?.undo());
  renderResult();
});
$('suggest').addEventListener('click', async () => {
  if (!board) return;
  const n = await busy(resultCanvas.parentElement!, () => board!.suggest());
  toast(n ? `${n} suggested taps: tap one to accept it, or “Accept all”` : 'No new suggestions. Tap the brownies yourself.');
  if (!board.seeds.length) toast(`${n} guesses. Tip: tap one brownie first, then Suggest works much better.`, 4000);
  renderResult();
});
$('accept-all').addEventListener('click', async () => {
  await busy(resultCanvas.parentElement!, () => board?.acceptAll());
  renderResult();
});
$('dismiss').addEventListener('click', () => {
  board?.dismissProposals();
  renderResult();
});

// ---------- settings sheet ---------------------------------------------------------------------
function syncSliders() {
  $<HTMLInputElement>('sensitivity').value = String(settings.sensitivity);
  $('o-sensitivity').textContent = settings.sensitivity.toFixed(2);
}

let rerunTimer = 0;
$<HTMLInputElement>('sensitivity').addEventListener('input', (e) => {
  settings = { ...settings, sensitivity: Number((e.target as HTMLInputElement).value) };
  store.set('bp.settings', settings);
  syncSliders();
  clearTimeout(rerunTimer);
  rerunTimer = window.setTimeout(async () => {
    await busy(resultCanvas.parentElement!, () => board?.setSensitivity(settings.sensitivity));
    renderResult();
  }, 250);
});
$('reset-params').addEventListener('click', async () => {
  settings = { sensitivity: DEFAULT_SENSITIVITY };
  store.set('bp.settings', settings);
  syncSliders();
  await busy(resultCanvas.parentElement!, () => board?.setSensitivity(settings.sensitivity));
  renderResult();
});
$('clear-pieces').addEventListener('click', () => {
  board?.clear();
  renderResult();
});
$<HTMLInputElement>('faces').addEventListener('change', renderResult);
$<HTMLInputElement>('debug').addEventListener('change', (e) => {
  $('debug-panel').hidden = !(e.target as HTMLInputElement).checked;
  if (!$('debug-panel').hidden) renderDebug();
});
$('open-tune').addEventListener('click', () => {
  syncSliders();
  $('sheet').hidden = false;
});
$('close-tune').addEventListener('click', () => ($('sheet').hidden = true));

// ---------- boot -----------------------------------------------------------------------------
syncSliders();
show('capture');

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
