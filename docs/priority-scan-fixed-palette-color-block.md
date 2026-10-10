# Priority Scan fixed palette and color-block label integration

Implementation branch: `feat/priority-scan-fixed-11-colors-label-box` — PR #2141.

## Behavior

- The only new/edited Priority Scan colors are the 11 values in `shared/priorityScanColors.ts`, in their fixed display order. Each active company loading must have a distinct color.
- The Pending Loadings editor renders only those swatches. Previously stored non-palette colors remain visible and recorded; saving a different color selects an approved swatch.
- Moving an existing active queue position omits `color` and sends `enabled: true` and `priority`; the server preserves the existing color and colorKey. Create/re-enable/color-change requests cannot omit an approved color.
- The print renderer uses the recorded allocation color (not the current queue palette), normalizes legacy named/short HEX values safely and rejects unsafe colors.
- Where the small priority HMD logo used to appear, color-bearing labels show a plain solid rounded rectangle instead. No text or logo is inside the block. Non-priority labels keep their original logo and all other label content.
- A4 and A5 use the shared detail markup; stickers and the separate Pressing/Production label templates use the same saved-color block principle.
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
DATABASE_URL=postgresql://postgres:local_test_only@127.0.0.1:55432/priority_scan_pr2141_test PGSSLMODE=disable NODE_ENV=test SESSION_SECRET=local-pr2141-test ENABLE_SCHEDULERS=false npm run test:backend -- tests/priority-scan-wave1.test.ts tests/automatic-priority-*.test.ts
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
- `tests/automatic-priority-physical-deletion-phase6.test.ts`
- `tests/automatic-priority-print-batch-phase5.test.ts`
- `tests/automatic-priority-print-loading.test.ts`
- `tests/automatic-priority-queue-recovery-phase7.test.ts`
- `tests/automatic-priority-stock-entry-phase4.test.ts`
- `tests/priority-scan-wave1.test.ts`
- `tests/ui/priority-scan-palette.test.tsx` (new)
- `tests/ui/priority-specialist-print.test.tsx` (new)
- `docs/priority-scan-fixed-palette-color-block.md`

### Claude still must verify

Provision an isolated PostgreSQL database using the supported disposable-schema setup and run all 10 targeted integration suites and the complete required CI. Explicitly verify backend acceptance of every approved color, rejection of custom colors, duplicates, authorization, multi-company isolation, queue ordering, deletion/reopening/advancement, position-only legacy moves, and immutable historical allocations. The local UI tests cannot establish those server/database guarantees. Resolve any further integration or CI failures on this branch. Verify actual print/PDF layout, background fills and barcode scanning for A4, A5, sticker, Pressing and Production. Use the pinned Node version. Do not merge until Claude's complete verification is green.

No database data migration is required or authorized to recolor existing records.
