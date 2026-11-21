# 🍫 Brownie Picker

Every brownie on the café board costs the same, but they're cut unevenly. Point your phone at the
board, tap its 4 corners, tap each brownie once, and Brownie Picker tells you which piece is biggest.

Everything runs in the browser (OpenCV.js compiled to WebAssembly). No server, no uploads.

## How it works

1. **Capture**: a still from the rear camera, or a saved photo. Hold the phone **high and as
   straight down as you can**; the capture screen says so.
2. **Corners (mandatory)**: nothing is measured until you place the board's 4 corners and press
   **Corners set** (✨ Auto only *suggests* corners, and never accepts "the whole photo"). A homography
   warps the quad to a top-down view, where pixel area is proportional to real area. Everything
   outside the quad is masked out: it's kept as a margin that is *always background*, so croissants
   in the next basket can never become pieces. If the near edge is more than 2.5× the far edge, the
   app warns that the angle is too shallow for accurate sizes.
   *You never need the board's real size:* a wrong aspect ratio scales every area equally.
3. **Tap each brownie once** (the source of truth). Every tap is a marker for one
   **marker-controlled watershed** (`cv.watershed`) over the top-down view; it re-runs live after
   each tap. So **pieces = taps, always**; the counter shows "12 brownies tapped". Tap a piece's dot to
   remove it. Tap the *other half* of an oversized piece to split it. Undo is there.
   - **Background marker**: outside the quad, pale paper/plates, colours far from the tapped
     brownies (learned from the area around your taps), and very dark pixels *on detected cut lines*.
   - **Gap map** (what the watershed floods): hue can't separate brownie from brownie, brightness
     can. A black-hat on LAB lightness + adaptive threshold turns dark lines into ridges, cuts *and*
     crust cracks alike. Only ridges that look like cuts survive: long (≥ ½ a piece width at default
     sensitivity), straight (Hough segments with ≥ 83% support along their length), and deep
     (dark like the deepest cuts). Cracks are erased from the flooded image; cuts are painted in as
     V-shaped valleys so neighbours meet in the middle of the cut. Grid-aligned cuts are
     strengthened with row/column projection profiles. *Settings → Cut-line sensitivity.*
   - **✨ Suggest** proposes taps (dashed ⊕ rings) that you accept one by one or with *Accept all*;
     it never adds or splits pieces by itself. It over-segments (distance-transform peaks), then
     merges neighbours on a region adjacency graph when the shared boundary has no cut line, the union
     is more rectangular than the parts, or both parts are fragment-sized. It works best after one tap
     (so it knows what a brownie looks like here).
4. **Each brownie is a box (cuboid model)**. Measuring the outline of a piece's pixels is wrong
   for a 3D object: shot at an angle it includes the side faces, loses the bits in dark cracks, and
   grows when the segmentation leaks. So:
   - **Top vs side faces**: cut faces are darker *and* less yellow than the glossy crust. All piece
     pixels are split into two clusters on (lightness relative to the brightest crust nearby,
     yellowness); dark regions at a piece's edge are side faces, thin dark cracks stay top.
   - **Top face = rectangle**: each piece's top is fitted with a rectangle (near the board's axes,
     unless a piece is clearly turned). The measured area is that top **filled in**: everything
     inside it counts (cracks, holes, even if the segmentation called them background), side faces
     and neighbours never do, and crust poking out past the rectangle still counts.
     Why the top and not the footprint: from the camera, the plane of the tops maps to the board by a
     uniform scaling about the point under the camera, so for pieces of one tray (same height) every
     top is scaled by the same factor and the ratios are exact.
   - **Height and faces**: a front face sits straight below its top, so side-face pixels are given to
     the top rectangle above them (the watershed often hands a whole row of front faces to one
     piece). The board's height is the upper quartile of the front-face lengths (fronts can be
     hidden, never longer). Top + height complete the box, and its visible faces follow from
     geometry: **top** (gold), **front** (blue) and a **side** (purple) when a piece is off to one
     side of the camera. *Settings → Label faces* turns the tints on/off.
