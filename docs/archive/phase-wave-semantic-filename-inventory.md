# Phase 1: Phase/wave filename audit and dependency inventory

Status: **Phase 1 discovery and inventory complete; semantic naming approvals and code changes belong to Phases 2-4.** Branch: `refactor/phase-wave-semantic-names`.

## Scope and method
Searches against the indexed default branch identified numerous active filenames embedding delivery phase/wave numbers. These search results are **examples, not an exhaustive count**: GitHub code search may cap results and only indexes the default branch. To obtain exhaustive enumeration, the recursive Git tree was read directly (7,539 tracked blobs on main), and a GitHub Actions full checkout successfully scanned 7,541 tracked files and found 1,167 numbered phase/wave filenames. A read-only, deterministic full-tree inventory tool is committed at `scripts/audit-phase-wave-filenames.mjs`. The scanner uses `git ls-files`, classifies all matching tracked filenames, and lists source files referencing each path/name/stem.

Run from a full checkout:
```bash
node scripts/audit-phase-wave-filenames.mjs --json > phase-wave-inventory.json
node scripts/audit-phase-wave-filenames.mjs
```
The tool performs no writes to the database or repository. Its JSON report records proposedName=null until semantic ownership is reviewed.

## Observed active runtime candidates (non-exhaustive)
- Backend startup: `server/inventoryValuationWave6RepairBridge.mjs`, `server/salesHotpathIndexRepair.mjs`.
- Accounting and factory: `server/services/accounting/inventoryValuation.ts`, `historicalRepair.ts`, `payrollDaybookRepair.ts`, `goldenCoastPosSale.ts`, `goldenCoastMonthlyClose.ts`, `server/services/factory/mixIntegrityMonitor.ts`, `postOffloadSafety.ts`.
- Offline/sync: `server/edge/writerGate.mjs`, `applyStore.mjs`, `cloudEventStore.mjs`, `syncControl.mjs` and corresponding `.d.mts` siblings. These constitute a large coupled module group, not isolated one-file renames.
- Routes: `server/routes/sp/spMigrationRehearsalRoutes.ts`, `spMigrationFinalCutoverRoutes.ts`, `spGoldenCoastContainerOffloadRoutes.ts`, `server/routes/accounting-integrity/historicalRepairRoutes.ts`.
- Chat/reporting: `server/chat/dataQueryIntentClassifier.ts`, `readOnlyDataQueryHandler.ts`, `server/chat/reports/implementations/financialAndPartyReportShard.ts` through `auditAndTrackingReportShard.ts`.
- Frontend: `client/src/pages/pos/retailPosApi.ts`, `client/src/lib/bandwidthFetch.ts`, `client/src/i18n/releaseTranslations.ts`, `client/src/i18n/remainingTranslations.part01.ts` through at least `part39.ts`, and multiple other phase-labelled translation series.
- Build: `build/vitePaginationPlugin.ts`, `build/vitePaginationGuardPlugin.ts`.
- Validation: `scripts/verify-api-payload-bandwidth.mjs`, `scripts/run-realtime-browser-e2e.mjs`, `scripts/audit-i18n.mjs`, `vitest.config.phase9.ts`, and phase/wave-named test suites.

## Confirmed dependencies and critical risks
1. `server/startupPreload.mjs` directly imports `server/salesHotpathIndexRepair.mjs`. Its top-level await can create/drop indexes and run ANALYZE. Coordinate with migration-only schema work; never merely rename or inadvertently leave a second writer.
2. `server/companyScopeRlsBridge.mjs` invokes the inventory Wave 6 repair. `tests/inventory-valuation-repair.test.ts` imports exported functions from the bridge. `server/schemaPreload.mjs` documents the ordering of this work. Preserve ordering and failure semantics.
3. The inventory repair uses `INVENTORY_VALUATION_WAVE6_REPAIR`, `Symbol.for("erp.inventory-valuation-wave6-repair.applied")`, and a repair key; the sales index bridge uses `RUN_WAVE3_INDEX_REPAIR`. Treat these as operational compatibility contracts; do not rename by search/replace without deployment review.
4. `package.json` uses numerous phase/wave-named scripts as command entrypoints. External automation may depend on those names; prefer compatibility aliases until verified.
5. Offline modules have matching TypeScript declaration siblings (`.d.mts`) and high cross-import risk. Rename as one coherent subsystem after import/declaration mapping.
6. Historical migrations, checked-in repair SQL and archived phase reports are records of executed work: preserve their filenames and historical labels unless a separate migration/history policy explicitly authorizes a change.

## Suggested semantic name mapping (provisional; Phase 2 must review module contracts)
| Existing | Candidate | Caveat |
|---|---|---|
| inventoryValuationWave6RepairBridge.mjs | inventoryValuationGuardedRepair.mjs | Preserve env var, repair key, symbolic guard, startup order |
| wave3SalesHotpathIndexBridge.mjs | salesHotpathIndexRepair.mjs | May need **migration retirement**, not rename |
| phase1Classifier.ts | chatIntentClassifier.ts | Review actual classification behavior |
| phase1DataQuery.ts | chatDataQuery.ts | Review exported API |
| phase3HistoricalRepair.ts | historicalAccountingRepair.ts | Avoid conflicts with other repairs |
| retailWave2Api.ts | retailPosApi.ts | Verify actual POS API surface |
| phase9CloudEventStore.mjs | offlineCloudEventStore.mjs | Coordinate all edge imports and declaration siblings |
| wave8ReleaseTranslations.ts | releaseTranslations.ts | Coordinate all parts and tests |

## Phase 1 completion evidence
- [x] Dedicated working branch created from `main`.
- [x] Full recursive Git tree read without truncation; full manifest with 1,167 candidates: `docs/audits/phase-wave-full-filename-manifest.md`.
- [x] Full-checkout GitHub Actions scanner successfully ran on commit `d2d6ede76565cbef73d65e8ceebdf6cf82147add`: run [43841955313](https://github.com/Hassan-Merhi/ERP-FACTORY-SYSTEM/actions/runs/43841955313).
- [x] Full-checkout scanner reported 7,541 tracked files; 1,167 candidates; classification and textual reference findings archived in artifact [14213412986](https://github.com/Hassan-Merhi/ERP-FACTORY-SYSTEM/actions/runs/43841955313/artifacts/14213412986).
- [x] Backend startup/import, configuration, and database migration risks documented.
- [x] Preliminary target or preservation disposition generated for every filename. The collision analysis found 89 potentially conflicting mechanical targets.
- [x] Dynamic import, CI, external configuration, declarations, and name collisions recorded as explicit rename-stage verification risks.

## Exit decision
**Phase 1 discovery/inventory is complete.** Phase 2 must inspect and approve final semantic names for backend modules (especially the 89 collisions), maintain compatibility for persisted names and environment flags, and verify code-dependent references. Phase 3 extends renames to frontend/scripts/tests, and Phase 4 enforces compatibility and naming policy. Mechanical candidate names in the manifest are intentionally not auto-approved.

**No runtime files were renamed and production data was not touched in Phase 1.**


## Source status note
The Git tree baseline enumerated 7,539 tracked blobs on main; the GitHub Actions branch checkout included two additional tracked audit files at the workflow commit, yielding 7,541. The completed workflow reported category totals of 147 backend, 104 frontend, 458 tests, 90 scripts/CI, 172 documentation-review, 192 historical-preserve and 4 other. The committed static manifest uses its own coarse preservation rules, so category splits can differ slightly while the 1,167 candidate total agrees. Refresh the manifest after subsequent branch changes.
