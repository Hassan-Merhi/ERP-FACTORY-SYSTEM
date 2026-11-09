# Properties Mode — Follow-up Unification Execution Tracker (Phases 12–15)

**Date:** 2026-11-09  
**Working branch:** `properties-unification-phase12` (from `main`)  
**Merge target:** `main` (not merged by Phase 12)  
**Safety:** No production mutations, accounting changes, schema changes, currency conversions, or CI triggered.

| Phase | Scope | Status |
| --- | --- | --- |
| 12 | Date boundaries and rental filter consistency | **Source implementation and focused tests committed; runtime execution pending** |
| 13 | Parent-route and navigation registry convergence | **Source implementation and regression additions committed; runtime execution pending** |
| 14 | Company-role and historical currency/financial parity | Not started |
| 15 | Integrated TypeScript, regression, browser/API and finance certification | Not started |

## Phase 12 — changes

1. `client/src/properties/config/rentalReportingPresentation.ts`: added `rentalPeriodBounds` and `isRentalDayInRange`, preserving the recorded YYYY-MM-DD calendar date and company business date. Current-month, current-year and rolling 30-day periods are now **inclusive from period start through business today**; future-dated records are excluded. Existing `rentalPeriodStart` and `isRentalDayInPeriod` remain for compatibility with existing callers/tests.
2. `client/src/properties/hooks/useRentalPaymentsFilters.ts`: uses both date bounds, fails closed on an invalid dated business-calendar boundary, and receives company ID explicitly. Company transitions reset search, period, tenant and unit selections. Invalid tenant/unit values fall back to All immediately and are cleared so they cannot reactivate when removed options return.
3. `client/src/pages/properties/RentalPaymentsLog.tsx`: passes selected company ID to the filter hook. No change to ERP/Factory payment listing period behavior, backend payment posting, cash reconciliation, or receipt totals.
4. `tests/ui/properties-unification-phase12-filters.test.tsx`: added tests for inclusive boundaries, future dates, invalid calendar dates, leap year, year crossing, company switching and stale selection cleanup.

## Phase 12 acceptance

- [x] Current month, year, and 30-day period ranges have an inclusive end at company business today.
- [x] Recorded payment calendar days are compared without browser-local timezone shifts.
- [x] No future-dated record may pass a dated Properties filter.
- [x] A selected-company transition resets search, period, unit, and tenant filters.
- [x] Removed unit/tenant options cannot silently re-activate an old filter.
- [x] Existing module API roots, voucher history, ledger, and receipt math are untouched.
- [x] Focused hook and date-boundary regression test cases committed.
- [ ] Execute Vitest and TypeScript checks in runnable checkout.
- [ ] Browser QA with actual company switch, refetch and date filter selections.

## Execution and certification

The source changes were made through GitHub and read back for static inspection. No checkout, package installation, TypeScript compiler, Vitest runner, browser session, CI or production database testing was available in this connected execution. Do not report authored tests as passed tests.

Suggested focused commands in a runnable checkout:

```bash
npm run check
npx vitest run --config vitest.config.frontend.ts tests/ui/properties-unification-phase12-filters.test.tsx
npx vitest run tests/properties-unification-phase8-presentation.test.ts
```

**Phase 12 disposition:** Implementation complete at source level; runtime and integration verification must be completed before production release.

## Phase 13 — changes and verification

1. `client/src/properties/config/propertiesNavigation.ts`: canonical registry now owns the deterministic Properties parent-route contract, including matched dynamic account-ledger details and compatibility aliases. Corrected Account Groups parent to Accounts, Create Property parent to the Warehouses tab, and ledger vouchers parent to the precise monthly ledger.
2. `client/src/lib/parent-routes.ts`: all Properties parent lookups delegate to `getPropertiesParentRoute`. ERP and Factory parent logic is unchanged.
3. `tests/properties-parent-routes.test.ts`: expanded test matrix for registry metadata parity, root pages, deep links, legacy aliases, query/hash, trailing slashes, malformed and unknown URLs.
4. `docs/properties-navigation-registry.md`: documented single-source Back/Escape logic and intentionally preserved compatibility behavior.

### Phase 13 acceptance

- [x] One canonical Properties parent resolver is used by the shared Back/Escape helper.
- [x] Registry metadata matches the deterministic parent destinations for concrete routes.
- [x] Account Groups, Create Property and ledger voucher parents match the existing intended navigation.
- [x] Existing `/properties/rental/*` bookmarks preserve tab destinations.
- [x] Unknown and malformed paths receive no invented parent; root pages remain roots.
- [x] Factory and ERP parent routing is unchanged.
- [x] Tests and documentation are committed.
- [ ] Execute Vitest and TypeScript in a runnable checkout.
- [ ] Browser-test Escape, Back/Forward, dynamic ledger URLs, and compatibility redirects.

Verification: GitHub source read-back and static invariants only. No CI, browser QA, Vitest, TypeScript run, production data modification or merge performed.

Run in a runnable checkout:

```bash
npm run check
npx vitest run tests/properties-parent-routes.test.ts
npx vitest run --config vitest.config.frontend.ts tests/ui/parent-routes-behavior.test.ts
```

**Phase 13 disposition:** Source implementation complete; automated and runtime certification pending.
