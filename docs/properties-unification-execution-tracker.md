# Properties Mode — Unification Execution Tracker

**Started:** 2026-11-09
**Repository:** `Hassan-Merhi/ERP-FACTORY-SYSTEM`
**Working branch for all six phases:** `properties-unification-2026-11-09`
**Merge target:** `main` (merge and post-merge fixes to be handled separately by Claude, per owner instructions)
**CI:** Do not run CI checks for this work. No merge to main by this execution.
**Reference audit:** Properties Mode — Unification & Hard-Coding Audit (2026-11-09).

## Phase status

| Phase | Scope | Implementation | Verification | Commit |
| --- | --- | --- | --- | --- |
| 1 | Fix rental navigation mismatch | **Code complete** | Static source review complete; browser/runtime checks pending | `e3ac129f5cd36b0b714dce3238bf70b211e0fb3c` |
| 2 | Typed rental module policy | **Code complete** | Static source parity review passed; runtime/typecheck pending | `60084a305133835447212051b863c9af0745e8ed` through `57771a74a7603ae246908967a0a2f2a1648fc0e6` |
| 3 | Reporting identity and currency | **Code complete; identity verified** | 11/11 static checks passed; runtime parity pending | `108b08f2a3fc9efc0588b25eb74d724fce1ba42b`, `431943cc27d69d754eb68e438e9d9eb81c63807e` |
| 4 | Payments and rental view models | **Code complete** | 12 static source checks passed; runtime/typecheck pending | `125c1c66012b2de2619b35796094a30917e76c37` through `652f333a935bcceb84f5565a082fb6dd6dc2e392` |
| 5 | Permissions and navigation registry | **Code complete** | 13 static consistency checks passed; runtime/role QA pending | `794e2204c31c1fa27cea1ba39d56a5cf89e8ee09` through `ac7bcb0d4056b2dd12182c3ce85761bf3a33874c` |
| 6 | Final parity and legacy cleanup | **Source audit/cleanup complete** | 15/15 static checks passed; regression tests authored but not executed; runtime/accounting parity outstanding | `f1895e5af9ac5b8dd0452bf4b2aae9fcc824d0c4`, `ed25bf961276fe0aaa705288aea3a6bf57f26891`, `cb32bc81a167a11f72e2579178306c8911d2b240`, `63cf74c2c172a04082fcf383699d6b7eac2ebd8b`, `43e9dcd7cd0eb5db12f01780732523f48e39bc99` |

## Phase 1 — Fix navigation mismatch

**Changes committed**
- Restored `Shops` as a visible `TabsTrigger` between Warehouses and Payments in `client/src/pages/properties/PropertiesRentalsHub.tsx`.
- Added stable `data-testid="tab-properties-rentals-shops"`.
- Kept existing Shops content, allowed tab values, and `?tab=shops` deep-link behavior intact.
- Did not modify routing, accounting, backend posting or database state.

**Static verification**
- Inspected the working-branch component: Warehouses, Shops and Payments each have a trigger and corresponding content panel.
- Inspected `client/src/app/PropertiesRoutes.tsx`: the canonical `/properties/rentals` route and legacy `/properties/rental/shops` replacement redirect to `/properties/rentals?tab=shops` are present.
- Inspected `client/src/hooks/use-hub-query-state.ts`: query state accepts the allowed `shops` value, replaces browser URL state on tab selection, and synchronizes on `popstate`.
- Browser navigation, Back behavior and tab persistence **have not been exercised at runtime**. Static review cannot certify runtime success.
- No CI runs, test commands, production changes or merge performed.

**Acceptance checklist**
- [x] Shops trigger available in source.
- [x] Shops tab matched to existing Shops content.
- [x] Canonical deep-link and legacy redirect wired in source.
- [x] Tab-state and Back synchronization verified in source.
- [ ] Browser QA: click Shops / Warehouses / Payments and verify content.
- [ ] Browser QA: direct-load `/properties/rentals?tab=shops` and legacy `/properties/rental/shops`.
- [ ] Browser QA: Back/Forward from navigation routes and retained query string.

