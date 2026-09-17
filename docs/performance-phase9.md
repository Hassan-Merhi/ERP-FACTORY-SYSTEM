# Phase 9 — Build and performance polish

## Spreadsheet loading

The Spreadsheet Editor is intentionally lazy at two levels:

- The page is loaded through `client/src/lazyPages.ts`.
- Spreadsheet parsing, ExcelJS synchronization, and native XLSX download are loaded only when the corresponding operation is used.

The Vite build keeps the heavy dependencies separate:

- `fortune-sheet-vendor` contains the spreadsheet canvas and remains route-triggered.
- `exceljs-vendor` contains ExcelJS parsing/synchronization and is loaded by spreadsheet or export flows.
- `xlsx-vendor` contains the native XLSX writer and is loaded by XLSX export flows.

The route entry itself is therefore small; the large dependency files are not part of the initial ERP shell payload. The large Fortune Sheet and ExcelJS/XLSX files are expected tradeoffs for the capabilities they provide and are not bundled into the server artifact.

## Remote-support perceived-speed safeguards

The screen-feed polling fallback is intentionally conditional:

- `GET /api/screen-feed/:userId` returns a private weak ETag for a frame and honours `If-None-Match` with `304 Not Modified`.
- The validator remains active when the fast/SSE transport is disabled or reconnecting, because that is when the viewer falls back to regular polling and an unchanged screenshot would otherwise be retransmitted.
- The ETag is derived from lightweight frame metadata rather than re-hashing the image data URL on every poll. The viewer retains the last frame only for a `304`; a `200` response with no frame clears an expired frame.

A watched employee tab also treats CSS-driven changes as visual updates. Its capture observer includes `class` and `style` alongside the existing semantic state attributes, then settles and rate-limits captures through the dirty-frame scheduler. This avoids waiting for the 60-second idle refresh when a page changes visually without a click or input event.

Remote-control viewer discovery no longer performs a full-document scan for every ERP DOM mutation. A shallow body observer discovers Radix portal roots, scoped observers inspect only those roots for watch-dialog lifecycle changes, and a short debounce coalesces mount/unmount bursts before target/session state is refreshed.

Screen-feed capture cost is kept off the employee's main thread as far as a full-page screenshot allows:

- `color-mix()` is resolved at build time (`build/viteCssColorMixPlugin.ts`) so html2canvas never has to parse CSS Color 4 functions.
- Clone sanitization no longer walks every element with `getComputedStyle`. Filters, blend modes, and pseudo-element decorations are stripped with one injected stylesheet; only images and inline background URLs are inspected.
- JPEG encoding is a single resize + `toDataURL` pass instead of a five-step quality ladder.

## Remaining build warnings

### PostCSS `from` warning

The warning:

> A PostCSS plugin did not pass the `from` option to `postcss.parse`.

comes from the current Tailwind CSS 3 plugin path. Tailwind's internal preflight/rule generation calls `postcss.parse` without forwarding a source filename. The project also contains Tailwind 4 tooling, but the application currently uses the Tailwind 3 configuration and directives. Migrating the whole stylesheet pipeline would be a broader visual-risk change, so the warning is documented rather than suppressed or patched inside `node_modules`.

### ExcelJS `eval` warning

The warning points to the upstream minified `exceljs` browser distribution. It is emitted by Vite's dependency scanner because that upstream file contains an `eval` expression. ExcelJS is required for workbook fidelity and advanced spreadsheet features; replacing or modifying the vendor bundle would risk import/export behavior. The warning is retained and documented rather than hiding it or changing the package contents.

## Verification

The Phase 9 build checks remain:

- TypeScript check
- Production Vite build
- Server bundle verification
- Runtime dependency verification

The build should continue to report the documented PostCSS and upstream ExcelJS warnings while passing all verification steps.