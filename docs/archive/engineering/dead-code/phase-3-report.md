# Phase 3 — Duplicate and unreachable API route cleanup

**Status:** Static, evidence-backed Phase 3 cleanup completed and committed. Remaining uncertain route overlaps retained rather than blindly deleted.  
**Repository:** `Hassan-Merhi/ERP-FACTORY-SYSTEM`  
**Branch:** `refactor/erp-dead-code-cleanup`  
**Baseline:** `bafd409ca709e6a60760764a9f50d1223a3cb883` (end of Phase 2)  
**Detailed evidence:** [phase-3-route-disposition.json](./phase-3-route-disposition.json)  
**Execution policy:** No CI, tests, typecheck, build, server execution or deployment was run.

## Summary

| Metric | Before | After | Change |
|---|---:|---:|---:|
| Express route registrations in ordered manifest | 2,132 | 2,076 | **−56** |
| Method + path signatures with multiple registrations | 123 | 70 | **−53** |
| Extra route registrations beyond one per signature | 141 | 85 | **−56** |
| Middleware mounts in the manifest | 130 | 130 | No change |
| Removed obsolete source files | 0 | 3 | `server/routes/containers/offload/create.ts` plus two obsolete stock registrar modules |

The 123 starting overlap signatures were taken from the Phase 1 ordered manifest. Every removal is listed by signature, before/after count, class and reason in the companion JSON file. **An overlap is not itself evidence of dead code.** The static review retained active guards, conditional fallthrough and test-imported source code where runtime reachability could not be proven.

## Changes made

| Change | Registrations removed | Evidence and safeguards |
|---|---:|---|
| Factory transporter, production planner, end-production registrar duplicates | 16 | `factoryRoutes.ts` already registers these entire suites before their second registrations in `applicationRoutes.ts`. The handlers do not call `next()`. Removed *only* later duplicate registrar invocations and their unused imports, leaving all three first registrations in place. |
| Legacy container-offload create route | 1 | A lifecycle guard calls `next()` to reach the earlier canonical `centralContainerOffloadRoute.ts` POST handler; that handler responds without passing to the later legacy POST. Deleted `containers/offload/create.ts` and its registrar wiring. Preserved the guard, central POST/PATCH handlers, reverse-offload and charge reader. |
| Legacy factory raw-stock available-containers reader | 1 | The corrected `rawStockAvailableContainerRoutes.ts` GET is deliberately registered before the old `rawStockAdjRoutes.ts` duplicate. Removed only the unreachable GET and its unused import. |
| Superseded SP migration cutover handlers | 7 | Phase 4 cutover routes are registered ahead of the older suite. Removed duplicate old cutover GET/POST registrations; retained the old module's **write guard, schema initialization and unique suspense/charge mapping endpoints**. |
| Superseded global transaction list and voucher-type readers | 2 | The central global-transaction suite is registered earlier inside the factory router. Removed legacy duplicate collection GET handlers, preserving unique voucher detail and voucher-entry views. |
| Superseded SP sales and container migration-copy endpoints | 2 | The newer Phase 2 migration registrar is registered earlier and owns these two POST paths. Retained the unique profit-opening handler and cleaned orphaned imports/types. |
| Older factory container-document and freight GETs | 2 | `factoryContainerReadAccessRoutes.ts` registers first and handles these reads. Removed only the older GET implementations; document and freight mutations remain. |
| Older cash/bank revaluation GET | 1 | `ledgerRoutes.ts` registers `accountCurrencyRoutes.ts` first. Removed the later `bankAssetRoutes.ts` duplicate, preserving fixed-assets routes. |
| Older SP final-verification GET | 1 | Phase 4's verification endpoint owns the path first. Removed later registrar and route, keeping separately exported verification helpers/types used by tests. |
| Entirely shadowed stock-item management and price-list/import registrars | 17 | `stockRoutes.ts` already mounts canonical split stock handlers before the two later legacy registrar modules. Both obsolete modules were deleted; the test import of the latter was redirected to the live import registrar. |
| Old per-module rental payment DELETE handlers | 3 | The atomic `centralRentalPaymentDeletionRoute.ts` handler registers before the obsolete delete in `rentalPaymentsAccrualRoutes.ts` for Properties, ERP and Factory. Preserved every other rental endpoint and financial guard. |
| Later SP rehearsal rollback endpoint | 1 | The Phase 2 SP migration router responds first; the later old all-in-one rollback route was shadowed. Kept preview, run history, and disabled rehearsal endpoint. |
| Later ledger balance and currency-balance GETs | 2 | The earlier `accountCurrencyRoutes.ts` owns these requests. Removed the later account registrar call, retaining its test-imported legacy module so existing test source remains importable. |
| **Total** | **56** | No active first registration was intentionally removed. |