**Disposition:** Phase 1 code complete. Runtime QA outstanding; do not misreport it as tested.

## Phase 2 — Typed rental module policy

**Changes committed (2026-11-09)**
- Added `client/src/properties/config/rentalModulePolicy.ts` with typed `RentalModule = "PROPERTIES" | "FACTORY" | "ERP"`, preserved API bases and explicit view-policy flags.
- Made `rentalModule` a required prop in shared rental units and payment-log screens, rather than implicitly assuming Properties or inferring mode from an endpoint string.
- Both `PropertyRentalPage.tsx` and `RentalPaymentsLog.tsx` now select endpoint and Properties-specific read-only presentation through `getRentalModulePolicy(rentalModule)`.
- Updated all nine entry pages: Shops, Warehouses and Payments for Properties, Factory and ERP. No server, accounting or transfer behavior changed.
- Preserved existing Properties All Records payment-log behavior and warehouse reconciliation fetch; preserved Factory and ERP payment view behavior.

**Static verification**
- Re-fetched thirteen affected files from the working branch and checked the policy, required module props and all nine entry-page module values: **zero mismatches found**.
- Explicit endpoint mapping remains `PROPERTIES → /api/properties/rental`, `FACTORY → /api/factory/rental`, `ERP → /api/erp/rental`.
- No endpoint-string mode comparison remains in the two shared pages.
- Browser/runtime verification, TypeScript compilation and tests have **not** been run (no CI, as requested). This is static verification, not a runtime guarantee.

**Acceptance checklist**
- [x] Typed three-mode policy exists.
- [x] All shared rental entry pages pass an explicit module.
- [x] Both shared screens use policy instead of endpoint-string mode detection.
- [x] Existing endpoint paths and module-specific reconciliation/payment view flags preserved by source inspection.
- [x] No accounting, database, or server changes.
- [ ] Runtime smoke test across all three modes.
- [ ] TypeScript compile/typecheck.

**Disposition:** Phase 2 code complete; runtime and compilation validation remain outstanding.

## Phase 3 — Reporting identity and currency

**Changes committed (2026-11-09)**
- Added `client/src/properties/config/historicalRentReportingPolicy.ts`: explicit company-scoped, read-only historical presentation opt-in selected by the company's immutable numeric ID, not its mutable name.
- Both `PropertyRentalPage.tsx` and `RentalPaymentsLog.tsx` use the same company-scoped predicate; the original `2026-10-26` voucher-backed snapshot cutoff and selection math were not changed.
- Centralized rental unit currency symbols and amount rendering through existing `formatMoneyDisplay` and `getCurrencyDisplayMetadata`, fixing the old `FC ` vs `CFA ` discrepancy for the legacy CFA currency label. XAF and XOF remain distinct accounting codes; no conversions performed.
- Switched rental summary cards, historical account-balance explanation and guarantee overlap to an explicitly USD-denominated presenter, retaining the existing legacy USD summary basis and underlying numerical values. Unchanged numeric-only exports do not acquire invented exchange-rate conversions.
- No server posting, accounts, vouchers, SQL, currency storage or financial calculations changed.

**Verified company identity — resolved 2026-11-09**
- Queried the primary Render production database `database` in the connected `My Workspace` using read-only SQL. The authoritative `public.companies` row is: `id=13`, `code=HP`, `name=HASSAN PROPERTIES`, `company_type=properties`, `active=true`, `base_currency=USD`.
- Replaced the temporary Vite environment configuration with explicit company ID `13` and code `HP`. The historical reporting predicate requires ID, code, and company type together. It does not compare mutable company names.
- Removed the obsolete `HISTORICAL_RENT_COMPANY` name constant. The original October 26, 2026 cutoff, voucher-backed selection, and numerical reporting calculations remain unchanged.
- No production writes, environment variable mutations, SQL migrations, vouchers, backfills, or adjustments were performed.

