# Phase 1: Phase/wave filename audit and dependency inventory

Status: **Repository discovery and repeatable audit tooling committed; full checkout-generated inventory pending a successful workflow run.** Branch: `refactor/phase-wave-semantic-names`.

## Scope and method
Searches against the indexed default branch identified numerous active filenames embedding delivery phase/wave numbers. These search results are **examples, not an exhaustive count**: GitHub code search may cap results and only indexes the default branch. A read-only, deterministic full-tree inventory tool is therefore committed at `scripts/audit-phase-wave-filenames.mjs`. The scanner uses `git ls-files`, classifies all matching tracked filenames, and lists source files referencing each path/name/stem.

Run from a full checkout:
```bash
node scripts/audit-phase-wave-filenames.mjs --json > phase-wave-inventory.json
node scripts/audit-phase-wave-filenames.mjs
```
The tool performs no writes to the database or repository. Its JSON report records proposedName=null until semantic ownership is reviewed.

## Observed active runtime candidates (non-exhaustive)
- Backend startup: `server/inventoryValuationWave6RepairBridge.mjs`, `server/wave3SalesHotpathIndexBridge.mjs`.
- Accounting and factory: `server/services/accounting/phase3InventoryValuation.ts`, `phase3HistoricalRepair.ts`, `phase3PayrollDaybookRepair.ts`, `goldenCoastPhase5PosSale.ts`, `goldenCoastPhase11MonthlyClose.ts`, `server/services/factory/mixPhase7IntegrityMonitor.ts`, `postOffloadPhase6Safety.ts`.
- Offline/sync: `server/edge/phase7WriterGate.mjs`, `phase8ApplyStore.mjs`, `phase9CloudEventStore.mjs`, `phase10SyncControl.mjs` and corresponding `.d.mts` siblings. These constitute a large coupled module group, not isolated one-file renames.
- Routes: `server/routes/sp/spMigrationPhase2Routes.ts`, `spMigrationPhase4Routes.ts`, `spGoldenCoastPhase8ContainerOffloadRoutes.ts`, `server/routes/accounting-integrity/phase3HistoricalRepairRoutes.ts`.
- Chat/reporting: `server/chat/phase1Classifier.ts`, `phase1DataQuery.ts`, `server/chat/reports/implementations/phase1ReportShard.ts` through `phase7ReportShard.ts`.
- Frontend: `client/src/pages/pos/retailWave2Api.ts`, `client/src/lib/phase4BandwidthFetch.ts`, `client/src/i18n/wave8ReleaseTranslations.ts`, `client/src/i18n/phase3RemainingTranslations.part01.ts` through at least `part39.ts`, and multiple other phase-labelled translation series.
- Build: `build/vitePhase1PaginationPlugin.ts`, `build/vitePhase1PaginationGuardPlugin.ts`.
- Validation: `scripts/verify-wave3-api-payload-bandwidth.mjs`, `scripts/run-wave6-realtime-browser-e2e.mjs`, `scripts/audit-i18n-phase14.mjs`, `vitest.config.phase9.ts`, and phase/wave-named test suites.

## Confirmed dependencies and critical risks
1. `server/startupPreload.mjs` directly imports `server/wave3SalesHotpathIndexBridge.mjs`. Its top-level await can create/drop indexes and run ANALYZE. Coordinate with migration-only schema work; never merely rename or inadvertently leave a second writer.
2. `server/companyScopeRlsBridge.mjs` invokes the inventory Wave 6 repair. `tests/inventory-valuation-wave6-repair.test.ts` imports exported functions from the bridge. `server/schemaPreload.mjs` documents the ordering of this work. Preserve ordering and failure semantics.
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

## Phase 1 acceptance checklist
- [x] Dedicated working branch created from `main`.
- [x] Representative filenames found in backend, frontend, scripts, tests, workflows and documentation.
- [x] Direct startup/import, environment configuration and migration-risk dependencies reviewed.
- [x] Read-only full-tree audit tool committed.
- [ ] Full-tree scanner JSON generated and archived from CI (requires workflow execution).
- [ ] Every candidate assigned an approved semantic target or preservation exception.
- [ ] Cross-file reference list reviewed for dynamic import, external scripts and collisions.

**No runtime files are renamed and no production data is touched in Phase 1.** Do not label Phase 1 fully certified until the unchecked items have evidence.
