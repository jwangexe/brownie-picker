import { cv, MatPool } from './cv';
import { applyH, obliqueness } from './geometry';
import { buildGapMap, dilateMask, elevationImage, type GapMap } from './gapmap';
import { backgroundMask, colourModel, darkLimit, seededWatershed, toLab, type LabImage } from './markers';
import { rankPieces } from './measure';
import { piecesFromLabels } from './pieces';
import { suggestSeeds, type Suggestion } from './suggest';
import { topFaces } from './topface';
import type { Piece, Pt, Ranking, RGBAImage } from './types';
import { inRect, warpBoard, type WarpResult } from './warp';

export type TapOutcome = 'added' | 'removed' | 'accepted' | 'outside';

/** Near edge more than this × the far edge: too shallow for accurate sizes. */
export const MAX_FORESHORTENING = 2.5;

export const DEFAULT_SENSITIVITY = 0.5;

/**
 * One measured board. The user's taps (seeds) are the source of truth: each seed is one watershed
 * marker, so there is exactly one piece per seed. Everything else (gap map, background, top faces)
 * only decides where each piece's boundary goes.
 */
export class Board {
  readonly warp: WarpResult;
  readonly lab: LabImage;
  readonly W: number;
  readonly H: number;
  /** Accepted seeds, warped coordinates. */
  seeds: Pt[] = [];
  /** Suggested seeds awaiting accept/delete, warped coordinates. */
  proposals: Pt[] = [];
  labels: Int32Array;
  top: Uint8Array;
  pieces: Piece[] = [];
  ranking: Ranking = rankPieces([]);
  background: Uint8Array | null = null;
  suggestion: Suggestion | null = null;
  lastMs = 0;
  private gm: GapMap | null = null;
  private gmKey = '';
  private elev: Uint8Array | null = null;
  private cutZone: Uint8Array | null = null;
  private undoStack: { seeds: Pt[]; proposals: Pt[] }[] = [];

  constructor(
    photo: RGBAImage,
    corners: Pt[],
    public sensitivity = DEFAULT_SENSITIVITY,
  ) {
    this.warp = warpBoard(photo, corners);
    this.W = this.warp.warped.width;
    this.H = this.warp.warped.height;
    this.lab = toLab(this.warp.warped);
    this.labels = new Int32Array(this.W * this.H);
    this.top = new Uint8Array(this.W * this.H);
  }

  /** Near/far edge ratio of the corner quad (1 = straight down). */
  get foreshortening() {
    return obliqueness(this.warp.corners);
  }
  get tooShallow() {
    return this.foreshortening > MAX_FORESHORTENING;
  }
  get canUndo() {
    return this.undoStack.length > 0;
  }
  get innerW() {
    return this.warp.inner.x1 - this.warp.inner.x0 + 1;
  }
  get innerH() {
    return this.warp.inner.y1 - this.warp.inner.y0 + 1;
  }

  toWarped(p: Pt): Pt {
    return applyH(this.warp.H, p);
  }
  toPhoto(p: Pt): Pt {
    return applyH(this.warp.Hinv, p);
  }

  /**
   * Typical piece width in warped px: median distance from each seed to its nearest neighbour
   * (neighbouring brownies are about one width apart). A guess until there are 3 seeds.
   */
  pieceWidth(): number {
    const big = Math.max(this.innerW, this.innerH);
    const pts = this.seeds.length >= 3 ? this.seeds : this.proposals.length >= 3 ? this.proposals : null;
    if (!pts) return 0.12 * big;
    const nn = pts.map((p, i) => Math.min(...pts.filter((_, j) => j !== i).map((q) => Math.hypot(p.x - q.x, p.y - q.y))));
    nn.sort((a, b) => a - b);
    return Math.max(0.04 * big, Math.min(0.5 * big, nn[nn.length >> 1]));
  }

  /** The (cached) gap map. Rebuilt when sensitivity or the piece-width estimate changes by > 25%. */
  gapMap(): GapMap {
    const pw = this.pieceWidth();
    const key = `${Math.round(Math.log(pw) / Math.log(1.25))}|${this.sensitivity}`;
    if (!this.gm || key !== this.gmKey) {
      this.gm = buildGapMap(this.warp.warped, this.warp.inner, pw, this.sensitivity);
      this.gmKey = key;
      const pool = new MatPool();
      try {
        this.elev = new Uint8Array(elevationImage(this.warp.warped, this.gm, pool).data);
        this.cutZone = new Uint8Array(dilateMask(this.gm.gap, this.W, this.H, 7, pool));
      } finally {
        pool.free();
      }
    }
    return this.gm;
  }

