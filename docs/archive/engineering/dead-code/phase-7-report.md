# Phase 7 — Consolidate duplicate code into shared modules

**Status: COMPLETE (high-confidence scope).** Branch `refactor/erp-dead-code-cleanup`.
No CI, tests, builds or deployments were run.

## Method

Every top-level function in `client/src`, `server` and `shared` was printed without comments,
renamed to a placeholder and whitespace-normalised; functions with identical text were grouped
(250 groups, 697 functions, bodies ≥ 80 characters). A group was consolidated only when

- the bodies are byte-identical after normalisation,
- the body references no module-local constant or state (so a shared copy cannot behave
  differently), and
- an existing shared module already owns that concern, or at least five consumers share it.

A second, per-file export analysis (does any file import *this* export from *this* module?)
found copies of duplicated helpers that nothing imported — the Phase 5 name search could not
see them because another copy with the same name is in use. Removing those unused copies is
the safest form of consolidation.

## Consolidated

| Helper | Copies before | Owner after | Consumers changed |
|---|---:|---|---|
| `isRecord(value)` (object, not null, not array) | 7 | existing `shared/typeGuards.ts` | `client/src/hooks/use-paginated-filter-state.ts`, `client/src/lib/erp-navigation-history.ts`, `server/routes/performance/readMicrocacheCoordinator.ts`, `server/routes/stockAdjustmentCreateHandler.ts`, `shared/realtimeChat.ts`, `shared/realtimeInvalidation.ts` |
| `parsePositiveInt(value, fallback)` | 10 TypeScript copies | existing `server/lib/listPagination.ts` (now exported) | eight pagination route modules and `account-transaction-pagination/_helpers.ts` |
| `resolveRequestUrl` / `requestMethod` for `fetch` guards | 5 + 5 | new `client/src/lib/fetchRequestInfo.ts` | `bandwidthPhase1HotspotGuard`, `bandwidthPhase2PayloadGuard`, `operationalPhase4BandwidthFetch`, `phase4BandwidthFetch`, `requestStormGuard` |

The standalone preload scripts `server/runtimeMemoryGuard.mjs` and `server/exportBufferBridge.mjs`
keep their own tiny parser on purpose: they run before the TypeScript server loads and must not
import application modules.

## Unused duplicate copies removed (37 exports)

Examples: the three unused copies of the payroll `findOrCreateLedger`, `computeMonthlyPay`,
`computeMonthlyPayFromAttendance` and `workerUpload` in `payroll/advance-accounting/_helpers.ts`,
`payroll/worker-statement/_helpers.ts` and `payroll/worker-stats-advances/helpers.ts` (the
imported copies in `payroll/core/_helpers.ts`, `factory-payroll/_helpers.ts` and
`factory-workers/_helpers.ts` are untouched); the unused `classifyBalesByFinalization` copy in
`historical-replay/selectedScope.ts` (tests use the `scope.ts` copy); unused `inventoryApi` and
`posApi` client objects; unused form-data types and constants. Cascading unused imports were
removed with the Phase 5 tooling.

## Verification (static)

- Full-program TypeScript diagnostics compared with the pre-phase commit: **0 new
  diagnostics**.
- Source-text assertions re-evaluated for every modified file: **0 removed pinned strings**.
- Files that were Prettier-clean stay Prettier-clean.

## Deliberately not consolidated

| Group | Why |
|---|---|
| `money(value: Decimal)` in six Golden Coast posting services; payroll `computeMonthlyPay` in `factory-payroll` vs `factory-workers` | Financial code. The bodies are identical today, but they belong to separately audited posting/payroll modules; merging them couples their future changes. Recorded for the owners. |
| `parsePagination`, `wantsPagination` (7 copies each) | Bodies reference each module's own `MAX_PAGE_SIZE`/`DEFAULT_PAGE_SIZE`, which differ per endpoint. |
| i18n `translate*Text`, `compileLanguageTemplate`, `renderTemplate` copies | Bodies close over each catalogue's own entries. |
| `getFactoryCompanyId` (8 copies, three variants) | Variants differ in fallback (`currentCompanyId` vs none, `null` vs `undefined`); not identical. |
| Historical-replay `sortNumbers`, `emptySummary`, `canonicalize` copies | Pinned by historical-replay source-text safety tests. |
