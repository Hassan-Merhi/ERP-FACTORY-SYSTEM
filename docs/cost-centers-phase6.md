# Cost Centers — Phase 6: Reports, Budgets & Analytics

## Delivery boundary

This work is committed to the existing
`feature/cost-centers-phase1-foundation` branch. No CI, tests, migrations,
financial posting, branch merge, or Render deployment have been executed.
As requested, Claude owns validation and production certification.

## ERP and Factory Mode entry point

Open **Cost Centers → Reports, Budgets & Analytics**, beneath the existing
Cost Center directory and above automatic allocation settings. The same
React UI and report controller work under:
- `/api/cost-centers` (ERP)
- `/api/factory/cost-centers` (Factory)

## Implemented functionality

1. **Historical date filters**: inclusive from/to accounting dates, maximum
   five calendar years, using the voucher's `effective_date` if present and
   otherwise `voucher_date`; standalone Factory daybook
   `effective_date` falls back to `tx_date`.
2. **Cost-center totals**: allocated recognized expense, separate
   capitalized inventory cost, historical native-currency source amounts,
   original source vouchers, allocation origin (AUTO/MANUAL), and individual
   cost-center company.
3. **Unallocated expense**: all eligible posted expense ledger debits/credits
   plus truly standalone unreferenced Factory expense events, less existing
   analytical allocations, signed on the original posting side. A manual
   clear-all returns the source expense to the unallocated total. Unallocated
   values cannot be assigned to a specific center and are marked not
   applicable when a single center is selected.
4. **Credit/reversal logic**: expense credits lower recognized expense.
   Fully reversed voucher pairs, optional/unposted vouchers, soft-deleted
   vouchers, migrated read-only postings, and tagged intercompany sources
   are excluded. Voucher-backed Factory Daybook duplicates are excluded by
   using the voucher posting as the sole authoritative source.
5. **Monthly budgets (USD)**: `cost_center_monthly_budgets` allows one
   nonnegative historical USD budget per company/center/month. The month is
   always the first calendar day. Archived center budgets remain visible,
   but new/updated budgets require an active center. No budget updates
   produce vouchers, changes to GL, or inventory value changes.
6. **Variances and utilization**: by-center expense less budget; company
   total recognized expense includes unallocated amounts. Positive
   variance means over budget, negative means under budget. Budget amounts
   cover entire selected calendar months even for partial date filters.
   With a selected account, center-wide budgets are intentionally omitted
   rather than erroneously allocated to that account.
7. **Department totals**: each center rolls to the root ancestor of its
   company-scoped parent hierarchy. A child amount is counted once in
   the root department, not repeatedly at each intermediate level.
8. **By ledger account**: recognizes eligible source ledger account
   and separates direct expense from inventory-capitalized amounts.
9. **Trend analysis**: monthly expense, unallocated spend, budget and
   inventory cost plotted individually; the monthly data is downloadable.
10. **Source drilldown**: paginated 50-row source listing with posting
    date, cost center, account, original currency, historical USD,
    source module, allocation origin and voucher/daybook navigation.
11. **Exports**: CSV, .xlsx via ExcelJS, PDF via PDFKit of center,
    department, ledger-account, monthly and source-activity views.
    Exports retain report filters; activity exports are limited to
    5,000 rows with a clear date-narrowing error for larger datasets.
    Company-wide center exports include an explicit Unallocated row so
    totals reconcile to recognized company spending.
12. **Consolidated companies**: Admin/Owner/Developer users can read
    reports across only canonically authorized companies with an accounting
    role in each company (Developer global-access policy preserved).
    Company ID remains part of all group keys; expenses are never
    joined by code across companies. The tenant isolation middleware
    authorizes only a narrow list of consolidated report/export routes.
    There is no request-body company override or unrestricted cross-company
    access, and consolidation beyond 150 companies fails explicitly.
13. **Audit history**: budgets are written with an immutable original
    company/center, source actor ID, before/after snapshots and reason.
    Read via `GET /budgets/:costCenterId/:month/history`.

## API contract

Both prefixes include:
- `GET /reports/summary`
- `GET /reports/activity` with `limit` and `offset`
- `GET /reports/consolidated`
- `GET /reports/consolidated/activity`
- `GET /reports/export?format=csv|xlsx|pdf&view=summary|departments|accounts|months|activity`
- `GET /reports/consolidated/export` with the same filters
- `GET /budgets`
- `PUT /budgets/:costCenterId/:month` (amountUsd, optional notes, audit reason)
- `GET /budgets/:costCenterId/:month/history`

Reports accept `fromDate=YYYY-MM-DD`, `toDate=YYYY-MM-DD`,
`costCenterId`, `accountId`, and `treatment=ALL|EXPENSE|INVENTORY_COST`.
Consolidated scopes are authorization-derived and do not accept arbitrary
user-supplied company IDs. Date-scoped budget comparisons are **not prorated**.

## Changed files

- `migrations/20261021_004_cost_centers_phase6_budgets.sql`
- `migrations/meta/_journal.json` (appended phase 6 migration)
- `shared/schema/cost-centers.ts` (monthly budgets)
- `server/routes/costCenterReportingRoutes.ts` (analysis, controls, exports)
- `server/routes/applicationRoutes.ts` (shared controller registration)
- `server/middleware/tenantIsolationBoundary.ts` (narrow consolidated access)
- `client/src/components/financial/CostCenterReports.tsx` (complete UI)
- `client/src/pages/CostCenters.tsx` (both-mode integration)

## Accounting protections

Cost centers and budgets are **analytical dimensions, not GL accounts**.
These routes never call voucher creation/update, Factory raw-material
posting, container finalization, payroll posting or intercompany
transfer APIs. Do not assign inventoried raw materials/landed costs to
operating expense because those values remain an inventory asset until
proper recognition. Factory operational status entries (unfinalized
freight, loading/offloading, production/mix consumption, stock
transfers) are not P&L sources. The same posted source entry is
used only once in reports. Source historical USD is authoritative;
current FX configuration does not revalue past expense allocations.

## Claude release/verification checklist — not executed

Before deploying any phase:
- Verify Phases 1, 2, 5 and 6 SQL migration order/compatibility and
  PostgreSQL FORCE RLS behavior.
- Check TypeScript compilation and the existing React/FactoryShell
  sidebar access patterns; verify report endpoints are registered before
  their own dynamic `/:id` routes.
- Reconcile posted source activity against eligible voucher entries
  and independent Factory daybook entries by date/company.
- Validate mixed USD/CDF/CFA/EUR/AUD/GBP historical FX, debit-credit
  signs, reversed vouchers, optional/unfinalized documents, old
  archived centers and partial month variance presentation.
- Validate unallocated source completeness and account-filtered
  variances, hierarchy/root rollups, 150-company authorization,
  export totals, and 5,000-row export cutoff.
- Check a budget save does not create a voucher or change Profit,
  Net Position, Inventory valuation, or intercompany balances.
- Check security around report exports and budget edits, and
  confirm RLS scope cannot leak between pooled sessions.

This implementation is **code committed, not production-certified**.
Phases 7 (historical reassignment/reconciliation) and 8
(Claude testing, security review, release) remain separate.
