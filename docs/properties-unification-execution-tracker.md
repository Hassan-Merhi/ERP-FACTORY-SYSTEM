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
| 3 | Reporting identity and currency | **Code committed; rollout blocked on verified company ID** | Seven static checks passed; runtime/ID verification outstanding | `62befb3e55efd0439b200496475fe3c370c3189e` through `78e61c82e553ea25c30df07492c9d0fc35fc2414` |
| 4 | Payments and rental view models | **Code complete** | 12 static source checks passed; runtime/typecheck pending | `125c1c66012b2de2619b35796094a30917e76c37` through `652f333a935bcceb84f5565a082fb6dd6dc2e392` |
| 5 | Permissions and navigation registry | Not started | Not started | — |
| 6 | Final parity and legacy cleanup | Not started | Not started | — |

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

**Identifier configuration — mandatory rollout blocker**
- The inspected source and audit do **not** establish Hassan Properties' numeric `company.id`; it is not safe to guess one.
- Supply the verified immutable numeric ID as the build-time environment value `VITE_HASSAN_PROPERTIES_REPORTING_COMPANY_ID`. This value must correspond to the actual Hassan Properties company and `companyType === "properties"`.
- Without a valid configured ID, the special Hassan Properties historical reconciliation/reporting view is intentionally **disabled** rather than silently assigned to a potentially incorrect company. **This is a visible behavior change until configured.** Do not merge or deploy this phase without confirming the ID and the resulting historical UI parity.
- Environment variables in this Vite client are public build-time configuration, not secret authorization. Server endpoints remain responsible for access checks; this is a read-only UI gate only.

**Static verification**
- Re-fetched the relevant source files from the branch; checked seven specific conditions: snapshot cutoff unchanged, no mutable-name gate, numeric ID match, shared policy used by both views, shared money display adopted, summary dollar concatenation removed and no server changes. All seven passed.
- TypeScript compilation, UI runtime, currency QA and historical reconciliation tests have **not** run; CI intentionally omitted.

**Acceptance checklist**
- [x] Introduce company ID-based reporting policy and remove mutable-name comparisons.
- [x] Preserve historical cutoff, voucher selection and numeric calculation.
- [x] Use shared currency presentation for rental monetary display without FX conversions.
- [x] Commit source changes on the existing working branch.
- [ ] Confirm Hassan Properties' actual immutable company ID from authoritative company data.
- [ ] Configure `VITE_HASSAN_PROPERTIES_REPORTING_COMPANY_ID` and confirm the expected historical view is visible **only** for that company.
- [ ] Verify currency labels, summary basis and historical totals in a running app.
- [ ] TypeScript compile/typecheck and runtime parity verification (not run per no-CI instruction).

**Disposition:** Source refactor committed. **Not fully completed for rollout** until the true company ID is configured and historical UI parity verified. The tracker does not claim an unverified production identity.

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

## Mandatory boundaries for phases 2–6

- Properties remains a landlord-side rental mode; Factory tenant-expense accounting remains separate.
- Do not modify historical prepaid balances, receipts, guarantees, vouchers, monthly ledgers, currency, opening balances or transfer history.
- Properties rental receipts stay in the selected Properties cash/bank/asset account, without automatic transfer to Factory/ERP.
- No voucher, adjustment, backfill or SQL solely for UI unification.
- All write authorization remains enforced server-side and company-scoped.
- Update this file **after each completed phase** on the same branch with committed changes, verifiable evidence, outstanding checks and commit SHA.