**Static verification**
- Eleven source checks passed after re-fetching the working branch files: verified ID, code, company type, both consumers, absence of name comparisons, preserved cutoff and posted-voucher criteria, existing money presenter, CFA label, USD summary basis, and no Vite configuration dependency.
- The earlier missing-ID gate is now resolved for the verified company. This is static source validation, not proof that historical UI parity or reconciliation amounts are correct in a running app.
- No CI, TypeScript compilation, runtime/browser tests, or merge were performed.

**Acceptance checklist**
- [x] Verify Hassan Properties immutable identity from the primary database with read-only queries.
- [x] Use company ID and code instead of mutable display-name comparison.
- [x] Remove unresolved Vite environment dependency and obsolete name constant.
- [x] Preserve 26 October snapshot criteria and existing financial amounts.
- [x] Complete 11/11 static identity/currency checks.
- [ ] Browser QA of historical reporting, USD/CFA display and account reconciliation.
- [ ] Independent TypeScript compilation, integration testing and finance parity review before merge.

**Disposition:** Phase 3 source implementation complete; verified company identity blocker closed. Runtime and finance parity certification are outstanding for Claude's merge review.

## Phase 4 — Payments and rental view models

**Changes committed (2026-11-09)**
- Added `client/src/properties/hooks/useRentalUnits.ts`: read-only, company-keyed unit and cash-account queries and warehouse-paid totals. Retained endpoint URLs, credentials, query keys and loading/error behavior.
- Added `client/src/properties/hooks/useRentalPayments.ts`: payment and historical reconciliation queries plus the shared payment query-key factory. Preserved `view=warehouse-reconciliation`, historical payment rows, module differences and all server allocation logic.
- Added `client/src/properties/hooks/useRentalOverview.ts`: pure rental overview aggregation and grouping hooks. Retained exclusion of internal Factory/ERP projections, contracted totals, guarantee, advance credit, outstanding and active monthly rent rules.
- Added `client/src/properties/hooks/useRentalPaymentsFilters.ts`: payment search, tenant/unit filters, existing month/year/30-day date range behavior, reconciliation category view selection and a typed reconciliation view list. Retained unvouchered adjustments as records without treating them as cash receipts.
- Added `client/src/properties/hooks/useRentalReconciliation.ts`: moved all five ledger read queries, source-account matching and existing pure receipt / account-balance reconciliation math into a read-model hook.
- Reduced `PaymentsReconciliation.tsx` to a compatibility adapter that publishes the snapshot with primitive-value effect dependencies, preserving existing exported types and both existing page consumers.
- Updated `PropertyRentalPage.tsx` and `RentalPaymentsLog.tsx` to consume the extracted hooks. Existing mutation handlers, ledger posting service and modal/action forms were left untouched.
- Cash/non-cash breakdown, scheduled records, deposits/guarantee/ended rent and voucher-backed export calculations remain in the existing `paymentsReceiptMath.ts`, not duplicated.

**Static verification**
- Re-fetched eight source files after changes and checked 12 source invariants: both pages consume the hooks; page-level duplicate queries removed; payment endpoints and unit query keys unchanged; all five reconciliation ledger queries retained; historical cutoff retained; search, correction and date filters retained; internal projections excluded from totals; no accounting write introduced into new hooks; compatibility types retained; no snapshot-object effect dependency loop. **12/12 passed.**
- Payments filter date calculations retain the previous browser-local semantics intentionally; a company-timezone migration requires separate business-date review, not a silent historical reinterpretation.
- No CI, TypeScript compile, automated tests, running-app interaction, DB inspection or merge performed.

