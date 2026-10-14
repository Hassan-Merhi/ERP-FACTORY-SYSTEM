# Dead-code cleanup — final report and handoff

Branch `refactor/erp-dead-code-cleanup` (mirrored to `claude/blissful-bell-w6imct`).
Baseline: `main@3a210f315ddba5aaf0bbe6dee21b5d5e3417b97f`. Merged into `main` on 2026-10-14 at the owner's instruction.

> Phases 3–13 were verified statically only. The §14 validation was then run with the owner's
> approval on 2026-10-13, after merging `origin/main@0599a9bab`; results are in
> "Validation run" below. No deployment or live-database migration was run.

Per-phase evidence: [`archive/engineering/dead-code/`](archive/engineering/dead-code/).
Standards going forward: [dead-code-prevention.md](dead-code-prevention.md).

## 1. Executive summary

Up to the Phase 12 commit (`8358f050d`), the branch changes 565 files against the baseline: **228 files deleted, 49,928 lines removed,
5,345 added** (most additions are the phase records and route-disposition JSON). Tracked
files fell from 5,765 to 5,554. Deleted source files alone held 40,350 lines.

The work removed unreachable Express registrations (64 in total across both Phase 3
sessions), fourteen unmounted route registries and barrels, 175 unreachable client files and
eight unused lazy page exports, 244 unused exported declarations and about 420 unused locals,
superseded backend modules, 22 unused npm packages, six one-shot source-rewriting scripts,
and it consolidated three groups of byte-identical helpers. Static checks found **no new
TypeScript diagnostics** in application code or tests compared with the baseline, no
unresolved import, and no source-text assertion broken by a removal.

It also surfaced findings that need an owner decision rather than a deletion — most
importantly, code that tests certify but production never runs (§12).

## 2. Phase status

| Phase | Status | Files changed | Commit(s) |
|---|---|---:|---|
| 1 Inventory | Complete (earlier session) | — | `caea9a3`, `f5346f1` |
| 2 Dead files | Complete (earlier session) | — | `c9d7e94` … `bafd409` |
| 3 Routes | Complete: 56 removals earlier + 8 removals and 14 dead registries now; 0 ambiguous overlaps left | 37 (this session) | earlier `3b89831` … `457c44a`; now `edb7b106` |
| 4 Frontend | Complete: 175 files deleted | 198 | `a7864e134` |
| 5 Declarations | Complete: 244 exports, ~420 locals, 9 emptied modules | 231 | `f44af72c6` |
| 6 Backend modules | Complete: 6 modules (+3 tests) | 13 | `ff574f1da` |
| 7 Consolidation | Complete (high-confidence scope) | 48 | `749554be8` |
| 8 Dependencies | Complete: 22 packages, 31 lock entries | 4 | `50cc1593a` |
| 9 Scripts/config | Complete: 8 files; `build.mjs` awaits confirmation | 9 | `57f96e4ff` |
| 10 Database | Complete: reviewed, nothing removable | 1 | `4cc894407` |
| 11 Assets/docs | Complete: assets/styles all used; records archived | 20 | `155a962e9` |
| 12 Prevention | Complete: standards, checklist, `report:dead-code` | 6 | `8358f050d` |
| 13 Final review | Complete (static) | see commit | the commit adding this report |

## 3. Files deleted

228 against the baseline: 178 under `client/` (175 in Phase 4, 2 in Phase 2, plus one emptied
module in Phase 5), 33 under `server/` (route files and registries in Phase 3, emptied modules
in Phase 5, superseded modules in Phase 6), 8 test files that only exercised deleted code,
7 scripts and 2 root configs. Complete lists: the Phase 2 and 3 reports, the appendix of
`phase-4-report.md`, and the tables of the Phase 5, 6 and 9 reports.

## 4. Files modified

319 files modified and 4 renamed with rename detection (the Phase 13 commit adds this report and small doc fixes). The large groups: route registries and
the route manifest (Phase 3), `lazyPages.ts`, `offlinePrep.ts` and page-mount test suites
(Phase 4), ~220 source files with unused declarations removed (Phase 5), fetch guards,
pagination routes and shared modules (Phase 7), `package.json`/`package-lock.json`/
`renovate.json` (Phase 8), and docs/config indexes (Phases 11–13).

