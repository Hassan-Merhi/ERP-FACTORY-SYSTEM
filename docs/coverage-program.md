# Coverage program

Raise backend and frontend coverage toward 90%+ lines/functions and 85%+
branches without lowering the bar on what a test proves. Floors live in
`config/coverage-thresholds.json` and only move up; `npm run audit:coverage-ratchet`
reports when a floor has fallen more than 5 points behind measured coverage.

## Targets

| Suite | Lines / statements / functions | Branches | Critical modules (posting, security) |
|---|---|---|---|
| Backend | 92%+ | 85–88% | 95–100% per file |
| Frontend | 90% | 82–85% | — |

The last few percent of branches are defensive `catch` blocks and adapter error
paths; they are not chased for their own sake.

## Phases

| Phase | Backend | Frontend |
|---|---|---|
| 0 | Fresh measurement, gap ranking, dead code out | Test harness, fresh measurement |
| 1 | Services and pure logic | `lib/`, hooks, contexts |
| 2 | Zero-coverage route files | Page hooks and form state |
| 3 | Imports, exports, PDFs (golden files) | Render every page with fake data |
| 4 | Branch sweep: validation, permission, tenant, rollback | Interaction tests on core flows |
| 5 | External adapters and background jobs | Branch sweep: loading/error/empty, RTL, mobile |
| 6 | Mutation testing on accounting/inventory/security | End-to-end flows (not counted in coverage) |

Every new suite is checked by mutating the code it covers and confirming the
suite fails; a suite that survives a meaningful mutation is not finished.

## Frontend test harness

- `tests/ui/fakeApi.ts`: `installFakeApi()` replaces `fetch` with a route table
  (`:param`, trailing `*`, RegExp), records calls with parsed bodies, serves the
  CSRF token and restores the real `fetch` after each test. Prefer it over
  `stubFetch()`, which answers everything with `[]` and so never reaches
  loaded-data or error branches.
- `tests/ui/fixtures.ts`: record builders typed against `shared/schema`.
  `tests/` is outside `npm run check`, so `fixtures.test.ts` compares each
  builder's keys with its Drizzle table's columns at runtime.

## Measured (2026-10-24)

Backend, full suite (1,104 files, 7,613 tests): 73.43% lines, 71.97%
statements, 77.47% functions, 60.10% branches. Global floors moved to
71/69/75/58 and eleven per-file floors on posting and security modules were
raised to match. Branches are the backend's widest gap.

Frontend, full suite on the merged branch: 37.57% lines, 35.75% statements,
27.02% functions, 27.68% branches. `lib/` (78% lines), `hooks/` (61%) and
`contexts/` (55%) hold about 2,100 of the ~46,000 uncovered lines; pages hold
about 37,800. Phase 1 therefore improves specific modules far more than the
global figure; the global figure moves with Phases 2–4.

## Backend gaps

`config/backend-coverage-gap-baseline.json` ranks the 30 files with the most
uncovered lines. The top four are the historical sales-cost repair modules in
`server/services/inventory/historicalSalesCostRepair*.ts` (about 1,000 lines at
0%), which makes them the first Phase 2 target.

## Removal candidates

Code that production never runs but that still counts against coverage. Each
needs an owner decision; none is removed by the coverage program itself.

- **Offline mode.** `OFFLINE_MODE_ENABLED` in `client/src/lib/featureFlags.ts`
  is the constant `false`, so the full offline/sync system never runs:
  `FullConnectivityProvider` in `contexts/ConnectivityContext.tsx`,
  `components/OfflineBanner.tsx`, `components/OfflinePrepPanel.tsx`,
  `components/PendingSyncIndicator.tsx`, `hooks/useFormDraft.ts` drafts,
  `lib/db.ts`, `lib/syncEngine.ts`, `lib/refPool.ts`, `lib/offlineDraft.ts`,
  `lib/offlinePrep.ts`, the offline-queue branch of `apiRequest` and the
  `TRIGGER_SYNC` handler in `main.tsx` — roughly 3,100 lines across 11 files.
  Not a mechanical delete: `lib/offlineQueue.ts` is also used by the Factory
  loading-scan purge, `useConnectivity()` has 9 consumers reading the stub
  values, and `syncEngine.ts` carries a per-file coverage floor.
- **Unimported fetch interceptors.** `client/src/lib/accountStatementPaginationClient.ts`,
  `erpDaybookPaginationClient.ts` and `accountStatementContinuousClient.ts`
  patch `window.fetch` when imported, and nothing imports them, so they never
  install. Not tested for that reason.
- **Backend modules reachable only from tests** (from `npm run report:dead-code`),
  for example `server/services/accounting/financialCloseService.ts` (which has
  a 99% per-file floor), `server/lib/trackTraceScraper.ts`,
  `server/lib/workerBalesPdfGenerator.ts` and the three
  `server/services/sp-sales-form-v2/build*Sheet.ts` builders. Deleting them
  deletes the tests that certify them, so each is decided individually.

Removed so far: `server/services/factory/historical-replay/exactApply.ts`
(superseded by `exactApplyFinal.ts`) and `server/services/syncSalesItemCosts.ts`
(a no-op shim with no callers).