**Acceptance checklist**
- [x] Extract read-only company-scoped units / cash accounts / payment queries.
- [x] Extract reconciliation read-model ledger queries and calculation.
- [x] Extract unit totals, unit grouping, search, category and date filters.
- [x] Preserve receipt math, scheduled items, adjustments, tenant deposits, guarantees and historical display boundaries.
- [x] Preserve existing page mutations, API paths and server accounting authority.
- [x] Record post-change source-level verification.
- [ ] TypeScript build/typecheck and browser QA of three rental modules.
- [ ] Verify live ledger reconciliation, historical totals, copy/export and payment deletion in a safe non-production company.
- [ ] Confirm Phase 3 verified company-ID setting before historical UI parity QA.

**Disposition:** Phase 4 source implementation complete on the same branch. Runtime, build and accounting-parity certification are outstanding for Claude's later main-merge review; this status does not claim production verification.

## Phase 5 — Permissions and navigation registry

**Changes committed (2026-11-09)**
- Added `client/src/properties/config/propertiesNavigation.ts` as the typed canonical frontend manifest: pinned root pages, route labels, parent paths, rental tabs/query links, legacy redirects, and capability requirements (`workspace`, `personal`, `admin`, `developer`).
- Added `propertiesEffectiveRole`, `canUsePropertiesCapability`, and `canNavigateProperties` to enforce consistent frontend visibility. When the selected Properties company supplies an assigned role, it takes precedence; otherwise current session role and legacy role fallback apply. Selecting another company type suppresses Properties capability visibility.
- Replaced local role comparisons in `PropertiesRoutes.tsx`, `PropertiesSidebar.tsx` and `PropertiesRentalsHub.tsx` with shared capability checks. The route switch keeps its existing permission-gated component mounts and unknown-route fallback.
- `PropertiesSidebar.tsx` now derives the six pinned page names/URLs from the executable manifest; its command-search section helper filters entries through the same capability registry; recent navigation is filtered to accessible URLs.
- `CommandPalette.tsx` and `useHelpTrainingTopics.ts` now apply selected-company capability rules for Properties commands and training navigation, not separate ad-hoc Developer comparisons.
- The Rentals hub uses the manifest's typed tab values; all three replacement-history legacy rental redirects use central constants. The Shops tab from Phase 1 remains reachable.
- Updated `docs/properties-navigation-registry.md` to document the executable manifest and frontend-only authorization boundary.
- **No server/API authorization, reconciliation role fallback, SQL, vouchers, or accounting behavior was modified.** Client capabilities control appearance and route mounts only; all server write authorization remains mandatory.

**Static verification**
- Re-fetched seven affected files from the feature branch and checked 13 structural invariants: six pinned pages, typed tabs, legacy redirect preservation, admin/developer/personal route gates, pinned/sidebar policy use, hub capability and tab use, command palette capability filtering, Help & Training integration, documentation, and no backend changes. **13/13 passed.**
- The `server/routes/rentalRouteFactory.ts` legacy `currentRole ?? role` fallback has not been altered; verify effective company/session authorization independently instead of changing it on assumption.
- No CI, TypeScript compilation, automated tests, browser session testing, production writes or merge was performed.

**Acceptance checklist**
- [x] Provide a typed Properties route/tab manifest and shared capability policy.
- [x] Consume capability checks in route switch, sidebar, hub, command palette and training navigation.
- [x] Source six pinned Properties routes and rental tabs from the manifest.
- [x] Keep existing legacy redirect destinations and deterministic route fallback.
- [x] Leave backend authorization authoritative without modifying financial semantics.
- [x] Record Phase 5 commits and source verification.
- [ ] Runtime navigation / Back / Forward / deep-link and command search QA.
- [ ] Runtime selected-company switching, Admin/Developer/ERP Tester visibility and backend authorization review.
- [ ] TypeScript compilation, browser tests and merge integration review (not run).

**Disposition:** Phase 5 frontend source implementation complete. Build, runtime, selected-company session and backend authorization review remain for independent merge certification. Phase 3 company-ID blocker resolved; runtime parity QA remains.

## Phase 6 — Final parity audit, regression coverage and legacy cleanup

