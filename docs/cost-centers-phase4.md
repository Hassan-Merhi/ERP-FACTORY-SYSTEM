# Cost Centers — Phase 4: Factory Mode Integration

## Status / deployment boundary

Phase 4 application changes have been committed on the same
`feature/cost-centers-phase1-foundation` branch as Phases 1–3. This is a
source-code implementation, **not a deployed or tested production release**.
The owner delegated CI/checks to Claude. No checks, migrations, financial
vouchers, production writes, merges, or deployments were run here.

## Factory Mode entry points

- **Factory → Finance → Cost Centers**: `/factory/cost-centers` in the
  canonical Factory page-access registry and Factory sidebar.
- The existing `CostCenters` component uses the Factory API prefix when in
  Factory Mode. It supports create/edit/archive, parent cost centers, company
  isolation, date-limited source activity, grouped historical USD amounts, and
  factory-aware deep links back to vouchers / daybook entries.
- Existing Factory Accounts page permission also authorizes the new page
  (subject to active-company Admin/Owner/Developer write roles); Manager has
  read-only access. Users may also be granted the dedicated Factory Cost
  Centers page. Factory Vouchers and Daybook can read catalog pickers for
  transaction tagging without broader management rights.
- **Factory Voucher Detail** uses the same editable per-entry cost-center
  splitter as ERP, routed to `/api/factory/cost-centers` and validated by
  the backend. It does not alter the voucher's amounts.
- **Factory Daybook** transaction details show either the voucher-backed
  expense splitter (if `reference_table='vouchers'`) OR the standalone
  daybook expense editor. The same event is never tagged through both
  representations.
- Synthetic daybook entries with negative IDs cannot be tagged as standalone
  transactions. They resolve through the underlying voucher ID instead.

## Allowed Factory source types

1. **Posted accounting expenses:** Expense / Direct Expense /
   Indirect Expense ledger entries, associated with eligible finalized posted
   vouchers. Includes eligible factory production, maintenance, administration,
   transport, and payroll expenses **when actually posted as expense lines**.
2. **Factory inventory-capitalized analytical costs:** debit-side source
   entries posted to `FACTORY_RAW_MATERIAL_STOCK`, `FACTORY_WIP`, or
   `FACTORY_FINISHED_GOODS`, only when the entry has a positive debit and
   zero credit. They retain `INVENTORY_COST` treatment and are reported
   separately from recognized expenses.
3. **Standalone Factory Daybook expenses:** only
   `EXPENSE`, `OPERATING_EXPENSE`, `FACTORY_EXPENSE` events not associated
   with voucher, voucher_entries, or factory_pos_sales references.
4. **Not eligible for independent cost allocations:** supplier and customer
   payments, mirrored journal/daybook rows, POS sales/deductions already
   posted by vouchers, freight/landed costs before a correct accounting
   posting, loading/offloading status events, raw material mix consumption,
   stock transfers, operational payroll cash movements and non-finalized
   containers. These may acquire an analytical center **through their eligible
   underlying posting**, never as a duplicate financial expense.

## Files changed for Phase 4

- `shared/factoryAccessRegistry.ts`: Factory Finance entry and permission.
- `client/src/components/FactorySidebar.tsx`: icon, navigation,
  company-page and role visibility.
- `client/src/components/FactoryRoutes.tsx`: guarded Factory route.
- `client/src/pages/CostCenters.tsx`: shared, Factory-aware management.
- `client/src/components/financial/VoucherCostCenters.tsx`: shared,
  Factory-aware voucher and daybook entry splitter, currency and treatment.
- `client/src/pages/VoucherDetail.tsx`: Factory voucher allocation surface.
- `client/src/api/costCentersApi.ts`: inventory vs expense entry type.
- `client/src/pages/factory/daybook/FactoryDaybookCostCenters.tsx`:
  standalone expense and voucher-backed daybook attribution surface.
- `client/src/pages/factory/daybook/FactoryDaybookDialogs.tsx`: detail UI.
- `server/routes/costCenterRoutes.ts`: Factory-only inventory receipt
  eligibility and source type, company-scoped API/validation.
- `server/middleware/factoryBackendAccessBoundary.ts`: Factory page owner,
  Accounts permission compatibility and read-only picker access.
- `migrations/20261021_002_cost_centers_phase2_integrity.sql`: narrowed
  pre-release database validation for recognized factory inventory receipts.
- `client/src/lib/parent-routes.ts`: Factory Cost Centers parent navigation.

## Integrity guarantees

Cost centers remain **analytical dimensions**, never selectable bank, cash,
ledger or supplier accounts. Posting records, invoice totals, raw material
quantity/value, cost/kg, production balances, inventory valuation, Net
Position and existing voucher posting logic are unchanged by Phase 4. The
backend validates original/native and historical USD split totals and rejects
cross-company references. Capitalized inventory amounts are identified and
displayed separately from operating expenses. No automatic allocation occurs
yet: **Phase 5** owns source-to-center defaults and automatic tagging.

## Validation for Claude

Check TypeScript/React composition, active company selection and Factory page
permissions, cost-center migrations in order, the two voucher detail surfaces,
Factory Daybook synthetic/real entry behavior, historical FX rounding,
archived parents, capitalized source classifications, database RLS and audit
writes. Confirm a finalized factory expense line can be allocated, a mirrored
Factory Daybook row cannot produce a second allocation, and that cost centers
never change journal, stock, or Net Position totals. CI and deployment remain
outside the implementation assistant's requested scope.
