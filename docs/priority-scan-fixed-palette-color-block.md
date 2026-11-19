# Priority Scan fixed palette and color-block label integration

Implementation branch: `feat/priority-scan-fixed-11-colors-label-box` — PR #2141.

## Current approved Priority Scan palette — 2026-10-15

The authoritative **new/edited** palette now contains exactly **11 fixed colors** in this order:

1. `#9400D3`
2. `#F28500`
3. `#FFD700`
4. `#39FF14`
5. `#808000`
6. `#B22222`
7. `#6A5ACD`
8. `#000000`
9. `#B0E0E6`
10. `#DB7093`
11. `#A7FC00`

## Fixed color letters (M–W) — 2026-10-15

These eleven letters are fixed visual identifiers for the **HEX colors**, not priority queue numbers. They appear inside the Set Priority color selector and beside active priorities, and in Priority Scan's color-flash panel, queue, and condensed/detailed scan history:

| Color HEX | Fixed letter |
| --- | --- |
| `#9400D3` | **M** |
| `#F28500` | **N** |
| `#FFD700` | **O** |
| `#39FF14` | **P** |
| `#808000` | **Q** |
| `#B22222` | **R** |
| `#6A5ACD` | **S** |
| `#000000` | **T** |
| `#B0E0E6` | **U** |
| `#DB7093` | **V** |
| `#A7FC00` | **W** |

The mapping is centralized in `shared/priorityScanColors.ts` and is case-insensitive for saved HEX values. Historical colors outside the approved list show no letter. Changing queue positions never changes the letter. The mapping is **display-only**: it does not save new data, rewrite past allocations, or change queue positions. Printing now also uses the matching letter for current fixed HEX colors: a black bold **24pt** letter beside the HMD/customer logo on the uncolored 3×1.97-inch sticker, and a centered high-contrast letter inside the existing colored rectangle on A4 (**30pt**) and A5 (**25pt**). Older colors outside the fixed palette keep the previous HMD-only presentation on paper and no sticker letter. The meanings of these letters are not yet defined.

The shared `PRIORITY_SCAN_COLORS` list controls the UI, server write validation, and default selection. Removed palette colors are rejected for new assignments and explicit recolors; already saved allocation colors and printed historical snapshots are preserved and can still be displayed/reprinted. Existing priority position-only moves preserve their stored legacy colors. No historical database update or palette migration is required.

The remainder of this document records earlier verification of previous palette revisions and must not be treated as certification of this eleven-color revision. See PR #2265 for the latest change and verification status.

## Sticker-label exception — 2026-10-15

Only A4/A5 paper labels use the saved priority **color fill**. Each approved color's **fixed M–W letter** appears centered inside that rectangle in legible black/white, sized to fit (A4 25×14 mm box with 30pt letter, A5 22×12 mm box with 25pt letter). Sticker labels keep the normal HMD/customer logo, with the matching **24pt black letter directly alongside it** on a white background—no priority fill. Ordinary and legacy-colored stickers have no extra letter. Historical test records below describe earlier code and do not certify these newer print details.

## Behavior

- New/edited Priority Scan colors use the 11 values in `shared/priorityScanColors.ts`, in their fixed display order. Each active company loading must have a distinct color.
- The Pending Loadings editor renders only those swatches. Previously stored non-palette colors remain visible and recorded; saving a different color selects an approved swatch.
- Moving an existing active queue position omits `color` and sends `enabled: true` and `priority`; the server preserves the existing color and colorKey. Create/re-enable/color-change requests cannot omit an approved color.
- The print renderer uses the recorded allocation color (not the current queue palette), normalizes legacy named/short HEX values safely and rejects unsafe colors.
- On A4/A5 paper, approved priority colors replace the small HMD logo with the saved-color block containing the fixed centered M–W letter (light/dark ink is chosen for contrast); legacy saved colors retain their HMD fallback inside the block. Stickers never display a priority-color fill and instead show the ordinary HMD/customer logo with a black M–W letter next to it for an approved color. Non-priority labels keep their original logo and other content.
- A4 and A5 use the existing 25×14 mm and 22×12 mm boxes respectively, with centered letters clipped within those bounds. Legacy Pressing/Production templates retain their original 25×14 mm color box and HMD mark. Sticker layout remains 3×1.97 inches; the letter sits in a 9×10 mm monochrome space by the logo. Saved colors, barcode/reference content and historical allocations remain unchanged.
- Preflight and reprint audits reject stale mismatches between the prepared order/color and recorded order/color. The system does not rewrite historical colors or allocation snapshots.

## Local verification and Claude handoff — 2026-10-10

Status: **partially verified; PostgreSQL integration verification is environment-blocked**. All work remains on PR #2141's existing branch. No merge, production database access, historical data rewrite, workflow edit, manual Actions dispatch, or rerun was performed. The correction commit uses `[skip ci]` to prevent push/PR Actions execution, as requested. Claude must explicitly run full CI later; skipped workflow checks are not evidence of success.

