# Properties Unification — Phase 6 Parity Audit and Claude Merge Handoff

**Date:** 2026-11-09
**Repository:** Hassan-Merhi/ERP-FACTORY-SYSTEM
**Branch:** `properties-unification-2026-11-09`
**Status:** Phase 6 source review, safe cleanup and regression-test authoring complete. Tests were **not executed**. Runtime, accounting and merge certification remain pending.
**Owner instruction:** One branch for all six phases; no CI checks by this implementation; no merge or changes to `main`. Claude will handle main integration.

## Legacy dashboard disposition

`client/src/pages/properties/PropertiesDashboard.tsx` is **compatibility-only**, not dead code:
- It remains mounted at `/properties/dashboard` through `client/src/app/PropertiesRoutes.tsx`.
- It still supports real dashboard cash/payable account management and reordering through POST, DELETE and PATCH API actions.
- It is absent from the six pinned sidebar pages. Phase 6 removes its stale Command Palette discovery entry; direct bookmarked links remain functional.
- **Do not delete** the page, related `propertiesdashboard/` components, endpoints or its route without a separate feature-migration and usage review.
- The executable navigation registry marks the page `navigation: "hidden"`.

## Proven unreachable display cleanup

- Removed a duplicate local `reconciliationView` state declaration that collided with the Phase 4 hook's `setReconciliationView`; the hook is the sole state owner.
- Removed the historical reconciliation category count from the Properties payment-category buttons because it was filtered out by that same branch.
- Removed the `isHassanProperties && effectiveView === "OTHER"` callout: the typed Properties rental policy forces the effective view to `ALL`, so the callout cannot render. The original `$800` record **was not deleted or modified**; payment adjustments still remain represented by the read model and receipt math.
- Do not remove compatibility redirects, accounting services, voucher-backed entries, inactive leases, read-only reference units or uncertain legacy screens without real usage evidence.

## Source-level parity matrix

| Contract | Source evidence | Status |
| --- | --- | --- |
| Three rental tabs | `PropertiesRentalsHub` uses typed Warehouses / Shops / Payments values, each with a corresponding panel | Reviewed, runtime pending |
| Shops deep link | `/properties/rentals?tab=shops` plus replacement redirect from `/properties/rental/shops` | Reviewed, runtime pending |
| ERP/Factory/Properties endpoints | `RENTAL_MODULE_POLICIES` maps each explicit rental module to unchanged API root | Reviewed, runtime pending |
| Account ownership | No backend accounting/posting files changed in branch comparison | Reviewed, finance parity pending |
| Historical cut-off | `HISTORICAL_RENT_CUTOFF = 2026-10-26` and POSTED + voucher-backed ACTIVE/ENDED criteria | Reviewed, live reconciliation pending |
| Historical company identity | Verified primary database: `HASSAN PROPERTIES`, `id=13`, `code=HP`, `company_type=properties`; frontend matches all three | Reviewed, browser verification pending |
| Cash vs non-cash | `paymentsReceiptMath.ts` uses posted voucher + cash account for cash; noncash and scheduled remain separate | Reviewed, live parity pending |
| Guarantee/cash overlap | `useRentalReconciliation` preserves read-only cash-account, tenant deposits, ALI cash and optional cashbox ledger queries | Reviewed, live parity pending |
| Unit summaries | `useRentalOverview` excludes internal Factory/ERP projections and preserves active-lease totals | Reviewed, live parity pending |
| Permissions | `propertiesNavigation.ts` gates frontend views by selected-company role; server remains authoritative | Reviewed, authorization testing pending |
| Compatibility dashboard | Still directly routed; intentionally no longer discoverable as a primary command | Reviewed, actual link usage pending |
| Company/session navigation | Legacy redirects + unknown route fallback remain; company role switching untested | Reviewed, runtime pending |

## Authored regression coverage (not executed)

`tests/properties-unification-regression.test.ts` contains focused Vitest assertions for:
- Stable company identity eligibility, including mismatched ID, code and module.
- Historical posted/voucher-backed pre-cutoff rent, ended leases and exclusion of later/guarantee/scheduled rows.
- Three rental tabs, Shops/Payments legacy deep links, six pinned pages and compatibility dashboard classification.
- Admin/Developer/ERP Tester capability boundaries, including selected-company role overriding global role.
- Exclusion of internal module projections from Properties' rental aggregates.

Existing `tests/properties-payment-history-reconciliation.test.ts` remains untouched and is a required additional test for account-balance math, voucher-backed receipts, transfers, guarantees, and reconciled history exports.

## Independent pre-merge certification checklist (Claude)

- [ ] Bring feature branch up to date with `main` and review every conflict; when last checked, comparison showed **46 ahead / 1 behind**, without running a merge or rebase.
- [ ] Independently compile/typecheck and inspect the full branch diff for unresolved imports, stale state, hook order, React Query typing and currency presentation.
- [ ] Execute focused `properties-unification-regression.test.ts`, existing payment-history reconciliation tests, and relevant navigation/role tests.
- [ ] In a non-production Properties company, verify warehouse and shop tabs, search, current-month/year/30-day date filters, navigation Back/Forward and direct links.
- [ ] Verify Factory and ERP rental screens still query their own endpoints, show tenant-expense accounting and never post to Properties cashbooks.
- [ ] Verify Properties receipts, vouchers, cashbox/ALI balances, guarantee deposit liability and scheduled/noncash records against independently computed ledger amounts. Ensure no automatic Properties-to-Factory/ERP transfer.
- [ ] Validate October 26, 2026 historical snapshot and all-records totals for verified HP company ID 13 without adding or changing production entries.
- [ ] Exercise Developer/Admin/user/ERP Tester and selected-company changes; check backend 403/scope enforcement independently of client visibility.
- [ ] Open `/properties/dashboard` directly; confirm compatibility operations still work, even though it is absent from primary navigation and command search.
- [ ] Review the historical company ID/code assumptions if deployment uses an independent database with different company IDs.
- [ ] Only after independent certification decide whether to merge and whether to run deployment workflows. No automatic merging by this phase.

## Boundaries and limitations

No CI, test runner, TypeScript build, browser automation, deployment, backend write, database migration, accounting backfill, repair or Git merge/rebase was performed by this phase. The regression tests are source artifacts, **not passing test results**. Static review does not establish financial or runtime equivalence. Backend authorizations were neither weakened nor independently penetration-tested by this phase.
