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
| 3 | Reporting identity and currency | Not started | Not started | — |
| 4 | Payments and rental view models | Not started | Not started | — |
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

## Mandatory boundaries for phases 2–6

- Properties remains a landlord-side rental mode; Factory tenant-expense accounting remains separate.
- Do not modify historical prepaid balances, receipts, guarantees, vouchers, monthly ledgers, currency, opening balances or transfer history.
- Properties rental receipts stay in the selected Properties cash/bank/asset account, without automatic transfer to Factory/ERP.
- No voucher, adjustment, backfill or SQL solely for UI unification.
- All write authorization remains enforced server-side and company-scoped.
- Update this file **after each completed phase** on the same branch with committed changes, verifiable evidence, outstanding checks and commit SHA.
