import './style.css';
import { detectBoard } from './pipeline/autocorners';
import { obliqueness, orderCorners } from './pipeline/geometry';
import { DEFAULT_PARAMS, type SegParams } from './pipeline/segment';
import { DEFAULT_TAP, type TapOptions } from './pipeline/tapselect';
import type { RGBAImage } from './pipeline/types';
import { CornerEditor } from './ui/cornerEditor';
import { loadOpenCV } from './ui/loadOpenCV';
import { drawResult, grayToCanvas, imageToCanvas, labelsToCanvas, verdict } from './ui/render';
import { BoardSession } from './ui/session';

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

let params: SegParams = store.get('bp.params', { ...DEFAULT_PARAMS });
let tapOpts: TapOptions = store.get('bp.tap', { ...DEFAULT_TAP });

// ---------- app state ----------------------------------------------------------------------
let photo: HTMLCanvasElement | null = null;
let photoData: RGBAImage | null = null;
let session: BoardSession | null = null;
let editor: CornerEditor | null = null;
let sampleMode = false;
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
  session = null;
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

// ---------- 2. corners -----------------------------------------------------------------------
function openCorners(keepCorners = false) {
  if (!photo) return;
  if (!editor) {
    editor = new CornerEditor($<HTMLCanvasElement>('corner-canvas'), photo);
    editor.onChange = updateCornerUI;
  } else editor.setPhoto(photo);
  if (!keepCorners) editor.setCorners([]);
  show('corners');
  if (!keepCorners) cvPromise.then(() => autoCorners(true));
}

function autoCorners(silent: boolean) {
  if (!cvReady || !photoData || !editor) return;
  const c = detectBoard(photoData);
  if (c) {
    editor.setCorners(c);
    if (!silent) toast('Board found. Drag the corners to adjust.');
  } else if (!silent) toast('Couldn’t find the board automatically. Tap its 4 corners.');
}

function updateCornerUI() {
  const n = editor?.corners.length ?? 0;
  const hint = $('corner-hint');
  hint.classList.remove('warn');
  $<HTMLButtonElement>('measure').disabled = n !== 4 || !cvReady;
  $<HTMLButtonElement>('auto-corners').disabled = !cvReady;
  if (n < 4) hint.textContent = `Tap the 4 corners of the board (${n}/4)`;
  else if (!cvReady) hint.textContent = 'Corners set. Waiting for the vision engine…';
  else {
    const ob = obliqueness(orderCorners(editor!.corners));
    if (ob > 1.6) {
      hint.textContent = 'Very angled shot: brownie height will bias sizes. Shoot more from above if you can.';
      hint.classList.add('warn');
    } else hint.textContent = 'Drag corners to adjust, then Measure';
  }
}

$('retake').addEventListener('click', () => show('capture'));
$('clear-corners').addEventListener('click', () => editor?.setCorners([]));
$('auto-corners').addEventListener('click', () => autoCorners(false));
$('measure').addEventListener('click', async () => {
  if (!photoData || !editor || editor.corners.length !== 4) return;
  await cvPromise;
  const stage = $('corner-canvas').parentElement!;
  await busy(stage, () => {
    const t0 = performance.now();
    session = new BoardSession(photoData!, editor!.corners, { ...params }, { ...tapOpts });
    session.runAuto();
    session.lastMs = performance.now() - t0;
  });
  show('result');
});
window.addEventListener('resize', () => {
  if (!$('screen-corners').hidden) editor?.layout();
  if (!$('screen-result').hidden) renderResult();
});

// ---------- 3. result ------------------------------------------------------------------------
const resultCanvas = $<HTMLCanvasElement>('result-canvas');

function renderResult() {
  if (!session || !photo) return;
  const box = resultCanvas.parentElement!.getBoundingClientRect();
  const s = Math.min(box.width / photo.width, box.height / photo.height);
  const cssW = Math.floor(photo.width * s);
  const cssH = Math.floor(photo.height * s);
  const dpr = window.devicePixelRatio || 1;
  resultCanvas.style.width = `${cssW}px`;
  resultCanvas.style.height = `${cssH}px`;
  resultCanvas.width = Math.round(cssW * dpr);
  resultCanvas.height = Math.round(cssH * dpr);
  drawResult(resultCanvas, photo, session.ranking, session.warp.Hinv, session.warp.corners);

  const v = verdict(session.ranking);
  $('verdict-title').textContent = v.title;
  $('verdict-detail').textContent = v.detail;
  $('verdict').classList.toggle('tie', session.ranking.isTie);
  $<HTMLButtonElement>('undo').disabled = !session.canUndo;
  $('timing').textContent = `Last auto run: ${Math.round(session.lastMs)} ms · darkness cutoff used: ${session.debug?.valMaxUsed ?? '–'}`;
  if (!$('debug-panel').hidden) renderDebug();
}

function renderDebug() {
  const panel = $('debug-panel');
  panel.replaceChildren();
  if (!session) return;
  const { W, H } = session;
  const items: [string, HTMLCanvasElement][] = [
    ['warped (top-down)', imageToCanvas(session.warp.warped)],
    ['pieces', labelsToCanvas(session.labels, session.warp.warped)],
  ];
  if (session.debug) {
    items.push(['brownie mask', grayToCanvas(session.debug.mask, W, H)]);
    items.push(['distance', grayToCanvas(session.debug.dist, W, H)]);
    items.push(['creases', grayToCanvas(session.debug.crease, W, H)]);
    items.push(['glare zones', grayToCanvas(session.debug.glare, W, H)]);
  }
  for (const [name, c] of items) {
    const fig = document.createElement('figure');
    const cap = document.createElement('figcaption');
    cap.textContent = name;
    fig.append(c, cap);
    panel.append(fig);
  }
}

