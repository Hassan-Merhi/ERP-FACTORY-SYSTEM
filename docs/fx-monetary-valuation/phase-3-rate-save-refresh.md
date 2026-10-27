# Phase 3 — Settings + daily popup FX refresh and stale-cache prevention

**Status:** Implemented on `feature/fx-monetary-valuation` (2026-10-27). This is an implementation handoff, not a production deployment or a passed CI claim.

## Scope

Both user interfaces already POST `/api/exchange-rates`:
- `client/src/components/ExchangeRateSettings.tsx`: allows owner/admin/developer to save an effective-dated rate.
- `client/src/components/DailyRateModal.tsx`: saves the server-issued company-local **today** with `daily: true`, preserving its `rate set today` browser record.

Phase 3 makes every successful saved rate refresh the shared **read-only monetary valuation** response from Phase 2 and the relevant rate-dependent financial screens. It does **not** merge new valuation amounts into current Accounts, Net Position, loan or Factory report totals; that is reserved for Phase 4. No historical transaction or native currency amount changes.

## Changes committed

1. **Backend successful-save boundary:** `server/routes/exchangeRateRoutes.ts` invokes `invalidateCompanyFxRateCaches(companyId)` **only after** `saveCompanyExchangeRate` resolves and the audited transaction commits, then returns the saved rate with `Cache-Control: private, no-store`. Errors do not trigger this invalidation; no FX-REVAL journal posts.
2. **Server financial TTL caches:** `server/services/shared/ttlCache.ts` now exposes a key predicate eviction function; `server/services/accounting/invalidateCompanyFxRateCaches.ts` removes only `net-profit`, `ratios`, `expense-breakdown`, `import-cycle-balance`, and group keys containing the saved company. **Live** `groupNetPositionRoutes.ts` bypasses its old five-minute process-local snapshot cache, since a separate Render process could otherwise hold old USD values; historical group views retain the existing cache.
3. **Client shared query invalidation:** `shared/fxRateQueryInvalidation.ts` identifies FX-dependent query keys using bounded URL path matches (not broad prefixes like all Voucher and Sales history). Exact rate query keys honor explicit company ID. `client/src/lib/invalidateExchangeRateReadModels.ts` clears stale browser API response caches first, then marks mounted FX-dependent React Query reads stale and refetches them. Inactive queries refresh on reopening.
4. **Two forms, one behavior:** `ExchangeRateSettings.tsx` and `DailyRateModal.tsx` use that single helper after the server confirms the POST; they capture the saved company/date so a later switch cannot mark the wrong company/day as updated. The daily modal retains its server-date and localStorage rule.
5. **Other tabs/devices:** `shared/realtimeInvalidation.ts` classifies a successful POST to `/api/exchange-rates` as the tenant-scoped `fx` invalidation topic. `client/src/hooks/use-ws-invalidation.ts` refreshes precisely the FX-dependent currently mounted views, including `/api/stats/net-profit` and `/api/balance-sheet` which usually suppress ordinary realtime refresh. All other stable queries retain their old policy. It clears browser response caches for FX messages.
6. **Cross-worker API read microcache:** `server/routes/performance/readMicrocache.ts` adds the FX topic to read scopes whose paths are FX-dependent (e.g. accounts, customers, bank accounts, factory customers). Its existing transactional invalidation coordinator publishes a company-scoped invalidation across workers. Unrelated inventory / reference caches are not invalidated server-side for this rate change.
7. **Phase 2 preflight fix:** `server/services/accounting/monetaryFxValuationService.ts` no longer shadows the approved monetary-asset policy argument with a local variable in its eligibility loop.

## Behavior contract

- Both rate-entry surfaces call the exact same backend save and client invalidation code.
- Company A's rate change never rewrites Company B's rate or posted data. Group caches containing A are evicted; those with only B remain.
- No customer, cash, asset, loan, or supplier **native** amounts are modified.
- No original voucher, historical USD base, fixed asset cost, raw material price, stock cost, journal or FX gain/loss posting changes.
- New effective rate is applied only to management **read-time USD conversions** when applicable; future-dated rates do not immediately change the current quote.
- Missing original currency evidence remains provisional/null, not a fabricated USD value.
- A Settings or popup success causes same-tab refresh; other connected tabs are notified by the existing company-scoped realtime broadcast; cache invalidation does not guarantee stale sockets disconnected from all workers update without their normal reconnect.
- Native and report-time valuations from Phase 2 remain read-only and are not yet substituted into Accounts/Net Position/Factory totals.

## Regression coverage committed

- `tests/fx-rate-phase3-refresh.test.ts`: bounded matching for FX-dependent queries, different-company rate exclusion, realtime FX topic classification, shared cache predicate eviction.
- `tests/fx-phase3-save-refresh-contract.test.ts`: both UI save paths, post-commit backend cache invalidation, company-scoped read microcache, live group bypass, browser response invalidation, realtime override for FX-dependent heavy reports, Phase 2 parameter shadow regression.
- Existing `tests/exchange-rate-daily-popup.test.ts`, `tests/money-exact-batch-18.test.ts`, `tests/wave9-ledger-safety-routes.test.ts`, `tests/realtime-invalidation-contract.test.ts` should continue to pass.

**Verification performed:** GitHub reads of changed files and source-level inspection. **Not performed:** Vitest run, tsc/build/lint, live SQL reconciliation, end-to-end frontend interaction, deployment. Before a main merge, execute tests and reconcile the Phase 2 service for Mali/Zambia and any other configured currencies. No PR merge or Render deployment was performed during Phase 3.

**Phase 4:** wire the read-only four-category translation to the current Accounts / customer / loan / monetary asset / Net Position / Factory display and report consumers with exact typed row replacement, sign preservation and no duplicated ledger balance; maintain historical book and as-of semantics.
