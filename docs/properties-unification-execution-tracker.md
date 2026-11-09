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
| 2 | Typed rental module policy | Not started | Not started | — |
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

## Mandatory boundaries for phases 2–6

- Properties remains a landlord-side rental mode; Factory tenant-expense accounting remains separate.
- Do not modify historical prepaid balances, receipts, guarantees, vouchers, monthly ledgers, currency, opening balances or transfer history.
- Properties rental receipts stay in the selected Properties cash/bank/asset account, without automatic transfer to Factory/ERP.
- No voucher, adjustment, backfill or SQL solely for UI unification.
- All write authorization remains enforced server-side and company-scoped.
- Update this file **after each completed phase** on the same branch with committed changes, verifiable evidence, outstanding checks and commit SHA.
