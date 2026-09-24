# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Comparador ΔE — a static, client-side web tool (no server, no build) that compares two revisions of a design file (packaging artwork, typically PDF/.ai) and highlights color and text differences. Everything runs in the browser: file parsing (PDF.js), color math (Web Worker), OCR (Tesseract.js), and PDF rewriting for overprint simulation (pdf-lib) — no file ever leaves the user's machine.

## Running it

There is no build step, no `package.json`, no npm install. Open `index.html` directly in a browser, or serve the directory with any static file server (e.g. `python3 -m http.server`) and visit `/index.html`. Third-party libraries are vendored under `lib/` (pdf.js, pdf-lib, Tesseract.js) and loaded via plain `<script>` tags — script load order in `index.html` matters and mirrors the dependency order between modules (see Architecture).

There is no automated test suite. Verification is done manually via headless Chrome against harness pages (see Verification below).

## Architecture

The app is organized as strict layers around one engine. **Read the header comment at the top of each file before editing it** — every file states its own boundaries (what it may and may not touch), and those boundaries are load-bearing, not incidental.

- **Engine (`de-worker.js`)** — the only piece that computes ΔE. Runs as a classic Web Worker (`new Worker('./de-worker.js')`), receives `{type:'compute', width, height, threshold, minSizePct, bufA, bufB}` via `postMessage` with transferable buffers, and replies with `progress`, `regionsResult`, and the final diff result. It only ever sees raw `ImageData` — never PDFs, files, or DOM. The core color math (`rgbToXyz`/`xyzToLab`/`deltaE2000`) is marked "NO TOCAR" (byte-identical to the original implementation) — treat it as frozen unless the user explicitly asks to change the algorithm.
- **Input layer** — turns arbitrary user files into the normalized `{drawable, naturalWidth, naturalHeight}` shape the rest of the app expects, and computes the alignment transform between A and B. Never touches the engine or the DOM result views.
  - `pdf-source.js` — loads PDF/.ai (PDF-compatible) and JPG/PNG, renders to canvas.
  - `overprint.js` — rewrites the PDF **in memory only** (via pdf-lib, never touching disk) to translate `/OP`/`/op` overprint states into `/BM /Multiply`, since PDF.js ignores `/OP` but honors `/BM`. Always applied identically to A and B (asymmetric application would fabricate diffs). This same pdf-lib parse also feeds `reliability.js`'s facts (encryption, output intent, annotations, embedded fonts) so the file is only parsed once. See known limits in memory `pdfjs-blend-modes-and-groups` (page `/Group` is ignored by PDF.js; XObject transparency groups are always isolated, so overprint inside a grouped/knockout XObject can't be simulated).
  - `align.js` — manual alignment by up to 2 reference points per image (0/1 point = translation only; 2 points = + scale/rotation via `similarity.js`).
  - `vector-picker.js` + `vector-geometry.js` — third alignment method: click a real vector element in A, auto-match the equivalent element in B by shape similarity. Writes into the *same* `pointsA`/`pointsB` state as manual clicks (via `setPointsFromVector` in `align.js`) rather than a parallel store.
  - `physical-align.js` — used specifically for PDF/.ai-vs-PDF/.ai, where scale is locked to 1:1 and rotation to 0 (artwork isn't rescaled between revisions, only repositioned on the page). Computes offset in **PDF points** (`px / viewport.scale`, never derived from the rounded integer canvas size) and re-renders B already shifted via PDF.js's viewport offset — no bitmap resampling. Falls back to `similarity.js`'s general transform when scale is unlocked or either file is raster.
  - `similarity.js` — general similarity transform (translate + scale + rotate) from 2 reference points; also builds the non-comparable-area mask.
  - `nudge.js` — shared keyboard fine-adjustment (arrows = 1px, Shift+arrows = 10px) for any registered point marker, used by both `align.js` and `vector-picker.js`.
  - `viability.js` — pre-flight check before comparing: estimates memory needed at the fixed analysis resolution (`ANALYSIS_DPI` in `app.js`) vs. available, and probes the browser's real max canvas size (fails silently in Safari, so it must be measured, not assumed). Decides whether `app.js` blocks or asks for confirmation before running the engine.
  - `reliability.js` — pure presentation layer; derives a green/amber/red per-file reliability badge purely by interpreting facts already computed by `overprint.js` and `text-analysis.js`. Does not parse anything itself.
  - `text-analysis.js` — detects live vs. outlined text, extracts text (live text or OCR via Tesseract.js), word-diffs A vs. B. Reads `sourceA`/`sourceB` and the engine's last result, but doesn't touch pixel comparison.
- **Presentation layer** — consumes engine/input-layer output, never computes comparison results itself.
  - `canvas-view.js` — main viewer: zoom/pan via CSS transform, pixel-inspection loupe, keeps the region-box canvas in sync with the image canvas.
  - `regions-panel.js` — draws difference-region boxes on a canvas stacked above the image (never inside the engine's `ImageData`) and drives the region list panel; only reads results already computed by the worker (`regionsResult` message).
  - `app.js` — orchestration: file lifecycle (raster/PDF/.ai), tabs, driving `compare()`, staged progress UI, export. This is the only place that talks to the worker directly; its contract with the engine is "send `ImageData`, receive results" — it must not duplicate color math.

When changing one file, check whether its header comment names files it explicitly must not affect — that constraint is usually the point of the layering.

## Working conventions

- No semicolon-free style, no framework — plain ES2020+ browser JS, dense/minified-by-hand formatting (e.g. `const a=1,b=2;`) is the existing house style; match it rather than reformatting to a looser style.
- `app.js` keeps a `VERSION_HISTORY` array (newest first, max 5 entries) shown in the in-app version modal — when a change is user-visible, add an entry there following the format described in the comment above the array (numeric `version`, `date` as `AAAA-MM-DD`, `changes` as at most 2 sentences).
- `ANALYSIS_DPI` (in `app.js`) is the single fixed analysis resolution; there is deliberately no user-facing DPI selector anymore (removed in v17 in favor of the viability pre-flight check).
- Brand/design tokens live in `design-system/` and are summarized in `DESIGN.md`, including a list of deliberate exceptions (e.g. the black viewer background, the ΔE severity colors, the reliability traffic-light colors) that must **not** be changed to match brand tokens — they're algorithm output or accessibility-driven, not decoration. Read `DESIGN.md`'s "Excepciones deliberadas" section before touching any color in `index.html`'s CSS.
- Repo comments and commit history are in Spanish; match that when editing existing files.

## Verification

There's no Node/npm and no headless test runner wired up — manual verification uses headless Chrome driven against harness pages (see `pruebas/bandas/harness.html` for the pattern: serve the repo over HTTP, load `index.html` in an iframe, drive it via `window.eval` calls like `handleFileSelected`/`compare()`, POST results back to a small local server since `--dump-dom` hangs when PDF.js module workers are involved). `pruebas/` is git-ignored — it holds local verification captures/fixtures, not shipped code. Known raster-vs-vector rasterization residuals (ΔE ≲ 6 on diagonal edges, band-boundary artifacts) are expected and documented, not bugs to chase.
