# Phase 6 — Dead backend services and helpers

**Status: COMPLETE.** Branch `refactor/erp-dead-code-cleanup`. No CI, tests, builds or
deployments were run.

## Method

The Phase 4 module graph was rebuilt after Phases 3–5 and evaluated for `server/` and
`shared/`. Roots include `server/index.ts`, `server/startupPreload.mjs`,
`server/runtimeMemoryGuard.mjs`, every lazy route module (`registerLazyRouteModule` targets are
literal `import()` calls), the scheduler/WebSocket/startup modules they import, scripts and
configs. Background jobs, schedulers, WebSocket handlers and startup schema registration are
all reached from `server/index.ts` through static imports, so they are covered by the graph.
Phase 3 already traced every `register*` function to a live call site, and Phase 5 removed
unreferenced service/storage functions and the modules they emptied (AIS live tracking, the
container-tracking `track-due`/`track-now` services, SP cut-over user moves, two helpers).

## Removed in this phase

| File | Evidence |
|---|---|
| `server/storage/index.ts` | Shadowed barrel: every `from "../storage"` resolves to `server/storage.ts` (a file wins over a directory index), which assembles the live `storage` object. Nothing imported the directory index. `docs/architecture.md` now points at `server/storage.ts`. |
| `server/lib/serverLog.ts` | No importer; superseded by the structured `server/lib/logger.ts`. Removed from the `docs/architecture.md` file table. |
| `server/services/factory/historical-replay/apply.ts`, `exactApplyV5.ts` | No importer. The live replay apply path is served by the V4 route chain; client mentions of `historical-replay/apply` are API URLs, not this file. |
| `server/services/stockTransferRevisionLifecycle.ts` (+ `tests/stock-transfer-revision-lifecycle.test.ts`, `tests/stock-transfer-revision-lifecycle-math.test.ts`, one case in `tests/wave15-stock-paths.test.ts`) | Its only production caller was `vouchers/stockTransferRevisionLifecycleRoutes.ts`, which Phase 3 proved unreachable (the terminal immutable revision routes register first). `immutableStockTransferRevisionLifecycle.ts` is the live implementation and keeps its tests, including the wave 15 "immutable lifecycle" value-conservation case. |
| `server/lib/trackingPriority.ts` (+ `tests/tracking-priority.test.ts`) | No production importer; automated container tracking is permanently disabled (`66c6aa5f3`). |

Lines removed in this phase: 1,880 (12 files).

## Retained — reachable only from tests (owner decision)

Extra protection was applied to accounting, stock valuation, costing and audit code. These
modules have no production caller but carry behavior tests; deleting them would also delete
the tests, so they are listed rather than removed:

| Module | Note |
|---|---|
| `server/services/accounting/financialCloseService.ts` | Period-close service with two test suites; not wired to a route. |
| `server/services/accounting/historicalReconciliationCorruptionAudit.ts` | Audit routine; test-only. |
| `server/services/audit/auditCoverageSource.ts` | Used by audit-coverage tests only. |
| `server/services/factory/mixBatchCostingIntegrityService.ts`, `rawStockCostingIntegrityService.ts`, `mixSourceInventoryOwnership.ts` | Costing integrity checks; test-only. |
| `server/services/inventory/stockMovementReversal.ts` | Exact stock reversal; test-only. |
| `server/services/sp-sales-form-v2/buildSummarySheet.ts`, `buildSummaryItemwiseSheet.ts`, `buildAgeingSheet.ts` | The live `spSalesFormExportV2.ts` no longer adds these sheets; restored by the 2026-09-01 tree restore. |
| `server/services/syncSalesItemCosts.ts` | Pinned by `tests/container-offload-historical-cost-immutability.test.ts` and `config/write-evidence-baseline.json`. |
| `server/services/factory/historical-replay/exactApply.ts`, `historical-replay/types.ts` | Pinned by ~30 historical-replay safety assertions (see Phase 5). |
| `server/helpers/generateAllCompaniesNetPositionExcel.ts`, `server/lib/workerBalesPdfGenerator.ts`, `server/lib/trackTraceScraper.ts` | Report/PDF/scraper code with dedicated tests and no caller. |
| `server/routes/accounts/ledger-balance.ts`, `customer-orders/linkProformaAtomic.ts`, `stats/statsNetProfitResilience.ts`, `sp/spGoldenCoastPhase5PosSaleRoutes.ts`, `sp/spMigrationFinalVerification.ts` | See the Phase 3 findings (unmounted but test-certified, or retained by explicit policy). |

No financially distinct implementations were consolidated.