Environment: Node 24.19.0, npm 11.9.0; repository pins Node 24.21.0. `npm ci` installed 1,132 packages from the unchanged lockfile and installed the existing pre-push TypeScript hook.

### Corrections

- Replaced outdated colored-HMD PNG expectations and removed-helper imports with behavioral assertions for an empty solid rounded rectangle, exact saved color, print background, unchanged surrounding markup/barcode, and original ordinary logos.
- Added recorded color to the reprint audit fixture and regressions for missing/changed/unsafe snapshots and equivalent historical named/short-HEX colors.
- Fixed an implementation defect: two different invalid preflight colors normalized to `null` and were accepted as matching. Preflight now rejects an unresolvable allocation color before comparing snapshots. The regression was executed and failed before the fix, then passed afterward.
- Added real component interaction tests for all 11 selectable/savable colors, duplicate/exhausted palette controls, absence of a custom input, role-limited controls, position-only legacy moves, and EN/AR/FR legacy notices. API calls are mocked in these UI tests; this does not certify server authorization or persistence.
- Exercised actual Pressing and Production print actions for ordinary, approved, and historical non-palette colors, inspecting generated HTML and unchanged barcode references. These are jsdom tests, not physical printer or browser-layout certification.
- Updated seven API test files' newly configured colors to the approved palette, preserving their assertions. Standalone legacy allocation/history fixtures remain unchanged. These database-backed changes are not yet execution-verified.
- Applied repository Prettier formatting to PR-touched TypeScript files. No thresholds, security checks, tests, or workflows were disabled or weakened.

### Commands and observed results

Initial focused frontend run (before corrections): **35 passed, 5 failed, 0 skipped** in 4 files:

```bash
npm run test:frontend -- client/src/lib/labelHtml.test.ts client/src/lib/priorityPrintPreflight.test.ts client/src/i18n/automaticPriorityPrintingTranslations.test.ts tests/ui/priority-scan-history-poll.test.ts
```

Focused intermediate reruns were also executed:

```bash
npm run test:frontend -- client/src/lib/labelHtml.test.ts client/src/lib/priorityPrintPreflight.test.ts
npm run test:frontend -- client/src/lib/labelHtml.test.ts client/src/lib/priorityPrintPreflight.test.ts tests/ui/priority-scan-palette.test.tsx client/src/i18n/automaticPriorityPrintingTranslations.test.ts tests/ui/priority-scan-history-poll.test.ts
npm run test:frontend -- tests/ui/priority-specialist-print.test.tsx
```

Final focused frontend run: **97 passed, 0 failed, 0 skipped**, 6 files, exit 0:

```bash
npm run test:frontend -- client/src/lib/labelHtml.test.ts client/src/lib/priorityPrintPreflight.test.ts tests/ui/priority-scan-palette.test.tsx tests/ui/priority-specialist-print.test.tsx client/src/i18n/automaticPriorityPrintingTranslations.test.ts tests/ui/priority-scan-history-poll.test.ts
```

> `tests/ui/priority-specialist-print.test.tsx` was removed in the 2026-10 dead-code cleanup
> together with the retired Production Bales and Pressing Bales pages it rendered (both routes
> redirect to Stock Entry). The runs above are the historical record.

| File | Passing tests |
| --- | ---: |
| client/src/lib/labelHtml.test.ts | 33 |
| client/src/lib/priorityPrintPreflight.test.ts | 23 |
| tests/ui/priority-scan-palette.test.tsx | 29 |
| tests/ui/priority-specialist-print.test.tsx | 6 |
| client/src/i18n/automaticPriorityPrintingTranslations.test.ts | 3 |
| tests/ui/priority-scan-history-poll.test.ts | 3 |

Database-backed run: **10 suites failed during setup/import, 0 tests collected**. This is an environment failure, not 10 failing assertions or skipped tests:

```bash
DATABASE_URL=postgresql://postgres:local_test_only@127.0.0.1:55432/priority_scan_pr2141_test PGSSLMODE=disable NODE_ENV=test SESSION_SECRET=local-pr2141-test ENABLE_SCHEDULERS=false npm run test:backend -- tests/priority-scan.test.ts tests/automatic-priority-*.test.ts
```

Every suite aborted in schema preload with `ECONNREFUSED 127.0.0.1:55432`. No PostgreSQL server/client or Docker was installed. Attempted provisioning with `apt-get update && apt-get install -y postgresql` failed before installation: the environment denied `setgroups`/`setegid`/`seteuid`. No production URL or database was used. The same localhost-only invocation was repeated after fixture corrections to confirm the blocker remained.

Additional checks: **all passed**, exit 0. Lint reported no warnings or errors. The file selection includes all original PR TypeScript files plus the corrections/new tests:

```bash
npm run check
mapfile -t priority_files < <({ git diff --name-only d00b7e1a118c986f688504384453b567696bc396 -- '*.ts' '*.tsx'; git ls-files --others --exclude-standard -- '*.ts' '*.tsx'; } | sort -u)
node node_modules/eslint/bin/eslint.js "${priority_files[@]}"
node node_modules/prettier/bin/prettier.cjs --check "${priority_files[@]}"
git diff --check
```

