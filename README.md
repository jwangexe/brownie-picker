# 🍫 Brownie Picker

Every brownie on the café board costs the same, but they're cut unevenly. Point your phone at the
board, tap its 4 corners, and Brownie Picker tells you which piece is biggest.

Everything runs in the browser (OpenCV.js compiled to WebAssembly). No server, no uploads.

## How it works

1. **Capture**: a still from the rear camera, or a saved photo.
2. **Corners → top-down view**: you place the board's 4 corners (auto-detected when possible, with a
   magnifier while dragging). A homography warps the board to a top-down view, where pixel area is
   proportional to real area everywhere on the board.
   *You never need the board's real size:* a wrong aspect ratio is just a uniform stretch, which
   scales every area by the same factor and leaves the *relative* sizes exact.
3. **Segmentation** (in the top-down view):
   - **Automatic**: colour threshold (on a wooden board, brownies and wood share a hue, so
     *darkness* does most of the work; the cutoff is picked automatically with Otsu's method) →
     morphological cleanup → hole filling → glare repair → distance transform + watershed to split
     touching pieces, helped by a dark-crease detector for pieces cut from one slab.
   - **Tap to fix**: tap a missed brownie and it's segmented from that point (Lab-colour flood
     fill refined with GrabCut). Tap a piece to remove it. Undo is there.
4. **Measure & rank**: area of each piece as % of the average. The biggest gets a gold outline and 👑,
   the runner-up silver. If they're within 5%, it says it's basically a tie.
   Pieces get a ⚠ when the number may be off: *glare* (a highlight touches it), *cut off?*
   (touches the board edge) or *merged?* (odd shape, maybe two pieces).

Code map: `src/pipeline/` is pure image processing (no DOM, also runs in Node tests),
`src/ui/` holds the app widgets, `src/main.ts` is the app, `src/batch.ts` is the batch page, and
`src/synth/` is the synthetic scene generator.

## Run it locally

Needs Node 20+.

```bash
npm install
npm run dev
```

Open http://localhost:5173. On a laptop the webcam is used; the **Photo** button loads a saved picture.

## Test on your phone

The camera API only works on **HTTPS** (or localhost), so there are two ways.

**A. Over your Wi-Fi (fastest while developing).** Phone and laptop on the same network:

```bash
npm run dev:phone
```

Vite prints a `Network: https://192.168.x.x:5173/` address; open it on the phone. It uses a
self-signed certificate, so accept the warning once (iPhone Safari: *Show Details → visit this
website*; Android Chrome: *Advanced → Proceed*). Then allow camera access. Some school or café
Wi-Fi blocks device-to-device traffic; use your phone's hotspot or option B instead.

**B. The deployed site (GitHub Pages).** This repo has a workflow (`.github/workflows/deploy.yml`)
that runs the tests, builds and publishes on every push to `main`. One-time setup:

1. Push the repo to GitHub.
2. Repo **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Push (or re-run the workflow). The site appears at `https://<your-username>.github.io/<repo-name>/`.

On the phone: open the URL, then *Share → Add to Home Screen* for an app-like icon. After the first
load, OpenCV (~10 MB) is cached by a service worker, so later launches are instant.

*(Vercel works too: import the repo; framework "Vite", build `npm run build`, output `dist`.)*

## Tests

```bash
npm test
```

- `tests/geometry.test.ts`: corner ordering, homography helpers, ranking and tie logic.
- `tests/pipeline.test.ts`: end-to-end on **synthetic boards** from `src/synth/synth.ts`: a
  wood-grain board with brownies of known area, rendered with a random perspective (straight down
  up to quite oblique), uneven lighting, noise and blur. It checks:
  - all 12 pieces found, with no extras or duplicates, and the correct winner;
  - median relative-area error < 3%, worst < 6% (actual: about 1% median);
  - glare: the ranking survives, and any piece glare distorts by > 5% is flagged ⚠;
  - touching pieces cut from one slab are split correctly;
  - a 2% difference is reported as a tie;
  - tap-to-select at each piece's centre reproduces the areas;
  - the pipeline runs in < 1 s (about 50–80 ms in Node and desktop Chrome).

## Your own photos: `test-images/`

1. Drop photos into `test-images/` (jpg/png/webp).
2. `npm run batch` opens a page that runs the pipeline on every image and shows the overlay, the
   verdict, a per-piece table and debug images (top-down view, pieces, mask, distance transform).
3. Corners are auto-detected, or set them with **Edit corners → Save**. That writes
   `test-images/NAME.corners.json`, so the next run uses exactly those corners.

`npm run synth` writes example synthetic scenes (with ground truth) to `test-images/synthetic/`.
You can also open those with the app's **Photo** button.

Whether real photos are committed is up to you; only `test-images/synthetic/*.png` is git-ignored.

## Known failure modes and what to do

| Problem | What you'll see | Fix |
|---|---|---|
| **Angled shot** (brownie height) | Brownies are ~2–3 cm tall. Their tops sit above the board plane and at an angle you also see the side walls, so near pieces look bigger. The app warns when the corner shape is very skewed. | Shoot from as high and straight-down as you can. A 5% margin from a steep angle isn't trustworthy. |
| **Imprecise corners** | All areas shift a little; mostly harmless for ranking, but pieces at the board edge may get cut (⚠ *cut off?*). | Use the magnifier; put corners on the board's outer edge. |
| **Glare** (shiny tops, overhead lights) | A highlight on an edge bites a notch out of the piece. Glare repair fills it back, but a highlight on a corner can't be recovered; the piece shows ⚠ *glare*. | Tilt the phone slightly or step sideways so the reflection moves off the brownies; reshoot. |
| **Touching pieces with no visible gap** | Two pieces measured as one (often ⚠ *merged?*, ~200% of the mean). | Tuning → raise *Split touching pieces* or lower *Crease detection*. Or tap the merged blob to remove it, then tap each half. |
| **One piece split in two** (deep crack in the top) | Two small pieces where there's one. | Raise *Crease detection* (less sensitive) or lower *Split touching pieces*. |
| **Bad or coloured lighting** (dim café, warm bulbs) | Missed pieces, or wood counted as brownie. | Tuning → *Sample brownie colour* and tap a typical brownie; it re-centres the thresholds. Turn off *auto* darkness and drag the cutoff. |
| **Dark wooden board** (walnut) | Board and brownies have similar darkness. | Sample colour, narrow *Hue width*, raise *Min saturation*; worst case, tap each piece. |
| **Crumbs, wrappers, labels** | Extra small "pieces". | Raise *Min piece size*, or tap them to remove. |
| **Top area ≠ amount of brownie** | Thickness differences aren't measured; only the area seen from above. | Out of scope. Pick the thicker of a tie by eye. |

## Possible next steps

- Run the pipeline in a Web Worker so the UI never blocks on slower phones.
- Point-prompted MobileSAM / EfficientSAM through onnxruntime-web for difficult boards
  (a ~30 MB model download; only worth it if real photos show classical segmentation struggling).
- Pinch-zoom on the result view.
