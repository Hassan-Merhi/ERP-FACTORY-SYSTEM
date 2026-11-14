# ERP Supplier Returns — Phase 6: Excel and Posted Audit History

Date: 2026-11-14
Branch: `feature/erp-supplier-returns-multi-container-average-cost`
Scope: Source-level Excel preview, durable import-row mapping, posted batch financial exports.

## Implemented
1. Preview Excel retains one line **per selected source container**, with the original imported quantity, input row, allocated qty, original offload record, supplier, purchase cost, landed rate, moving-average stock cost, estimated inventory relief and estimated variance. The original first 16 columns are preserved for existing export consumers; new data is appended.
2. New **Input Row Allocations** preview worksheet groups multiple allocations back into one original Excel row and reports original requested quantity, proposed allocated quantity, unallocated remainder and review status. Preview is always labeled non-posted; estimates are not ledger amounts.
3. New controlled migration `migrations/controlled/20261114_001_erp_supplier_return_allocation_rows.sql` creates `erp_supplier_return_allocation_rows` with input row, requested article code, requested quantity, per-source allocated quantity, source return line and company/batch identity. It also adds nullable `erp_supplier_return_lines.source_purchase_rate` to preserve the actual source purchase price used when posting; older batches retain NULL.
4. Posting transaction stores the original request-to-source relationships and rate at commit time, **atomically with** stock decrements, vouchers and return lines. Old clients without `requestedRows` remain compatible and generate no new allocation rows.
5. Posted history API returns original input-row allocations for each actual posted source line, supplier debit, inventory credit, original offload, voucher number and captured purchase rate.
6. Return History adds a per-batch **Posted Excel** button, detailed input-row breakdown and per-source purchase/realized inventory unit cost and signed difference.
7. Posted workbook sheets: `Posted Source Lines` (each financial posting exactly once), `Original Input Allocations` (each input row-to-offload mapping; no duplicate financial posting), and `Posted Summary` (exact batch totals). It rejects financial totals which do not reconcile to batch or original recorded per-row quantities. Legacy batches explicitly report missing input-row provenance rather than inventing it. All user-supplied Excel text is formula-escaped.

## Deployment requirement
**Apply the controlled migration in order before deploying the code.** The history API queries the new table and column; deployment without this migration will break that API. This migration is *not* auto-applied at startup. Its checksum is tracked by the repository's controlled migration runner.

Read-only plan:
```sh
npm run db:migrations:plan
npm run db:migrations:status
```
Explicit authorized apply (not performed here):
```sh
MIGRATION_CONFIRMATION=APPLY_CONTROLLED_MIGRATIONS npm run db:migrations:apply
```

## Tests authored
- `erpSupplierReturnMatchWorkbook.test.ts`: split row preview, original requested quantity, unallocated remainder.
- `erpSupplierReturnPostedWorkbook.test.ts`: 17+1 split, repeated import rows on one source, exact financial totals, legacy records, inconsistent mapping rejection, formula-injection protection.
- Earlier phases' source allocation, editable allocation, commit and financial reconciliation tests remain in branch.

## Remaining verification
- Tests, typecheck, formatting and live database transactions were **not executed** in this GitHub-connector session.
- No migration was applied; no production data changed, branch not merged/deployed.
- Phase 7 must execute CI, migration tests and a database-backed end-to-end check. Phase 8 is final PR review.

## Important accounting contract
The **posted** Excel supplier credit and inventory value are sourced from stored `erp_supplier_return_lines`, not a refreshed stock-average estimate. There is one posted source return line and voucher per original offload item, even when several workbook rows contributed quantities to it.