All 56 removed registrations were reflected in `config/route-manifest.json` while preserving the order and guard chains of the other entries. The manifest was updated from static source evidence, **not regenerated by executing the application**, because the owner explicitly disabled tests/builds/CI during cleanup.

## Remaining 70 repeated signatures

The post-cleanup manifest still contains **70 method + path signatures with multiple registrations**, corresponding to **85 extra registrations**. **Do not interpret this as 108 dead handlers.** They include:

- Early action-permission gates and later business handlers (`permissionBoundaryRoutes.ts`).
- Pagination-aware readers that intentionally hand unpaginated requests to existing compatibility routes.
- `POST /api/sp/offload` concurrency/preparation guards and its business handler.
- French-language category/product dispatch and fallback.
- Historical-date response decoration for `GET /api/factory/net-position`.
- The protected factory upload download handler, which deliberately calls `next()` for non-container-document folders.
- Customer-order charge ledger prerequisites that call `next()`.
- SP cutover `app.all` fallback that denies unsupported methods.
- Historical financial, stock revision, voucher and repair flows where route reachability cannot be safely inferred from the manifest alone.

The JSON classifies all 70 retained signatures and their reasoning. **16 signatures are explicitly classified as ambiguous**, i.e. preservation is the safe action without deeper execution/reachability proof. They are **not** certified as necessary or dead. No speculative deletion was performed.

## Handoff

- Phase 4: review frontend pages, components and remaining lazy imports (not backend route semantics).
- Phases 5–6: examine old internal functions and helpers left behind by removal of route registrations, especially superseded SP cutover helpers, subject to reference analysis.
- Phase 12: consider static tooling to prevent repeat registrar calls and to distinguish route ownership from deliberate guard/fallback chains.
- Phase 13 / Claude's final validation: run appropriate application route-manifest generation, compile/build/tests and focused behavior checks then; **none were run in this phase**.

## Phase 3 completion

- [x] Identified demonstrably redundant registrar suites and shadowed handlers.
- [x] Removed **56** specific redundant registrations without deleting earlier canonical ownership.
- [x] Deleted three obsolete handler/registrar source files.
- [x] Preserved safety middleware and compatibility/fallthrough paths.
- [x] Reflected removals in the ordered route manifest.
- [x] Recorded disposition updates for all remaining 70 repeated signatures, plus every removed registration; ambiguous cases are marked for deferred validation.
- [x] Explicitly documented uncertain overlaps without inventing safe-to-delete status.
- [x] No CI, tests, builds, typechecking, runtime checks or deployments.

**Limit:** This is a completed *static source cleanup* phase, not a guarantee of zero dead backend routes or of runtime equivalence. Behavior requires the intentionally deferred final validation.

---

## Phase 3 continuation (second session) — full overlap and registrar audit

**Status: COMPLETE.** Every repeated method + path signature in `config/route-manifest.json`
was re-read at the handler level (`next` usage, registration order, guard chain), the lazy
route modules were checked against their production prefixes, and every exported `register*`
function under `server/routes` was traced to a live call site.

### Additional registrations removed (8)

| Signature | Removed copy | Why it could never run |
|---|---|---|
| `POST /api/stock-transfers/:transferId/revisions` | `vouchers/stockTransferRevisionLifecycleRoutes.ts`, `fiscal-transfers/revisions-write.ts` | `vouchers/immutableStockTransferRevisionRoutes.ts` registers first in `voucherRoutes.ts` and its handler has no `next` parameter. |
| `POST /api/stock-transfer-revisions/:id/approve` | `vouchers/stockTransferRevisionLifecycleRoutes.ts` | Same: the immutable approve handler is terminal. |
| `GET /api/stock-transfers/:transferId/revisions`, `GET /api/stock-transfers/by-voucher/:voucherId/revisions` | `fiscal-transfers/revisions-read.ts` (readers only) | Immutable readers register earlier (vouchers before fiscal transfers) and are terminal. The file's `PATCH /api/stock-transfers/:id` notes update is unique and retained. |
| `PATCH /api/voucher-entries/:id` | `voucher-entries/write.ts` | `voucherEntryCurrencyEditRoutes.ts` is registered by `ledgerRoutes.ts` before `registerVoucherEntryRoutes` and is terminal. |
| `POST /api/admin/account-migration/execute` | `admin/import-export/account-migration.ts` | `accountMigrationSafeRoutes.ts` registers first and is terminal. The undo chain is kept (both earlier undo handlers call `next()`). |
| `GET /api/suppliers/:supplierId/purchase-orders` | `vouchers/voucherQueryRoutes.ts` | `supplierPurchaseOrderPaginationRoutes.ts` registers first and answers paged and unpaged requests. |

