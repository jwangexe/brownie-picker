import { orderCorners } from '../pipeline/geometry';
import type { Pt } from '../pipeline/types';

/**
 * Canvas widget for placing and dragging the 4 board corners on a photo. Tap to add a corner (up to
 * 4), drag a handle to move it. While dragging, a magnifier above the finger shows the exact spot.
 */
export class CornerEditor {
  corners: Pt[] = [];
  onChange: () => void = () => {};
  private drag = -1;
  private ctx: CanvasRenderingContext2D;
  private scale = 1;
  private loupe: HTMLCanvasElement;
  private lastPointer: Pt | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
    private photo: HTMLCanvasElement,
  ) {
    this.ctx = canvas.getContext('2d')!;
    this.loupe = document.createElement('canvas');
    this.loupe.className = 'loupe';
    this.loupe.width = this.loupe.height = 220;
    canvas.parentElement!.appendChild(this.loupe);
    canvas.addEventListener('pointerdown', this.down);
    canvas.addEventListener('pointermove', this.move);
    canvas.addEventListener('pointerup', this.up);
    canvas.addEventListener('pointercancel', this.up);
  }

  destroy() {
    this.canvas.removeEventListener('pointerdown', this.down);
    this.canvas.removeEventListener('pointermove', this.move);
    this.canvas.removeEventListener('pointerup', this.up);
    this.canvas.removeEventListener('pointercancel', this.up);
    this.loupe.remove();
  }

  setPhoto(photo: HTMLCanvasElement) {
    this.photo = photo;
    this.layout();
  }

  setCorners(c: Pt[]) {
    this.corners = c.length === 4 ? orderCorners(c) : [...c];
    this.draw();
    this.onChange();
  }

  /** Fits the canvas to its container (CSS pixels × devicePixelRatio). */
  layout() {
    const box = this.canvas.parentElement!.getBoundingClientRect();
    const s = Math.min(box.width / this.photo.width, box.height / this.photo.height);
    const cssW = Math.floor(this.photo.width * s);
    const cssH = Math.floor(this.photo.height * s);
    const dpr = window.devicePixelRatio || 1;
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this.scale = this.canvas.width / this.photo.width;
    this.draw();
  }

  private toPhoto(e: PointerEvent): Pt {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * this.photo.width,
      y: ((e.clientY - r.top) / r.height) * this.photo.height,
    };
  }

  /** Hit radius ~28 CSS px, converted to photo pixels. */
  private hitRadius() {
    const r = this.canvas.getBoundingClientRect();
    return (28 / r.width) * this.photo.width;
  }

  private down = (e: PointerEvent) => {
    e.preventDefault();
    const p = this.toPhoto(e);
    let best = -1;
    let bestD = this.hitRadius();
    this.corners.forEach((c, i) => {
      const d = Math.hypot(c.x - p.x, c.y - p.y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    if (best < 0 && this.corners.length < 4) {
      this.corners.push(p);
      best = this.corners.length - 1;
    }
    if (best >= 0) {
      this.drag = best;
      this.canvas.setPointerCapture(e.pointerId);
      this.lastPointer = { x: e.clientX, y: e.clientY };
      this.draw();
    }
  };

  private move = (e: PointerEvent) => {
    if (this.drag < 0) return;
    const p = this.toPhoto(e);
    this.corners[this.drag] = {
      x: Math.max(0, Math.min(this.photo.width - 1, p.x)),
      y: Math.max(0, Math.min(this.photo.height - 1, p.y)),
    };
    this.lastPointer = { x: e.clientX, y: e.clientY };
    this.draw();
  };

  private up = () => {
    if (this.drag < 0) return;
    this.drag = -1;
    this.lastPointer = null;
    if (this.corners.length === 4) this.corners = orderCorners(this.corners);
    this.draw();
    this.onChange();
  };

  draw() {
    const { ctx, scale } = this;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.photo, 0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    const lw = (2.5 * dpr) / scale;
    const c = this.corners.length === 4 && this.drag < 0 ? orderCorners(this.corners) : this.corners;
    if (c.length >= 2) {
      ctx.beginPath();
      c.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      if (c.length === 4) ctx.closePath();
      ctx.fillStyle = c.length === 4 ? 'rgba(255, 200, 61, 0.12)' : 'transparent';
      ctx.fill();
      ctx.strokeStyle = '#ffc83d';
      ctx.lineWidth = lw;
      ctx.stroke();
    }
    const r = (13 * dpr) / scale;
    this.corners.forEach((p, i) => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = i === this.drag ? 'rgba(255,200,61,0.5)' : 'rgba(0,0,0,0.35)';
      ctx.fill();
      ctx.strokeStyle = '#ffc83d';
      ctx.lineWidth = lw;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(p.x, p.y, lw, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
    });
    this.drawLoupe();
  }

  private drawLoupe() {
    const L = this.loupe;
    if (this.drag < 0 || !this.lastPointer) {
      L.style.display = 'none';
      return;
    }
    const p = this.corners[this.drag];
    const lc = L.getContext('2d')!;
    const zoomSrc = 55; // photo px radius shown
    lc.save();
    lc.clearRect(0, 0, L.width, L.height);
    lc.beginPath();
    lc.arc(L.width / 2, L.height / 2, L.width / 2 - 3, 0, Math.PI * 2);
    lc.clip();
    lc.fillStyle = '#000';
    lc.fillRect(0, 0, L.width, L.height);
    lc.drawImage(this.photo, p.x - zoomSrc, p.y - zoomSrc, zoomSrc * 2, zoomSrc * 2, 0, 0, L.width, L.height);
    lc.strokeStyle = '#ffc83d';
    lc.lineWidth = 2;
    lc.beginPath();
    lc.moveTo(L.width / 2, 0);
    lc.lineTo(L.width / 2, L.height);
    lc.moveTo(0, L.height / 2);
    lc.lineTo(L.width, L.height / 2);
    lc.stroke();
    lc.restore();
    lc.beginPath();
    lc.arc(L.width / 2, L.height / 2, L.width / 2 - 3, 0, Math.PI * 2);
    lc.strokeStyle = '#fff';
    lc.lineWidth = 4;
    lc.stroke();
    // Position above (or below, near the top) the finger, inside the parent.
    const parent = this.canvas.parentElement!.getBoundingClientRect();
    const size = 110;
    let x = this.lastPointer.x - parent.left - size / 2;
    let y = this.lastPointer.y - parent.top - size - 70;
    if (y < 0) y = this.lastPointer.y - parent.top + 70;
    x = Math.max(0, Math.min(parent.width - size, x));
    L.style.cssText = `display:block;left:${x}px;top:${y}px;width:${size}px;height:${size}px`;
  }
}
