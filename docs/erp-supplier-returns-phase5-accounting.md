# Supplier Returns Phase 5 — Moving-Average Inventory and Supplier-Credit Accounting

Date: 2026-11-14
Branch: `feature/erp-supplier-returns-multi-container-average-cost`
Status: implementation committed; CI/database execution not yet verified.

## Source of truth
- **Stock quantity:** company/location/stock-item `inventory.quantity`, adjusted once by `adjustInventory` for every source line.
- **Stock valuation:** `inventory.total_value` and the exact two-decimal `adjustInventory(...).valueDelta`. The displayed seven-place moving-average rate is not the posted inventory amount.
- **Supplier amount:** original source offload purchase rate (`container_offload_items.rate`) multiplied by return quantity and rounded to two decimal places.
- **Variance:** signed inventory relief minus supplier credit, on `SUPPLIER_RETURN_COST_VARIANCE`. The voucher credits inventory and debits the supplier; variance is debit if inventory relief > supplier credit, otherwise credit.
- **Accounting source identity:** one audited ERP supplier return line and one deterministic voucher identity per offloaded source. Prior PO/offload voucher entries remain immutable.

## New financial reconciliation
`server/routes/erpSupplierReturnFinancials.ts` validates that:
1. Quantity actually decreased by the allocated amount and never below zero.
2. Inventory's previous stored book value minus its new stored book value equals the negative reported `valueDelta` to the cent.
3. Inventory relief is nonnegative; supplier purchase rate is nonnegative.
4. Per-source supplier debit + variance debit = inventory credit + variance credit.
5. Accumulated batch supplier/inventory totals equal the exact line financials, and combined variance debits and credits balance.

The handler now invokes this reconciliation inside the same database transaction as stock movement, the physical inventory update, the audit line and voucher creation. Any failed assertion throws and rolls back all changes in that transaction. The existing central voucher posting engine also validates balanced entries and company ownership.

## Example (illustrative only)
One 18-bale row split 17+1 across two offloads. If all 18 share a $65 inventory average, the inventory credit is $1170. Supplier credits are calculated separately from each source purchase rate:
- Source A 17 × $58.12 = $988.04
- Source B 1 × $62.03 = $62.03
- Supplier debit $1050.07, inventory credit $1170.00, variance debit $119.93
The remaining stock retains its moving-average rate except for normal rounding; when the last unit is issued, the inventory helper flushes the residual stored value.

## Test cases authored
`server/routes/erpSupplierReturnFinancials.test.ts` covers higher inventory than supplier amount, reverse variance, zero variance, last-bale residual, fractional quantity, mixed rates/locations and batch cent reconciliation, and invalid quantity/value change.

## Validation still outstanding
- Tests have been committed but **not run** (no execution environment exposed through the GitHub file connector).
- No live database assertions, voucher-row ledger inspection, rollback or concurrent posting tests were executed.
- Before merging, run `npm run check`, `npm run test:backend`, `npm run test:frontend`, and targeted database-backed accounting integration tests. Phase 7 must demonstrate end-to-end reconciliation and failure rollback.
- No production data, migrations, merge or deployment were performed.

## Next
Phase 6: export the individual allocations with original requested quantity, actual posted quantity, source-specific purchase cost, average inventory cost and value/variance; expose complete audit history.
