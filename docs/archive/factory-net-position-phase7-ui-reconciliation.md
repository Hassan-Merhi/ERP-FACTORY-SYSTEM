# Factory Net Position — Phase 7: Entire UI and dated subtotal reconciliation

Branch: `feature/factory-net-position-historical`  
Status: SOURCE IMPLEMENTATION COMMITTED, NOT TEST-EXECUTED. User expressly deferred CI/test execution to Claude. No main merge, rebase, deployment or accounting-data mutations.

## Purpose

All Factory Net Position cards, category subtotals, expanded account rows, custom hidden-account totals, broker breakdowns, order groups and payroll detail must describe ONE company and ONE dated financial snapshot. The server owns the date and company cutoffs implemented in Phases 2–6. The cost/selling mode only changes Stock in Hand valuation; Balance on Table remains at cost. An as-of October 19 snapshot must never mix in October 20/21 transactions in side panels or when a user changes valuation mode.

## Implemented

### Server — one source of truth
- **New** `server/services/factory/netPositionReportTotals.ts`: `reconcileHistoricalPosition()` runs after the dated inventory correction and dated customer, supplier, employee, rental, advance, OTW and order stages from Phases 3–6. It computes the assets header, liabilities header, Net Position, both expanded-section totals and both category breakdowns from exactly the actual account row arrays that the API sends. It never takes category totals from a separate current-state query.
- Money arithmetic is Decimal, rounded by displayed-row cents, and preserves negative prepaid/contra-asset entries. Invalid non-finite source amounts fail with `HISTORICAL_NET_POSITION_NONFINITE_AMOUNT`; the route returns the existing historical 503 error rather than a misleading 200.
- Liability/payroll/supplier breakdowns now derive from the actual liability account rows, avoiding a historical header/breakdown mismatch when operational and ledger sources differ by a cent or when account categories are not named exactly as a separate grouping map assumed.
- The live/current calculation and API row math is deliberately not modified by the canonical historical reconciliation, maintaining compatibility with today's existing approved figures.
- **Fixed history-only omitted WIP row:** current-day Balance on Table may be zero and therefore omitted from `forUs.accounts`. An earlier date can have positive WIP; `netPositionHistoricalCorrection.ts` now inserts the missing dated Production row instead of updating only existing rows.
- The response explicitly includes `companyId`, and still includes `asOf`, `businessToday`, `historyBasis`, `historyCompleteness`, `historyWarnings`, `timeZone`, `valuationMode`, all original account rows, grouped subtotals, and pending/verified/loading detail lists. Historical completeness remains **partial** pending Phase 8 data backfill/reconciliation.

### Frontend — summary, expanded panels, and custom totals
- **`FactoryNetPositionDetails.tsx`:** What We Have and What We Owe expandable group totals now sum signed rows, not `Math.abs` values. Detail amounts and Insurance subgroups display the signed row value, so a credit-balance prepaid/contra-asset correctly reduces the group instead of inflating it. Group sorting uses signed sums.
- **Detailed Custom View:** sums visible signed asset and liability rows rather than absolute values; it now uses collision-safe keys for duplicate account names. Saved hidden choices for unique names are preserved. View-only exclusions do not alter the real Net Position.
- **Payroll consistency:** the separate `/api/factory/net-position/payroll-breakdown?asOf=...` request is keyed to the company ID returned by the main report and the exact selected date. The parent payroll aggregate stays visible (and included in the custom subtotal) until the returned detailed employee amounts reconcile **to the cent** with `EMPLOYEE_PAYROLL_PAYABLE` on the main response, and the returned `asOf` matches. If detail errors or disagrees, show the aggregate and a warning rather than dropping a liability. A saved hidden Payroll Payable aggregate preference is respected after detail loads.
- **`FactoryNetPosition.tsx`:** continues to render top totals, both `Side` cards and their expanded category/account rows from the same dated report, using the server-computed per-category breakdowns. Its Custom View totals directly sum row amounts, preserving negative adjustments.
- **Overview duplicate names:** distinct custom visibility keys for same-named account rows; expanded category rows use stable enough unique ledger ID/code/index keys rather than colliding on account name.
- **Company isolation:** the main report query on both Factory pages uses `companyQueryKey(..., selectedCompany?.id, asOf, valuationMode)`; the detailed payroll side-query uses `companyQueryKey(..., response.companyId, asOf)`. A cached result for company A can no longer be silently reused as company B's after switching factories. The response's own company ID is authoritative for the payroll side-panel.
- **Cache:** previous-day snapshots are not cached infinitely. Switching the historical date or Cost/Selling valuation switches the request key. Partial-history warnings and detailed legacy-data limitations from previous phases remain visible without rewriting any vouchers or inventing values.
- **Manual refresh and timezone safety:** both Factory Net Position pages expose Refresh for historical dates as well as Today. The overview disables date navigation until the server has supplied the business-day cutoff, avoiding the browser's current day being mistaken for the company's day near midnight.
- **Company-scoped custom-view preferences:** overview and details persist hidden account choices separately for each factory company ID, remounting the custom section on a company change. Preferences persist across selected dates *within* the same factory but are never silently carried to another company's accounts.

## Historical invariants

1. `SUM(forUs.accounts[].value) === forUs.total === forUsTotal` in displayed cents (signed).
2. `SUM(onUs.accounts[].value) === onUs.total === onUsTotal`.
3. `netPosition = forUsTotal - onUsTotal` in displayed cents.
4. Each category breakdown is the sum of its member rows and category breakdowns reconcile to their side header totals.
5. The detailed user's Custom Net Position, when no rows are hidden, equals the header. When payroll subrows are enabled, their sum must equal the aggregate; otherwise the aggregate is retained.
6. Negative prepaid contra-assets reduce What We Have rather than being turned into a positive asset by `Math.abs`.
7. Stock in Hand uses the selected Cost/Selling setting and historical inventory; Balance on Table is always cost, and a historical WIP account row exists even if today's WIP is zero.
8. Historical Verified and Loading order asset rows and nested order totals derive from the same dated scan/verification projection; Pending orders remain informational.
9. Customer, supplier, rent, employee and OTW rows are not refetched by an unrelated current-day UI query merely because the group is expanded.
10. Every report request uses a selected date and company-scoped cache key; the payroll query is keyed by **the company returned by the main API**.

## Deferred verification (do not execute during Phase 7)

Authored `tests/factory-net-position-phase7-reconciliation.test.ts` with: mismatching seeded headers vs correct rows, per-side reaggregation, negative prepaid credit, supplier/payroll grouping, decimal cents, non-finite refusal, and dated stock value changes. Claude should run that test and the prior phases' accepted tests, audit frontend rendering and regression-check existing current-day Net Position before any merge or deployment.

## Phase 8 handoff

This phase guarantees **consistent presentation of the rows returned**, not absolute historical provenance of every older source record. Earlier Phases 3–6 explicitly mark data gaps (unversioned account openings, deleted/edited historical vouchers, supplier container price/status edits, missing bale scan timestamps, old rental voids and old raw-stock cumulative rows). Phase 8 must inspect the real database, reconcile October 19/20/21 transactions to source histories, design evidence-backed backfills and indexes, and state which dates/categories can be certified. Do not change `historyCompleteness` to `complete` solely because the front end and totals now add up.

No CI checks, tests, GitHub Actions, CircleCI, merge, rebase, Render deploy or production database writes occurred.
