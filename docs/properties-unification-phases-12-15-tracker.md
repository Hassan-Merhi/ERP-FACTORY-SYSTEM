# Properties Mode — Follow-up Unification Execution Tracker (Phases 12–15)

**Date:** 2026-11-09  
**Working branch:** `properties-unification-phase12` (from `main`)  
**Merge target:** `main` (not merged by Phase 12)  
**Safety:** No production mutations, accounting changes, schema changes, currency conversions, or CI triggered.

| Phase | Scope | Status |
| --- | --- | --- |
| 12 | Date boundaries and rental filter consistency | **Source implementation and focused tests committed; runtime execution pending** |
| 13 | Parent-route and navigation registry convergence | Not started |
| 14 | Company-role and historical currency/financial parity | Not started |
| 15 | Integrated TypeScript, regression, browser/API and finance certification | Not started |

## Phase 12 — changes

1. `client/src/properties/config/rentalReportingPresentation.ts`: added `rentalPeriodBounds` and `isRentalDayInRange`, preserving the recorded YYYY-MM-DD calendar date and company business date. Current-month, current-year and rolling 30-day periods are now **inclusive from period start through business today**; future-dated records are excluded. Existing `rentalPeriodStart` and `isRentalDayInPeriod` remain for compatibility with existing callers/tests.
2. `client/src/properties/hooks/useRentalPaymentsFilters.ts`: uses both date bounds, fails closed on an invalid dated business-calendar boundary, and receives company ID explicitly. Company transitions reset search, period, tenant and unit selections. Invalid tenant/unit values fall back to All immediately and are cleared so they cannot reactivate when removed options return.
3. `client/src/pages/properties/RentalPaymentsLog.tsx`: passes selected company ID to the filter hook. No change to ERP/Factory payment listing period behavior, backend payment posting, cash reconciliation, or receipt totals.
4. `tests/properties-unification-phase12-filters.test.tsx`: added tests for inclusive boundaries, future dates, invalid calendar dates, leap year, year crossing, company switching and stale selection cleanup.

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
npx vitest run tests/properties-unification-phase12-filters.test.tsx tests/properties-unification-phase8-presentation.test.ts
```

**Phase 12 disposition:** Implementation complete at source level; runtime and integration verification must be completed before production release.