  /** Re-runs the marker watershed and measurement from the current seeds. */
  recompute() {
    const t0 = performance.now();
    const n = this.W * this.H;
    if (!this.seeds.length) {
      this.labels = new Int32Array(n);
      this.top = new Uint8Array(n);
      this.background = null;
    } else {
      this.gapMap();
      const model = colourModel(this.lab, this.W, this.seeds, this.sampleRadius());
      this.background = backgroundMask(this.lab, this.W, this.warp.inner, model, this.cutZone!);
      const pool = new MatPool();
      try {
        const elev = pool.add(cv.matFromArray(this.H, this.W, cv.CV_8UC3, this.elev!));
        // Seed discs scale with the piece: a 3-px dot in rough crust gets boxed in by texture edges.
        const r = Math.round(Math.max(3, Math.min(15, 0.12 * this.pieceWidth())));
        this.labels = seededWatershed(elev, this.W, this.H, this.seeds, this.background, r);
      } finally {
        pool.free();
      }
      this.top = topFaces(this.lab, this.labels, this.W, this.H, darkLimit(model));
    }
    this.pieces = piecesFromLabels(this.labels, this.top, this.W, this.H, this.seeds);
    this.ranking = rankPieces(this.pieces);
    this.lastMs = performance.now() - t0;
  }

  /** Colour-sampling radius around each tap: a fifth of a piece, so the model sees each piece's
   *  real range of crust colours, not just one spot. */
  private sampleRadius() {
    return Math.round(Math.max(5, Math.min(25, 0.2 * this.pieceWidth())));
  }

  /** Radius (warped px) within which a tap counts as "on" an existing seed or proposal. */
  private hitRadius() {
    return Math.max(10, 0.3 * this.pieceWidth());
  }

  private nearest(list: Pt[], q: Pt): number {
    let best = -1;
    let bd = this.hitRadius();
    list.forEach((p, i) => {
      const d = Math.hypot(p.x - q.x, p.y - q.y);
      if (d <= bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  }

  /**
   * A tap on the photo. On a suggested seed: accept it. Near an existing seed: remove that piece.
   * Anywhere else on the board: add a seed (one tap = one brownie; tapping the other half of an
   * oversized piece splits it).
   */
  tapAt(photoPt: Pt): TapOutcome {
    const q = this.toWarped(photoPt);
    if (!inRect(this.warp.inner, q.x, q.y)) return 'outside';
    this.pushUndo();
    const pi = this.nearest(this.proposals, q);
    if (pi >= 0) {
      this.seeds.push(this.proposals[pi]);
      this.proposals.splice(pi, 1);
      this.recompute();
      return 'accepted';
    }
    // Remove if the tap is near a seed, or inside a piece and close-ish to its seed.
    const si = this.nearest(this.seeds, q);
    if (si >= 0) {
      this.seeds.splice(si, 1);
      this.recompute();
      return 'removed';
    }
    this.seeds.push(q);
    this.recompute();
    return 'added';
  }

  /** Runs "Suggest seeds": fills `proposals` (never touches accepted seeds). */
  suggest(): number {
    this.pushUndo();
    const gm = this.gapMap();
    const known = this.seeds.length ? colourModel(this.lab, this.W, this.seeds, this.sampleRadius()) : undefined;
    this.suggestion = suggestSeeds(this.warp.warped, this.lab, this.warp.inner, gm, known);
    // Skip proposals for pieces already tapped: same suggested region as a seed, or very close to one.
    const r = this.hitRadius();
    const m = this.suggestion.merged;
    const at = (p: Pt) => m[Math.round(p.y) * this.W + Math.round(p.x)];
    const taken = new Set(this.seeds.map(at).filter((l) => l));
    this.proposals = this.suggestion.seeds.filter((p) => !taken.has(at(p)) && !this.seeds.some((s) => Math.hypot(s.x - p.x, s.y - p.y) < r));
    return this.proposals.length;
  }

  acceptAll() {
    if (!this.proposals.length) return;
    this.pushUndo();
    this.seeds.push(...this.proposals);
    this.proposals = [];
    this.recompute();
  }

  dismissProposals() {
    if (!this.proposals.length) return;
    this.pushUndo();
    this.proposals = [];
  }

  setSeeds(seeds: Pt[]) {
    this.pushUndo();
    this.seeds = [...seeds];
    this.recompute();
  }

  setSensitivity(s: number) {
    this.sensitivity = s;
    this.recompute();
  }

  clear() {
    this.pushUndo();
    this.seeds = [];
    this.proposals = [];
    this.recompute();
  }

  undo() {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.seeds = prev.seeds;
    this.proposals = prev.proposals;
    this.recompute();
  }

  private pushUndo() {
    this.undoStack.push({ seeds: [...this.seeds], proposals: [...this.proposals] });
    if (this.undoStack.length > 30) this.undoStack.shift();
  }
}