## 5. Functions and exports removed

244 exported declarations (full list in `phase-5-report.md`), 37 unused copies of duplicated
helpers (Phase 7), and ~420 unused locals/imports (many were dead code renamed with a `_`
prefix). Examples: unused storage functions (`createVoucherEntry`, `getAllVouchers`, …), the
retired SP cut-over handlers, AIS live-tracking and automated container-tracking services
(permanently disabled in `66c6aa5f3`), `serveStatic` in `server/vite.ts` (production uses
`server/startup/staticServing.ts`).

## 6. Duplicate implementations consolidated

`isRecord` ×7 → `shared/typeGuards.ts`; `parsePositiveInt` ×10 → `server/lib/listPagination.ts`;
fetch-guard `resolveRequestUrl`/`requestMethod` ×5 each → `client/src/lib/fetchRequestInfo.ts` (folded into main's `fetchRequestUtils.ts` at the second main merge);
three unused payroll copies of `findOrCreateLedger`/`computeMonthlyPay*`/`workerUpload` and the
unused `classifyBalesByFinalization` copy removed. Financial helpers that are identical but
separately audited (Golden Coast `money()`, payroll `computeMonthlyPay`) were deliberately left.

## 7. Dependencies removed

`@radix-ui/react-accordion`, `-aspect-ratio`, `-context-menu`, `-menubar`,
`-navigation-menu`, `-slider`, `-tabs`, `-toggle`, `-toggle-group`, `embla-carousel-react`,
`input-otp`, `vaul`, `react-resizable-panels`, `memorystore`, `passport`, `passport-local`,
`@types/passport`, `@types/passport-local`, `next-themes`, `react-icons`, `tw-animate-css`,
`zod-validation-error`. `package.json` and the lockfile root agree; 31 orphaned lock entries
were pruned by a resolution-aware walk. **`npm ci` has not been run.**

## 8. Scripts and configuration removed

`scripts/pr1559-self-fix.mjs`, `phase3-wire-capacity-locks.mjs`, `phase3-preflight-patch.mjs`,
`phase3-finalize-creation-locks.mjs`, `phase4-remaining-type-safety.mjs`,
`apply-phase9-batch-a-streaming.mjs`, `vitest.revision-policy.config.ts`,
`delete-safe-branches.sh`. Added: `scripts/report-dead-code.mjs` and `npm run report:dead-code`.

## 9. Routes removed or consolidated

Route manifest: 2,132 → **2,068** registrations; repeated signatures 123 → **65**; extra
registrations 141 → **77**; `MAX_SHADOWED_REGISTRATIONS` tightened 143 → 77. All 65 remaining
overlaps are classified with `next()` evidence in `phase-3-route-disposition.json` (permission
gates, conditional lifecycle dispatch, pagination/language fallbacks, guards, wrappers). The
manifest was edited from static evidence, **not regenerated**.

## 10. Assets and documentation

All 23 public assets and 13 stylesheets are used (label art via dynamic slug paths). Phase
records, three stale root audit reports and the generated CodeQL inventory were moved to
`docs/archive/` and classified in `config/doc-index.json`; the earlier phases' records had
been unclassified, which would have failed `npm run audit:doc-index`. Reference docs that named
deleted files were updated.

## 11. Preserved compatibility and retained code

- Migrations, the drizzle journal, startup-schema modules and every `shared/schema` table
  definition and type contract (drizzle-kit and live tables depend on them).
- Database repair/backfill/diagnostic scripts; `build.mjs` (see §12).
- Hidden features: container planner (#1765), remove-from-stock tab.
- Code pinned by source-text safety tests: `historical-replay/exactApply.ts` and `types.ts`,
  `operationalAlertRuntime.ts`, `salesReportBandwidthClient.ts`, `AuditLogUtils.tsx`,
  `syncSalesItemCosts.ts`, the i18n audit-compatibility constant.
- Test-only accounting, costing and audit services listed in `phase-6-report.md`.
- `config/voucher-write-evidence-review.json`, `scripts/audit-write-evidence.mjs` and
  `tests/voucher-path-phases5-8.test.ts` still name `server/routes/containers/offload/create.ts`
  (deleted in the first Phase 3 session). They are a mutually pinned historical review with a
  fixed count of 22; the audit only reads existing files, so the entry is inert. Rewriting the
  review was left to its owner. `config/backend-coverage-gap-baseline.json` and `.agents/memory`
  notes also mention files deleted earlier; both are historical snapshots.

## 12. Known risks and items needing a decision

1. **Unmounted code certified by tests** — resolved by the owner decisions below, except
   `stats/statsNetProfitResilience.ts` and the `ApprovalsPage`/`BusinessAlertsPage` backends (UI
   removed 2026-06-25, routes still live), which remain open.
2. **`build.mjs`** is live: the Render service `system` builds with `npm ci && node build.mjs`
   (read from the Render dashboard, not changed). `render.yaml` still says `npm run build`, so
   the blueprint and the dashboard disagree; `build.mjs` also runs
   `tests/phase3-accounting-audit.test.ts` as a deploy gate.
3. **`@typescript/native`** (`npm:typescript@7.0.2`) ships a second `tsc` binary; kept by owner
   decision. Which `tsc` `npm run check` resolves is still a toolchain question.
4. The manifest edits, the lockfile edits and the test-suite case removals are unverified until
   §14 runs. Order-sensitive DB mocks were checked for the files where unused reads were
   removed; others could exist.
5. `origin/main` (59 newer commits) was merged into the branch in `7265326db`. Only
   `package.json`, `package-lock.json` and one deleted test conflicted; main's version bumps
   were kept and the Phase 8 removals re-applied to its lockfile. The merged tree has no
   unresolved imports and no new TypeScript diagnostics compared with `origin/main`, but the
   merged lockfile is as unverified as the rest until `npm ci` runs.
6. 1,590 exports used only inside their own module remain (cosmetic backlog; un-exporting them
   would touch hundreds of files and collide with concurrent work).
7. The "unwritten audit item diffs" reported here earlier were a misreading: `_itemDiff`,
   `_adjItemDiff` and `_xfrItemDiff` are all spread into the audit entry (`extra` / `changes`),
   on `main` as well. Nothing to change.
8. `eslint.config.js` no longer ignores `_`-prefixed local variables (see Phase 13 follow-up
   below). The static scan found none left, but ESLint itself has not been run.

## 13. Verification skipped during the phases (as instructed)

Not run: CI, unit/integration/browser/E2E tests, `npm ci`/`npm install`, `npm run check`,
`npm run lint`, production build, route-manifest regeneration, audit/verify scripts,
migrations, deployments. Static checks that were run: TypeScript parse/bind diagnostics
compared with the baseline in a separate worktree (application code: 0 new; tests: 0 new
module/export errors), module-graph import resolution (0 unresolved), source-text assertion
re-evaluation for every edited file, Prettier formatting of edited files, JSON validity of
edited configs, `node --check` of the new script.

## 14. Recommended validation (run in order)

```bash
npm ci                                  # validates the edited lockfile
npm run check                           # full type check
npm run lint                            # zero-warning ratchet
npm run test:backend -- route-manifest  # manifest must match without UPDATE_ROUTE_MANIFEST
npm test                                # backend + frontend suites
#   in particular: customer-order-crud-write-routes, wave10-engine-consolidation,
#   ui/stock-transfer-form-revision-behavior, ui/factory-mobile-route-registry,
#   ui/fetch-guards-behavior, multi-currency-integration, factory-bilingual-completion
npm run audit:doc-index && npm run audit:scripts && npm run audit:write-routes
npm run audit:company-scope && npm run audit:source-text-assertions && npm run audit:god-files
node scripts/audit-write-evidence.mjs
node scripts/verify-stock-transfer-revision-lifecycle.mjs
node scripts/verify-group-a-phase-3.mjs
node scripts/verify-program2-phase4-pos-stock-transfers.mjs
node scripts/verify-program2-phase8-rentals.mjs
node scripts/verify-bandwidth-phase-3-sales-report.mjs
node scripts/verify-wave3-api-payload-bandwidth.mjs
node scripts/audit-realtime-wave3.mjs && node scripts/audit-i18n-phase14.mjs
npm run build && npm run verify:server-bundle && npm run verify:runtime-dependencies
```

If the route-manifest test reports a difference, regenerate with `UPDATE_ROUTE_MANIFEST=1`
only after confirming the difference is one of the removals listed in §9.

## Phase 13 follow-up — `_`-binding backlog cleared

After the first handoff, the remaining `_`-prefixed dead bindings were removed with
syntax-only edits: 302 object-destructuring entries, 33 array-destructuring slots, 20
`catch (_e)` bindings, 4 fully dead `useState` lines, unused context-hook reads in 14 components and one unused
`companies` query in `customers-core/statement-excel.ts`, and the unused
results of 5 `useQuery` calls (the queries themselves are kept, so network behaviour is
unchanged). Static re-check: 0 TypeScript unused-declaration diagnostics, 0 new diagnostics
against the previous commit, 0 broken source-text pins. `varsIgnorePattern` was then removed
from the ESLint unused-vars rule. Remaining `_` names are rest-omit keys (23), parameters and
caught errors, which the rule still allows.

## Owner decisions applied (2026-10-13)

| Item | Decision | Outcome |
|---|---|---|
| Ledger balance: `accounts/ledger-balance.ts` vs live `accountCurrencyRoutes.ts` | implementer's choice | The live handler stays canonical. The unmounted copy differs on figures (a customer-owned ledger rolls into the customer; a linked bank is not folded in), so switching would change reported balances, which a cleanup must not do. The unmounted copy, `tests/ledger-balance-exact.test.ts` and the one assertion in `tests/wave10-engine-consolidation.test.ts` that called it are deleted. `tests/wave17-reporting.test.ts` tests the live route and is unchanged. |
| `linkProformaAtomic.ts` | link it | `PATCH /api/factory/customer-orders/:id/link-proforma` now calls `linkOrderProformaAtomically`: one transaction with the proforma capacity lock and `FOR UPDATE` on the order. **Behaviour change:** as designed in #1411, a link made during loading is reference-only. It no longer backfills `customer_order_expected_lines` from the proforma (`linesBackfilled` is 0), and re-linking the same proforma is a no-op that keeps a customised plan. `tests/customer-order-crud-write-routes.test.ts` is updated to that contract. The response shape and error statuses are unchanged. |
| Unrouted UIs | give each a route | `/accounts/historical-openings` (Admin, Owner, Developer with Accounts access, the roles the save endpoint accepts) renders `HistoricalOpeningResolver`. `/factory/catalog-translations` (an alias of the Bale Explorer access, hidden with the Bale Products tab) renders `FactoryCatalogTranslationEditor`. `StockTransferRevisionHistory` is a panel, not a page: the stock-transfer form now renders it in place of its inline copy. The inline copy still had the "Reference only" switch, whose endpoint answers 409 since revisions became immutable, and it showed no lifecycle status. `scripts/verify-group-a-phase-3.mjs` already treated the component as the admin history. |
| Pagination interceptors | delete if not usable | Kept. They are usable and are installed: `build/vitePhase1PaginationPlugin.ts` injects `containerPaginationClient` into `main.tsx` at build time, and that module imports the supplier one. Without the supplier interceptor, a supplier's purchase-order dialog would show only the first 100 rows. The Phase 4 note calling them "never installed" was wrong (see the regression below). |
| Audit item diffs | save or remove | Already saved (item 7 above). |
| `build.mjs` | look it up | Live (item 2 above); kept. |
| Container planner, remove-from-stock tab | stay | Kept hidden. |
| Test-only accounting, costing and audit services | keep | Kept. |
| `@typescript/native` | keep | Kept. |

**Regression found and fixed (`a1f08d895`).** The Vite build plugins rewrite source at build
time and throw when an exact target is missing. Phase 4 deleted
`client/src/lib/accountStatementPaginationClient.ts`, which the Phase 1 pagination plugin
imports into `main.tsx`. The `_`-binding cleanup deleted
`const { toast: _toast } = useToast();` from `SalesReportLegacy.tsx`, which the always-on sales
report invalidation plugin rewrites. Either one would have failed `vite build`. Both are
restored. Running every always-on plugin transform over `client/src` (string transforms
only) now matches `origin/main` file for file. Type-checking the transformed output finds no
diagnostic that `origin/main` lacks. `report-dead-code.mjs` now counts relative imports
written by the build plugins as production roots; it had seen only `@/` ones, which is how
both deletions slipped through.

## Validation run (2026-10-13)

Run in the session container against a local, disposable PostgreSQL 16 database, using CI's
environment (`NODE_ENV=test`, `drizzle-kit push --force`, one app boot for startup migrations).

| Check | Result |
|---|---|
| `npm ci` | passes (edited lockfile installs) |
| `npm run check` | 0 errors (after fixing 2 type errors from the revision-panel change) |
| `npm run lint` | 0 errors, 0 warnings (after fixing 11 warnings and 1 error left by the `_`-binding pass) |
| `npm run build`, `node build.mjs` (Render's command, with the Phase 3 accounting gate) | pass, including server-bundle, artifact and runtime-dependency verification |
| Startup migrations (`verify:startup-migrations`) | 0 failures |
| Backend suite | 7,045 tests: 7,033 pass, 0 fail, 12 skipped (the suite's own conditional skips) |
| Frontend suite | 2,147 tests: all pass |
| Audit and verify scripts in §14 (26 scripts) | all pass |

The first run found 16 backend and 3 frontend failures. Ten were this branch's: tests still
pinned on removed dead code, the route manifest, the write-route sweep, and Factory tab toggles
read only by orphan pages. They are fixed in `fe6662055`, `1e6bb2ed9` and `0a5d708d2`. Where
a test certified code that was removed as unreachable, it now checks the code that serves the
path; no assertion on live behaviour was weakened.

The rest also failed on `origin/main` and are fixed in `e0366b058`:
- Supertest 7.3 (main's dependency update) closes an agent's own server when its last request
  settles. `exchange-rate-daily-popup` nested a request inside another's arguments, and the
  route matrix raced the close after its SSE timeout. The first now reads today's date first;
  the second listens on its own server.
- The Phase 27 WhatsApp tests stubbed `fetch`, but Green API reads use `node:https` since #2204,
  so they reached the real network. They now mock `node:https`.
- A modal Radix dialog left open at Testing Library cleanup kept `pointer-events: none` on
  `<body>`, breaking clicks in later tests (AdvancesView). The UI test setup clears it.
- `verify-program2-phase8-rentals.mjs` checks the phase 22 posting-engine call instead of the
  retired inline `normEntry` markers.
- `audit-i18n-phase14.mjs`: 84 strings get Arabic and French entries in
  `phase3RemainingTranslations.part28.ts`; six internal codes and errors join the reviewed
  technical values. The audit now reports 0 actionable literals.
- The remote-control allowlist drops `view`, `view-invoice` and `view-profitability`, which
  have no annotated control left; the registry test and the remote-support E2E use
  `view-details`.

**Re-validated after merging `origin/main@b1e633768` (2026-10-14):** `npm ci`, check, lint
(0/0), `node build.mjs`, all 26 scripts and the frontend suite (2,147) pass. The backend suite
(7,053) showed two failures, both fixed in `c38ee7fdb`: an audit-table name in the new
change-customer test, and the PDF statement test, which main's #2224 had broken. The merge
also adds tests and translations for main's new change-customer route.

## Follow-up commits

- `af159468b` — `_`-binding backlog cleared and ESLint `varsIgnorePattern` removed (above).
- `a1f08d895` — build-plugin transform targets restored (above).
- The owner-decision commit that follows it applies the table above.
- `fe6662055`, `8e2d90103` (merge of `origin/main@0599a9bab`), `1e6bb2ed9`, `0a5d708d2`, `e0366b058`, `f4c3b730d` (merge of `origin/main@b1e633768`), `c38ee7fdb` — validation-run fixes (above).
- `7265326db` — merge of `origin/main`; stale `config/company-scope-review.json` entry for the
  stock registrar deleted in the first Phase 3 session removed (that audit fails on stale rows).

## 15. Branch and commits

`refactor/erp-dead-code-cleanup`, this session: `edb7b106` (Phase 3), `a7864e134` (4),
`f44af72c6` (5), `ff574f1da` (6), `749554be8` (7), `50cc1593a` (8), `57f96e4ff` (9),
`4cc894407` (10), `155a962e9` (11), `8358f050d` (12), and the Phase 13 commit that adds this
report. Earlier sessions: Phases 1–3 commits from `caea9a3` through `3024089`.