5. **Verdict**: pieces are numbered by size (#1 = biggest).
   - ⚠ **×2?** = more than 1.8× the median piece ("might be two pieces: tap to split");
     ⚠ **bit?** = less than 0.4× ("likely a fragment"). The median ignores fragments, so half-hidden
     pieces don't make every whole piece look "too big". ⚠ **shape?** = its top doesn't fit a box
     (leaning, broken, stacked): its size is a guess.
   - A flagged piece is **never crowned**. If #1 is flagged: "Check #1: might be two pieces".
   - If more than 30% of pieces are ×2? / bit?: no winner; "segmentation needs fixing".
   - Otherwise: "#1 is ~18% bigger than #2", or a tie under 5%.
   - The fitted boxes are drawn on the original photo (gold = winner), with the board outside the
     corners dimmed.

Code map: `src/pipeline/` is pure image processing (no DOM, also runs in Node tests): `board.ts`
(the tap-seeded engine), `gapmap.ts`, `markers.ts` (background + watershed), `topface.ts`,
`cuboid.ts` (box fit, filled top area, faces), `camera.ts` (pose from the corners),
`suggest.ts` (proposals + RAG merge), `measure.ts` (ranking and flags);
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

- `tests/geometry.test.ts`: corner ordering, homography helpers, ranking, size flags, "never crown a
  flagged piece", the 30% rule, and fragment-robust median.
- `tests/pipeline.test.ts`: tap-seeded segmentation on **synthetic boards** (`src/synth/synth.ts`:
  known areas, random perspective, lighting, noise, blur), tapping each piece's centre:
  - piece count = tap count, every piece matched, **every area within 5%** of ground truth (shares);
  - touching pieces separated only by thin dark gaps;
  - **crack texture** on tops (wiggly dark cracks) doesn't move boundaries;
  - **shallow angle** (far edge ~2.3× shorter) still within 5%; > 2.5× is flagged as too shallow;
  - **visible side faces** are excluded (only top faces measured);
  - tap add / remove / outside / undo, and two taps on one piece split it;
  - Suggest proposes exactly one seed per piece (cracks don't cause splits) and adds nothing itself;
  - re-segmentation after a tap is < 1 s (≈ 0.2–0.3 s for a 1280 px photo).
- `tests/cafe.test.ts`: **regression on real photos**, `test-images/cafe-01.jpg` and `cafe-02.jpg`
  (a very oblique shot of thick pieces) with corners and taps in `NAME.taps.json`: boxes fit most
  pieces and find their front faces, piece count = tap count, nothing outside the corner quad, no piece
  over 1.8× the median except cases listed (with a written reason) in `knownOversize`, and a flagged
  piece is never the winner.

`npm run debug -- cafe-01` writes the full debug view (result on the photo with top/side tint, gap
map before/after, top-face mask, background marker, Suggest before/after merge) to
`test-images/out/cafe-01.debug.png`.

## Your own photos: `test-images/`

1. Drop a photo into `test-images/` (jpg/png/webp).
2. `npm run batch` opens a page that runs the pipeline on each image that has a
   `NAME.taps.json` (corners + taps). Set corners, click the photo to add/remove taps, use Suggest, then
   **Save taps** to write the fixture. That's how `cafe-01.taps.json` is maintained: re-save it with your
   own taps.
3. Copy `tests/cafe.test.ts` to add more real-photo regressions.

`npm run synth` writes synthetic scenes (with ground truth and tap fixtures) to `test-images/synthetic/`.

## Known failure modes and what to do

| Problem | What you'll see | Fix |
|---|---|---|
| **Shallow angle** (brownie height) | Tops sit 2–3 cm above the board and side walls show; leaning or stacked pieces present their top *toward* the camera and look up to 2–3× bigger. Warned when the near edge is > 2.5× the far edge. | Shoot from high and straight down. Side faces are removed, but a tilted top can't be un-tilted from one photo. |
| **Stacked / leaning pieces** (cafe-01's back row, cafe-02's left pile) | Hidden pieces show only a sliver (flagged *bit?*); a leaning piece is flagged *×2?* or *shape?* (its top isn't a flat box). | No 2-D method can measure hidden area. Compare only the pieces you can see whole; remove taps on slivers. |
| **Corners loose around the board** | Board/shelf wood that's the same colour as the brownies is inside the quad, and a piece's mask spreads into it. | Put corners tight around the brownies' board. |
| **A straight crust crack** | Rare: a long, dark, straight crack is taken for a cut and part of a piece is lost. | *Settings → Cut-line sensitivity* lower; or check *Debug view → gap map AFTER*. |
| **Touching pieces with no visible cut** | Two pieces measured as one (*×2?*). | Tap the other half: one tap = one piece. |
| **Glare** | A blown-out highlight can read as paper (background) and nibble the piece. | Step sideways so the reflection moves off the brownies. |
| **Top area ≠ amount of brownie** | Thickness isn't measured, only the top area. | Out of scope. Pick the thicker of a tie by eye. |

## Possible next steps

- Run the pipeline in a Web Worker so the UI never blocks on slower phones.
- Point-prompted MobileSAM / EfficientSAM through onnxruntime-web for difficult boards
  (a ~30 MB model download; only worth it if real photos show classical segmentation struggling).
- Pinch-zoom on the result view.
