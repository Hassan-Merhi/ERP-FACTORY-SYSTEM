# Cost Centers — Phase 3 ERP Interface

## Scope and user workflow

Phase 3 adds ERP-side interaction on the existing Phase 1/2 foundation. It does not
modify a ledger posting, create an expense voucher, revalue historical transactions,
or introduce factory-specific navigation (Phase 4).

1. Open ERP **Accounting → Cost Centers** (`/cost-centers`) to create, edit,
   re-parent, archive, search, and inspect company-owned centers.
2. View analytical balances separated by EXPENSE and INVENTORY_COST. Inspect
   source activity by date and follow voucher links into the original record.
3. Open a **posted** ERP voucher from Daybook or Voucher Detail. Its **Cost Centers**
   section lists eligible expense *voucher entries*, not the payment account.
4. Select **Assign / Split** on an expense entry. Add one or more cost centers,
   enter original-currency amounts or percentages, and save. The UI derives each
   historical USD amount from the authoritative source instead of using current FX.
5. To clear all allocations, remove the split rows and Save Allocation with a reason.
   The underlying voucher and ledger balances remain unchanged.
6. ERP Daybook now has a **Cost Center** filter, applied in SQL before pagination
   so all pages and cost-center-filtered exports use the same voucher predicate.
   Historical/archived center selection remains supported by stored filter ID.

## Files

- `client/src/pages/CostCenters.tsx`: directory, CRUD dialog, hierarchy,
  archiving, date-filtered analytical activity, voucher drill-down.
- `client/src/components/financial/VoucherCostCenters.tsx`: posted voucher entry
  allocation editor supporting fixed native-currency amounts and percentages.
- `client/src/api/costCentersApi.ts`: typed client contracts.
- `client/src/lazyPages.ts`, `client/src/routes/ErpRoutes.tsx`,
  `client/src/components/AppSidebar.tsx`,
  `client/src/app/erpAccess.ts`, `client/src/lib/parent-routes.ts`:
  ERP navigation, route guard and parent path.
- `client/src/pages/VoucherDetail.tsx`,
  `client/src/pages/daybook/VoucherDetailsDialog.tsx`: entry allocation panels.
- `client/src/pages/daybook/DaybookFilters.tsx`,
  `client/src/pages/daybook/filterState.ts`,
  `client/src/pages/daybook/usePaginatedDaybookVouchers.ts`: server-scoped filters,
  pagination and consistent filtered export.
- `server/routes/costCenterRoutes.ts`: eligible posted ERP expense-entry
  listing with recorded allocated/unallocated amounts; dated center activity.
- `server/routes/vouchers/voucherPaginationRoutes.ts`: SQL cost-center
  predicate applied *before* count and pagination.

## Security and accounting behavior

- Cost center edits and allocations require the existing backend company-scoped
  Admin / Owner / Developer role. Manager has read-only access.
- Normal/POS users cannot use the cost-center financial UI endpoints.
- Company IDs are not posted from the UI; the backend derives authorization
  from active-company permissions, protected by RLS.
- The UI presents only eligible posted **Expense, Direct Expense and Indirect
  Expense ledger entries**. Inventory capitalization and other posting types are
  intentionally excluded from this Phase 3 selection UI; later Factory Mode
  workflows can expose eligible inventory-cost tagging without P&L duplication.
- Each allocation writes only to `cost_center_allocations`, not voucher
  entries, accounts, supplier balances or Net Position.
- Historical FX amounts use the source's native/base ratio, rounded at six
  decimals. Allocation totals cannot exceed the posted entry.
- Some pre-existing vouchers (protected, optional, migrated, deleted) are not
  eligible and return no assignable expense rows.
- Empty/unassigned amounts remain analytical **Unallocated**; no corrective
  vouchers are generated.

## Deliberate phase boundaries

- Creating a voucher does not automatically allocate its new lines. Cost centers
  can be assigned immediately **after posting** from the voucher detail or
  Daybook. This avoids mixing voucher creation with a second write that could
  leave partially allocated financial records. Automatic mappings come in Phase 5.
- Factory-mode cost-center navigation and line UI come in Phase 4.
- Budgets, month-on-month analysis, Excel/PDF dedicated cost-center reports
  and consolidated profitability come in Phase 6.
- The activity view uses server-side date filtering and 50-row pagination.
- Phase 1 and 2 migrations must be applied in their registered order before use.

## Claude validation handoff

Per owner instruction, no CI, automated tests, type checks, deployment or
production database changes were run by the implementation assistant.
Claude should validate compilation, RLS access, historical-currency scenarios,
legacy vouchers, source lifecycle, cost-center splitting (including rounding
and clear-all), Daybook pagination/export and responsive layouts in a controlled
environment prior to merge/deploy. No pull request was opened and `main`
was not changed.