Formatting corrections used `node node_modules/prettier/bin/prettier.cjs --write "${priority_files[@]}"`. The shell push could not authenticate (`could not read Username for https://github.com`). The existing pre-push gate was therefore executed explicitly with `bash scripts/git-hooks/pre-push` before publishing the identical verified tree through the connected GitHub plugin with a branch-head lease. The plugin-created commit SHA is recorded in the PR description.

### Files modified in this correction

- `client/src/lib/labelHtml.test.ts`
- `client/src/lib/priorityPrintPreflight.test.ts`
- `client/src/lib/priorityPrintPreflight.ts`
- `client/src/lib/labelHtml.ts` (formatting)
- `client/src/pages/factory/PriorityScanLoadingControl.tsx` (formatting)
- `server/routes/factory/customer-orders/priorityScanConfigRoutes.ts` (formatting)
- `tests/automatic-priority-end-to-end-scenarios.test.ts`
- `tests/automatic-priority-physical-deletion.test.ts`
- `tests/automatic-priority-print-batch.test.ts`
- `tests/automatic-priority-print-loading.test.ts`
- `tests/automatic-priority-queue-recovery.test.ts`
- `tests/automatic-priority-stock-entry.test.ts`
- `tests/priority-scan.test.ts`
- `tests/ui/priority-scan-palette.test.tsx` (new)
- `tests/ui/priority-specialist-print.test.tsx` (new)
- `docs/priority-scan-fixed-palette-color-block.md`

## Integration verification — 2026-10-10 (Claude)

Run on Node 24.21.0 against a disposable local PostgreSQL 16 database (`heliumdb` on localhost, the same name CI uses), prepared exactly as CI does: `drizzle-kit push --force`, `npm run build`, application startup migrations (0 failures, `verify:startup-migrations` passed). No production database was used.

### Defects found and fixed

- **A4 preview box invisible.** The A4 detail CSS had no screen rule for `.priority-color-box`, so the empty `div` rendered 0 mm wide in the print preview window. It now has a base rule.
- **Print enlarged A5 and sticker boxes.** Every `@media print` block forced 25×14 mm, overriding A5 (22×12 mm) and sticker (20×10 mm). The printed sticker then no longer matched its preview and pushed the barcode area. Print now only forces `print-color-adjust: exact`; the size comes from the shared per-format rule.
- **Phase 7 integration fixture** still configured a loading through the API with the old `#7c3aed` preset and failed with 400 once palette enforcement was live. It now uses `#9400D3`. Direct-SQL legacy history fixtures are intentionally left on legacy colors.
- **Repository audit failure.** This doc was missing from `config/doc-index.json` and `docs/README.md`, which fails `audit:doc-index` (Repository Audits). It is registered as a reference.
- **Stale reference doc.** `docs/automatic-priority-print-loading.md` still described the recolored HMD logo; it now describes the color box.
- **Dead code.** `client/src/lib/priorityHmdLogo.ts` had no remaining importers and was removed.

### Added coverage

- `tests/priority-scan-fixed-palette.test.ts` (database-backed, 14 tests): all 11 colors active at once with canonical uppercase storage and case-insensitive input; a twelfth loading refused for every color; nine unapproved inputs rejected with nothing written (unapproved HEX, a former preset, named, `rgb()`, short HEX, padded, CSS injection, non-string, empty); color required to create/disable/re-enable; position-only move of an active legacy `#dc2626` priority keeps its color, and re-saving the legacy color is refused; recoloring never touches the bale's recorded history color; position-only moves are reserved for priority managers; another company's loading cannot be configured or moved and its active color does not block this company.
- `client/src/lib/labelHtml.test.ts`: per-format box size on screen, and no size override in print (failed before the CSS fix, passes after).

### Real browser print check

The five real generators (A4, A5, sticker, Pressing, Production) were bundled and printed to PDF in headless Chromium with `printBackground: false`, the equivalent of "Background graphics" being off, so `print-color-adjust: exact` had to carry the fill. Barcodes were served by the same `bwip-js` Code 128 options as `/api/barcode/:code`. Each document held 13 labels: the 11 approved colors, a legacy `#dc2626` bale and an ordinary bale. The PDFs were rasterized at 200 dpi and decoded with ZXing.

- 65 of 65 labels passed. Every priority label printed its exact saved color over the expected box area, within 6%, with no other palette color on the page. The ordinary label printed no priority color and kept its original logo.
- 65 of 65 barcodes decoded to exactly the input reference.
- Box geometry was identical in screen and print media and never overlapped the PIECES/ARTICLE/WEIGHT column.

Limitation: a physical label printer and a handheld scanner were not available. The check covers Chromium's print pipeline, not printer driver color profiles.

No database migration is needed. The feature uses the existing `color`/`color_key` columns, and no existing record is recolored.
