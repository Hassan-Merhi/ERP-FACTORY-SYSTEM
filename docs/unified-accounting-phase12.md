# Unified Accounting — Phase 12: Cost Centers, Budgeting & Analytical Expense Bridge

**Repository:** `Hassan-Merhi/ERP-FACTORY-SYSTEM`  
**Branch:** `feature/unified-accounting-erp-factory-rentals` (continues all unified-accounting phases on one branch)  
**State:** Phase 12 source integration committed. No CI, test run, TypeScript compilation, migrations, merge/rebase, production deployment, production accounting edit, budget write, or accounting certification performed here. **Claude owns independent verification and financial/security release review.**

## Architectural decision: one Cost Centers system

The existing `Cost Centers` workspace and its Phase 1–8 infrastructure **already implement** the core Phase 12 features:

- company-owned hierarchical cost centers and department rollups;
- analytical splits of eligible ERP voucher expense and distinct Factory Daybook sources;
- automatic account-to-cost-center allocations with manual review;
- historical native/USD amounts, credit/reversal support and unallocated expense diagnostics;
- monthly USD budget entry and immutable audit history;
- recognized expense versus budget, monthly variances and utilization;
- cost-center / department / account reports, historical attribution and exports;
- company/permission boundaries and a separate structural readiness endpoint.

Canonical existing implementations:

- `server/routes/costCenterReportingRoutes.ts`
- `server/routes/costCenterRoutes.ts`
- `client/src/pages/CostCenters.tsx`
- `client/src/components/financial/CostCenterReports.tsx`
- `migrations/20261021_001_cost_centers_phase1.sql` and subsequent versioned Cost Centers migrations
- `docs/cost-centers-phase6.md`, `docs/cost-centers-phase8-release.md`

**Phase 12 does NOT create a second cost-center directory, budget table, allocation service, or accounting write pipeline.** Duplicating those would permit divergent company budgets, allocation totals and source recognition. The existing cost-center feature's own migration and release controls remain in force; a unified-accounting code commit does not run them.

## New Phase 12 integration

A read-only **Cost centers & budgets** tab in `client/src/pages/UnifiedAccountingDashboard.tsx` consumes `UnifiedAccountingBudgetBridge` from `client/src/components/financial/UnifiedAccountingBudgetBridge.tsx`.

It uses the existing **non-consolidated** `GET /api/cost-centers/reports/summary` for ERP or `GET /api/factory/cost-centers/reports/summary` for Factory with:

- company identity from authenticated selected company, not a caller-supplied `companyId` query;
- accounting date range supplied by the loaded unified dashboard response, matching its actual `fromDate` and `asOfDate` rather than the browser's current month;
- `treatment=ALL` to obtain both recognized expense and separately classified inventory-capitalized allocations (the service still computes budgets/variance on expense only);
- a client-side read guard requiring `scope=company`, exactly one returned `companyIds` value matching the dashboard's company, equal dates and USD before displaying any amounts;
- separate allocated recognized expense, unallocated expense, recognized analytical total, whole-month budget and expense-minus-budget variance;
- explicit separate capitalization/inventory cost, per-center expense/budget/variance/utilization and monthly trend with distinct allocated/unallocated columns;
- navigation to the **existing** ERP `/cost-centers` or Factory `/factory/cost-centers` workspace for entry, history, advanced reports and exports;
- independently surfaced unavailable/permission/migration failures with no fabricated fallback amounts.

The dashboard initiates this analytical read **only after** the Cost Centers tab is selected. Data is query-keyed by mode/company/from/to; no expense values are written to the unified financial statements, cash flow, net position, GL or cost-of-goods-sold reader.

### Properties/Rentals boundary

There is currently no dedicated Properties/Rentals Cost Centers workspace in the existing Phase 1–8 cost-center feature. Phase 12's Properties shell therefore shows a clear **unavailable** state, makes **no cost-center API read**, and never displays another ERP/Factory company's budgets as though they belonged to a rental company. Rentals' actual receivables, advances, landlord/tenant accruals and maintenance remain in Phase 8 and the canonical ledger. A future owner-approved Properties analytical tagging feature would need its own company-safe source-mapping, access-control and migration design, not an implied cross-shell route.

## Non-equivalence of budget analytics and financial reporting

This tab is **not** a statutory expense budget-to-P&L reconciliation:

1. The cost-center report reads **eligible tagged expense** and company-wide **eligible unallocated** expense from its original expense sources. It does not claim to cover every possible GL P&L account without a reviewed source/ledger crosswalk.
2. Account/treatment exclusions, reversal handling and distinct Factory Daybook semantics belong to the existing reporting service. New Phase 12 code does not reinterpret their source statuses.
3. Budgets apply to **full calendar months** touching the requested date window, even for partial-month financial statements. Variance is not prorated or certified to match partial-period P&L.
4. Capitalized inventory/landed cost/Factory stock is shown separately. It is not current expense, new profit, additional book equity or a balancing adjustment.
5. A negative variance is under budget; positive is over budget. A utilization percentage is not produced when a center has no budget.
6. No group consolidation occurs in this new tab. The existing Cost Centers module has a separately authorized consolidated report which Phase 12 intentionally does not call.
7. Only server-provided decimal strings are displayed. The bridge does not recompute monetary aggregates in JavaScript floating point.

**No Phase 12 API POST/PUT, budget creation, cost-center allocation mutation, financial voucher, stock movement, migration or historical repair is added.**

## Independent Claude verification — NOT performed by this change

Claude must perform all independent checks and fix findings on the **same feature branch**, including:

1. TypeScript compile, lint/format, frontend UI rendering, route and lazy import binding, React Query cache/company invalidation; ensure existing Phase 11, 13, 14, 15 screens still work.
2. Correct context path and permissions for ERP/Factory/Properties, switch active companies and ensure the query key, API authorization and returned company guard all hold. Try unauthorized users and different Factory Accounts/View privileges.
3. Verify consolidated reports cannot leak through the new Phase 12 panel. Test a response with two company IDs, mismatched dates, incorrect USD currency, missing schema/503, 401/403 and empty centers: the panel must refuse values or show an explicit error.
4. Compare Phase 12 totals against the pre-existing Cost Centers reports for identical authenticated company, date window and `treatment=ALL` (expense and capitalized inventory separate). Test positive/negative expenses and reversals, unallocated items, auto/manual splits, archived centers, zero-budget utilization and parent/child department rollups.
5. Test month-end, leap-year, cross-year and partial-month windows. Whole-calendar-month budgets must never be labeled a prorated daily budget or reconciled as if the cutoff were equal.
6. Confirm cost capitalized to Factory/ERP inventory is not expense, booked equity, asset or historic COGS a second time. Test mixed inventory-plus-expense source documents and pending/unfinalized Factory operations.
7. Check original source currency and booked historical USD; no conversion from today's FX, no JS-based monetary sum, no source mutation from refetch, tab change or navigation.
8. Verify Properties/Rentals displays no borrowed ERP/Factory budget and performs no unauthorized cost-center API request.
9. Review Cost Centers 001–007 migrations and release preflight separately; these already-existing schema artifacts may need separate deployment authorization. No automatic migration was performed.
10. Full tests, CI, independent accounting review, cross-tenant penetration scenarios and approved release/merge/deployment decisions belong to Claude/Owner.

**Handoff:** Existing Phase 12 core budget functionality is reused, and the new single-company analytical read-only dashboard integration is source-committed. **Unverified, unmerged, undeployed and not accounting-certified.**