Before: 2,076 registrations, 70 repeated signatures, 85 extra registrations.
After: **2,068 registrations, 65 repeated signatures, 77 extra registrations.**
The 16 previously "ambiguous" signatures were all resolved: 7 removals above, the rest
reclassified with the concrete `next()` evidence (see the JSON `remaining[]`). **No ambiguous
overlap remains.** `MAX_SHADOWED_REGISTRATIONS` in `tests/route-manifest.test.ts` was
tightened from 143 to 77.

### Unmounted duplicate registries and dead route files removed (14 files)

| File | Evidence |
|---|---|
| `server/routes/stock/index.ts`, `server/routes/payroll/index.ts`, `server/routes/rental/index.ts`, `server/routes/factory/raw-stock/index.ts` | Second copies of the live registries (`stockRoutes.ts`, `factoryWorkerPayrollRoutes.ts`, `rentalRouteFactory.ts`, `factory/factoryRawStockRoutes.ts`). Nothing imports them; the raw-stock copy also lacked the company-context middleware of the live aggregator, so it was a hazard if ever re-imported. |
| `server/routes/stats/index.ts`, `server/routes/vouchers/index.ts` | Compatibility re-exports with no importer (the comments in them already warned against second registration paths). |
| `server/routes/admin/index.ts`, `server/routes/containers/index.ts`, `server/routes/factory/customer-orders/index.ts` | Re-export barrels with no importer. |
| `server/routes/erp-payroll/_helpers.ts`, `server/routes/stock-summary-location/_helpers.ts`, `server/routes/vouchers/sales-update/_helpers.ts`, `server/routes/vouchers/transfer/_helpers.ts` | Comment-only / empty modules with no importer. |
| `server/lib/routeRegistration.ts` | `registerRouteModules` helper with no importer. |

Source-text tests and verify scripts that pinned the deleted copies were retargeted to the live
registry (`tests/program-6c-stock-light-route.test.ts`, the three `factory-post-offload-*`
tests, `scripts/verify-program2-phase8-rentals.mjs`) or now assert the dead barrel stays gone
(`tests/sales-report-compact-routes.test.ts`, `scripts/verify-bandwidth-phase-3-sales-report.mjs`).
`tests/stock-transfer-revision-write-route-behavior.test.ts` exercised only the unreachable
`revisions-write.ts` handler in isolation and was removed with it. The stale
`config/company-scope-review.json` entry for `revisions-write.ts` was removed (the audit fails on
stale entries).

### Lazy route modules

All ten `registerLazyRouteModule` targets (chatbot, net-profit Excel, net-position Excel,
export, git, container tracking, supplier profit check, AI import/validation/agent) register
only paths under their declared prefixes, so no route is reachable in development but
silently unreachable in production.

### Findings retained for an owner decision (not dead-code removals)

1. **`server/routes/accounts/ledger-balance.ts` is unmounted, but two tests certify it.**
   `registerAccountLedgerBalanceRoutes` is not called by the application (the earlier
   `accountCurrencyRoutes.ts` handler owns `GET /api/accounts/ledger/:id/balance`).
   `tests/ledger-balance-exact.test.ts` and `tests/wave10-engine-consolidation.test.ts`
   exercise the unmounted copy, whose logic (balance engine, wave 17 A) differs from the live
   handler. Decide which implementation is canonical before deleting either.
2. **`server/routes/factory/customer-orders/linkProformaAtomic.ts` is never wired.** It holds a
   transactional, capacity-locked proforma link. The live
   `PATCH /api/factory/customer-orders/:id/link-proforma` in `orderCrudRoutes.ts` runs without a
   transaction or the capacity lock, while `tests/proforma-capacity-concurrency-wiring.test.ts`
   only checks that the unused file contains the lock call. Wiring it changes behavior, so it
   was left untouched.
3. **`server/routes/stats/statsNetProfitResilience.ts` is never mounted** (tested only in
   isolation). Either mount it intentionally or retire it with its test.
4. **`server/routes/sp/spGoldenCoastPhase5PosSaleRoutes.ts`** is unmounted by design; its tests
   explicitly require it to stay in source "for Phase 6 reuse". Retained per that policy.
5. **`server/services/stockTransferRevisionLifecycle.ts`** lost its only production caller with
   the removal of the shadowed revision routes; it is still imported by three tests. Assessed
   in Phase 6.

**No CI, tests, typecheck, builds or deployments were run.**