**Source work committed (2026-11-09)**
- Found and fixed an actual Phase 4 integration error: `RentalPaymentsLog.tsx` duplicated `reconciliationView` and `setReconciliationView` declarations already supplied by `useRentalPaymentsFilters`. The hook now owns these values alone.
- Classified `PropertiesDashboard.tsx` as **compatibility-only**, not dead: `PropertiesRoutes.tsx` still mounts `/properties/dashboard`, and the dashboard still has cash/payable account creation, deletion and reordering actions. Preserved route, file and server endpoints; removed the obsolete primary `Properties Dashboard` command-search result only.
- Removed the historical category count from the category toolbar because the historical category is filtered out from that toolbar, and removed the unreachable Hassan Properties `effectiveView === "OTHER"` callout since the Properties typed module policy forces `ALL`. Did **not** remove, rewrite, reverse or backfill the original billing adjustment or any record.
- Added `tests/properties-unification-regression.test.ts`, focused on verified HP identity, dated voucher-backed snapshot selection, rental navigation/redirects, selected-company permissions, and exclusion of Factory/ERP reference projections from landlord totals. **Tests written, not run**.
- Added `docs/properties-unification-phase6-handoff.md` with a parity matrix, legacy dashboard disposition, explicit risk boundaries, and Claude's independent pre-merge review checklist.

**Static audit**
- Re-fetched twelve current feature-branch source/test/document files and checked fifteen invariants (duplicate state removed, view hook authoritative, unreachable UI removed, dashboard still routed but hidden from command search, typed tabs and aliases, isolated API roots, verified HP ID/code, historical cutoff/vouchers, existing reconciliation math, new tests and handoff). **15/15 passed**.
- Compared `main` with feature branch: last check **48 commits ahead / 1 commit behind**, **32 changed files**; no `server/`, `migrations/` or `shared/` files in the change list. **No merge or rebase performed.**
- No CI, TypeScript compilation, test execution, running-app inspection, safe-company simulation or financial reconciliation took place. Static review is **not** runtime or accounting certification.

**Acceptance checklist**
- [x] Determine `PropertiesDashboard` disposition; keep compatibility route and account workflows.
- [x] Remove only confirmed unreachable payment UI and stale command navigation.
- [x] Fix duplicate shared view state introduced during Phase 4 integration.
- [x] Add targeted regression test coverage without executing CI.
- [x] Document parity review, risk boundaries and independent merge checklist.
- [x] Confirm branch diff introduces no backend, migration or shared accounting code changes.
- [x] Commit source work and record 15/15 static checks.
- [ ] Execute TypeScript check, focused regression suite and existing receipt/reconciliation suite.
- [ ] Browser smoke tests of Shops/Warehouses/Payments, deep links, role changes and compatibility dashboard.
- [ ] Finance parity review: receipts, vouchers, deposits, cashbox, guarantee overlap, historical totals and Factory/ERP isolation in a safe non-production company.
- [ ] Reconcile latest `main` (one commit ahead at last check), review potential conflicts, obtain independent certification and determine merge readiness.

**Disposition:** **Phase 6 source implementation and cleanup complete; all six phases have committed source changes on this one branch.** The six-phase project is *not* certified or merged. Claude must perform remaining independent runtime/finance/typecheck/integration work before any main merge. This distinction is intentional and preserves the owner's no-CI request for this implementation.

## Mandatory boundaries for phases 2–6

- Properties remains a landlord-side rental mode; Factory tenant-expense accounting remains separate.
- Do not modify historical prepaid balances, receipts, guarantees, vouchers, monthly ledgers, currency, opening balances or transfer history.
- Properties rental receipts stay in the selected Properties cash/bank/asset account, without automatic transfer to Factory/ERP.
- No voucher, adjustment, backfill or SQL solely for UI unification.
- All write authorization remains enforced server-side and company-scoped.
- Update this file **after each completed phase** on the same branch with committed changes, verifiable evidence, outstanding checks and commit SHA.