// Tap = add/remove a piece (or sample colour in sample mode). Ignore drags.
let downAt: { x: number; y: number } | null = null;
resultCanvas.addEventListener('pointerdown', (e) => (downAt = { x: e.clientX, y: e.clientY }));
resultCanvas.addEventListener('pointerup', async (e) => {
  if (!downAt || !session || !photo) return;
  const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
  downAt = null;
  if (moved > 12) return;
  const r = resultCanvas.getBoundingClientRect();
  const p = { x: ((e.clientX - r.left) / r.width) * photo.width, y: ((e.clientY - r.top) / r.height) * photo.height };
  const stage = resultCanvas.parentElement!;

  if (sampleMode) {
    setSampleMode(false);
    if (!session.sampleAt(p)) return toast('Tap inside the board');
    params = { ...session.params };
    store.set('bp.params', params);
    syncSliders();
    await busy(stage, () => session!.runAuto());
    renderResult();
    toast('Colour sampled and re-measured');
    return;
  }

  const out = await busy(stage, () => session!.tapAt(p));
  if (out === 'outside') toast('That’s outside the board');
  else if (out === 'missed') toast('Couldn’t isolate a piece there. Try raising tap tolerance in Tuning.');
  renderResult();
});

function setSampleMode(on: boolean) {
  sampleMode = on;
  $('result-hint').textContent = on
    ? '🎯 Tap the middle of a typical brownie'
    : 'Tap a piece to remove it · tap a missed brownie to add it';
  $('result-hint').classList.toggle('warn', on);
}

$('back-corners').addEventListener('click', () => openCorners(true));
$('new-photo').addEventListener('click', () => show('capture'));
$('undo').addEventListener('click', () => {
  session?.undo();
  renderResult();
});

// ---------- tuning sheet ---------------------------------------------------------------------
const paramKeys = ['hueCenter', 'hueWidth', 'satMin', 'minAreaPct', 'split', 'crease'] as const;

function syncSliders() {
  for (const k of paramKeys) {
    $<HTMLInputElement>(k).value = String(params[k]);
    $(`o-${k}`).textContent = String(params[k]);
  }
  const auto = params.valMax == null;
  $<HTMLInputElement>('valAuto').checked = auto;
  const shownVal = params.valMax ?? session?.debug?.valMaxUsed ?? 110;
  $<HTMLInputElement>('valMax').value = String(shownVal);
  $<HTMLInputElement>('valMax').disabled = auto;
  $('o-valMax').textContent = auto ? `auto (${session?.debug?.valMaxUsed ?? '–'})` : String(params.valMax);
  $<HTMLInputElement>('glare').checked = params.glare;
  $<HTMLInputElement>('tolerance').value = String(tapOpts.tolerance);
  $('o-tolerance').textContent = String(tapOpts.tolerance);
  $<HTMLInputElement>('grabcut').checked = tapOpts.grabCut;
}

let rerunTimer = 0;
function paramsChanged() {
  store.set('bp.params', params);
  syncSliders();
  clearTimeout(rerunTimer);
  rerunTimer = window.setTimeout(async () => {
    if (!session) return;
    session.params = { ...params };
    await busy(resultCanvas.parentElement!, () => session!.runAuto());
    renderResult();
    syncSliders();
  }, 300);
}

for (const k of paramKeys) {
  $<HTMLInputElement>(k).addEventListener('input', (e) => {
    params = { ...params, [k]: Number((e.target as HTMLInputElement).value) };
    paramsChanged();
  });
}
$<HTMLInputElement>('valMax').addEventListener('input', (e) => {
  params = { ...params, valMax: Number((e.target as HTMLInputElement).value) };
  paramsChanged();
});
$<HTMLInputElement>('valAuto').addEventListener('change', (e) => {
  const on = (e.target as HTMLInputElement).checked;
  params = { ...params, valMax: on ? null : session?.debug?.valMaxUsed ?? 110 };
  paramsChanged();
});
$<HTMLInputElement>('glare').addEventListener('change', (e) => {
  params = { ...params, glare: (e.target as HTMLInputElement).checked };
  paramsChanged();
});
$<HTMLInputElement>('tolerance').addEventListener('input', (e) => {
  tapOpts = { ...tapOpts, tolerance: Number((e.target as HTMLInputElement).value) };
  if (session) session.tap = { ...tapOpts };
  store.set('bp.tap', tapOpts);
  syncSliders();
});
$<HTMLInputElement>('grabcut').addEventListener('change', (e) => {
  tapOpts = { ...tapOpts, grabCut: (e.target as HTMLInputElement).checked };
  if (session) session.tap = { ...tapOpts };
  store.set('bp.tap', tapOpts);
});
$('reset-params').addEventListener('click', () => {
  params = { ...DEFAULT_PARAMS };
  tapOpts = { ...DEFAULT_TAP };
  if (session) session.tap = { ...tapOpts };
  store.set('bp.tap', tapOpts);
  paramsChanged();
});
$('rerun').addEventListener('click', paramsChanged);
$('clear-pieces').addEventListener('click', () => {
  session?.clear();
  renderResult();
});
$('sample').addEventListener('click', () => {
  $('sheet').hidden = true;
  setSampleMode(true);
});
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
