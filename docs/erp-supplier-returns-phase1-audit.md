# Phase 1 complete — supplier-return allocation/valuation audit

Date: 2026-11-14
Scope: source-code audit only (no production database writes, migrations or deployments).
Branch: `feature/erp-supplier-returns-multi-container-average-cost`

## Source inspection
- `server/routes/erpSupplierReturnRoutes.ts`: candidate matching, supplier and USD checks, preview, commit, audit history.
- `server/inventoryHelper.ts`: authoritative issue valuation and average cost.
- `server/services/inventory/stockMovementIntegrityService.ts`: movement contract and validation.
- `server/services/inventory/databaseStockMovementAdapter.ts`: movement persistence, idempotency and scope.
- `migrations/controlled/20261113_001_erp_supplier_offload_returns.sql`: existing return batch/line audit schema.
- `client/src/pages/factory/FactorySupplierReturns.tsx`: Excel import, single-source selection, preview and commit.
- `client/src/pages/factory/erpSupplierReturnMatchWorkbook.ts` and its existing Vitest coverage.
- `client/src/pages/factory/supplierReturnQuantityValidation.test.ts` and `package.json` scripts.
- `scripts/audit-erp-supplier-inventory-cost.ts`: historical provenance auditor; not a general supplier-return reconciler.

## Verified behavior
1. **Current blocker:** preview selects `eligible` candidates only if **one** source independently covers the requested quantity (`remainingQty >= qty` and `availableQty >= qty`). Browser state `chosen` is one offload item ID per uploaded row. Thus 17+1 cannot satisfy an 18-unit row, even though commit already accepts multiple separate source lines.
2. **Source traceability:** return lines already store `offload_item_id`, `offload_id`, `container_id`, `stock_item_id`, `location_id`, supplier ID, and per-source quantity and financial amounts. Original offloads/POs and historical vouchers are not rewritten by this handler.
3. **Stock effect:** the commit performs `postStockMovementTx` plus `adjustInventory(tx, locationId, stockItemId, -qty, ...)` in one database transaction; these are respectively canonical movement evidence and the actual inventory quantity/value update, not two stock decrements.
4. **Authoritative cost:** `inventory.total_value` (2dp) and `inventory.quantity` (3dp), with `inventory.average_rate` (7dp) as cost memory/display. For an issue, `adjustInventory` preserves the moving-average anchor and calculates the actual **stored** value delta, flushing residual value on the last unit. Use `-valueDelta` to credit inventory, not `qty * original landed rate` or a newly rounded estimate.
5. **Supplier side:** supplier debit is `qty * source.unitPurchaseCost` rounded to cents, and supplier-return variance balances the difference to actual inventory value relieved. A source has to map to exactly one supplier and USD currency; ambiguous/non-USD sources are deliberately blocked.
6. **Concurrency:** commit serializes the request key with an advisory transaction lock, locks offload item rows before checking already-returned quantities, checks aggregate inventory quantity by `locationId:stockItemId` under row locks, and commits all stock, audit and voucher effects atomically.
7. **Authorization:** preview/commit/history use authenticated Admin/Developer guards and active-company access. Candidate lookup covers exact stock item code or stock alias code.
8. **Existing tests:** quantity validation and workbook exported totals/formula escaping have unit tests. No dedicated multi-source allocation test was found among the matching supplier-return files during this audit.

## Required Phase 2 decisions
- **Allocation capacity is two-dimensional:** each source has original-offload remainder, while multiple sources can share **one** location/item inventory balance. A naive sum of each candidate's `availableQty` double-counts the same physical stock.
- Allocate deterministically (current source ordering: latest offload first), decrement **per-source** remaining capacity and **per-location/item** available capacity as allocations are proposed, including prior uploaded rows.
- Preserve supplier and USD eligibility; when supplier filter is unset, do not silently allocate one imported article across different suppliers: require an explicit supplier choice/review or enforce a uniform supplier across the allocation.
- Preview suggestions are not reservations in database; commit must re-read and revalidate **all** selections inside the transaction.
- Aggregate selected rows to one quantity per offload item for the existing `UNIQUE(batch_id, offload_item_id)` constraint; preserve imported-row associations in the preview/export without pretending one offload item is a unique physical bale.
- Preserve existing request-key/idempotency semantics. Avoid changing `adjustInventory` or creating a parallel valuation formula.
- Reconcile canonical movement cost (recorded 7dp memory) against actual 2dp inventory value delta; don't infer monetary GL postings from the movement's rate-multiplied nominal value.
- Display exact source supplier purchase cost separately from stored moving-average inventory cost.

## Risks and pre-release checks
- Existing `adjustInventory` selects inventory rows by `location_id + stock_item_id` (no `company_id` in that query), consistent with its `ON CONFLICT (location_id, stock_item_id)`. Confirm location/item ownership invariants, don't modify globally in this feature without broader tests.
- Existing candidate source supplier lookup joins PO item and container; mixed-source POs deliberately fail single-supplier/currency validation. Validate realistic data before expanding that contract.
- Multi-line postings sharing a stock bucket must be valued sequentially by `adjustInventory`; rounding can distribute cents differently by line while the **batch** must equal the exact stored book-value delta.
- Lock ordering should be deterministic for all offload rows and inventory buckets. The existing handler sorts source IDs; the new allocator must preserve that to avoid deadlocks.
- No migration is required for the basic multiple-source-per-import-row posting because the existing return ledger stores one record per offload item. A new schema is only justified if a durable original Excel row-to-allocation relation is required.
- Coverage still needed: 18=17+1, 3+ source, shared stock capacity, mixed supplier, duplicate alias, repeated same offload ID, simultaneous posts, partial result, failure rollback, 2dp variance and last-unit residual, multi-location averages.

## Reproducible verification commands (not run in this connector-only audit)
```sh
npm run check
npm run test:backend
npm run test:frontend
npm run verify:migrations
```
Focused existing front-end tests:
```sh
node node_modules/vitest/vitest.mjs run --config vitest.config.frontend.ts client/src/pages/factory/erpSupplierReturnMatchWorkbook.test.ts client/src/pages/factory/supplierReturnQuantityValidation.test.ts
```

## Phase 1 exit
**Source audit, accounting contract, target design constraints, and test matrix completed.** No claim of green tests, live database reconciliation, or deployed behavior: execution and database access have not occurred. Functional changes begin in Phase 2.
