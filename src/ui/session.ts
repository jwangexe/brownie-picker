import { rankPieces } from '../pipeline/measure';
import { flagGlare, piecesFromLabels } from '../pipeline/pieces';
import { autoSegment, DEFAULT_PARAMS, paramsFromSample, type SegDebug, type SegParams } from '../pipeline/segment';
import { DEFAULT_TAP, labImage, tapSelect, type TapOptions } from '../pipeline/tapselect';
import { applyH } from '../pipeline/geometry';
import { warpBoard, type WarpResult } from '../pipeline/warp';
import type { Pt, Ranking, RGBAImage } from '../pipeline/types';

export type TapOutcome = 'added' | 'removed' | 'missed' | 'outside';

/**
 * Everything about one measured board: the warp, the editable label map, undo history and the
 * current ranking. Shared by the app and the batch page.
 */
export class BoardSession {
  warp: WarpResult;
  labels: Int32Array;
  debug: SegDebug | null = null;
  ranking: Ranking = rankPieces([]);
  lastMs = 0;
  private lab: Uint8Array | null = null;
  private nextLabel = 1;
  private undoStack: Int32Array[] = [];

  constructor(
    photo: RGBAImage,
    corners: Pt[],
    public params: SegParams = { ...DEFAULT_PARAMS },
    public tap: TapOptions = { ...DEFAULT_TAP },
  ) {
    this.warp = warpBoard(photo, corners);
    this.labels = new Int32Array(this.warp.warped.width * this.warp.warped.height);
  }

  get W() {
    return this.warp.warped.width;
  }
  get H() {
    return this.warp.warped.height;
  }
  get canUndo() {
    return this.undoStack.length > 0;
  }

  runAuto() {
    const t0 = performance.now();
    if (this.labels.some((l) => l)) this.pushUndo();
    const seg = autoSegment(this.warp.warped, this.params);
    this.labels = seg.labels;
    this.debug = seg.debug;
    this.nextLabel = this.labels.reduce((m, l) => Math.max(m, l), 0) + 1;
    this.refresh();
    this.lastMs = performance.now() - t0;
  }

  /** Photo coordinates -> warped coordinates (or null if off the board). */
  toWarped(p: Pt): Pt | null {
    const q = applyH(this.warp.H, p);
    return q.x < 0 || q.y < 0 || q.x >= this.W || q.y >= this.H ? null : q;
  }

  /** A tap on the photo: removes the piece under it, or segments a new one from that point. */
  tapAt(photoPt: Pt): TapOutcome {
    const q = this.toWarped(photoPt);
    if (!q) return 'outside';
    const idx = Math.round(q.y) * this.W + Math.round(q.x);
    const hit = this.labels[idx];
    if (hit) {
      this.pushUndo();
      for (let i = 0; i < this.labels.length; i++) if (this.labels[i] === hit) this.labels[i] = 0;
      this.refresh();
      return 'removed';
    }
    this.lab ??= labImage(this.warp.warped);
    const mask = tapSelect(this.warp.warped, this.lab, this.labels, q, this.tap);
    if (!mask) return 'missed';
    this.pushUndo();
    const id = this.nextLabel++;
    for (let i = 0; i < mask.length; i++) if (mask[i]) this.labels[i] = id;
    this.refresh();
    return 'added';
  }

  /** Re-centres the colour thresholds on a tapped brownie. */
  sampleAt(photoPt: Pt): boolean {
    const q = this.toWarped(photoPt);
    if (!q) return false;
    this.params = paramsFromSample(this.warp.warped, q.x, q.y, this.params);
    return true;
  }

  clear() {
    this.pushUndo();
    this.labels = new Int32Array(this.labels.length);
    this.refresh();
  }

  undo() {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.labels = prev;
    this.refresh();
  }

  private pushUndo() {
    this.undoStack.push(this.labels.slice());
    if (this.undoStack.length > 12) this.undoStack.shift();
  }

  private refresh() {
    const pieces = flagGlare(piecesFromLabels(this.labels, this.W, this.H), this.labels, this.debug?.glare);
    this.ranking = rankPieces(pieces);
  }
}
