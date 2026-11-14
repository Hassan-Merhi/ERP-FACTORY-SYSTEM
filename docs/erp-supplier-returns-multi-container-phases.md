# ERP Supplier Returns — Multi-Container Allocation and Average Cost

Branch: `feature/erp-supplier-returns-multi-container-average-cost`

## Goal
A single uploaded article-code/quantity row can be fulfilled by multiple original offloaded container item lines. The return must reduce physical stock and inventory book value, credit the correct supplier at each PO purchase rate, and post the variance with full traceability.

## Existing implementation verified
- `server/routes/erpSupplierReturnRoutes.ts` resolves container offload candidates, including alias codes, and restricts ambiguous supplier/currency sources.
- `client/src/pages/factory/FactorySupplierReturns.tsx` currently permits one offload item per imported row.
- Commit uses one transaction, advisory request-key lock, source row locks, inventory locks, audited return lines, idempotent stock movements, `adjustInventory`, and balanced vouchers.
- Inventory reduction already comes from `adjustInventory(...).valueDelta` using the inventory valuation; supplier credit comes from source purchase rate. Do not replace authoritative valuation with container landed rate.

## Phase 1 — Audit and safety baseline
- Trace inventory helper valuation and movement posting; verify whether cost is per company/location/stock item.
- Review existing return migration, accounting and multi-row semantics.
- Capture baseline tests and locate any special stock, reversal and offload invariants.

## Phase 2 — Allocation model and server preview
- Keep the simple Excel input contract `article_code, qty`.
- Add ordered allocation suggestions per imported row: `[{offloadItemId, quantity}]`; keep backward-compatible preview fields while updating clients.
- Deduct already-reserved quantities across all upload rows and across the same company/location/stock item.
- Only source from valid offloaded containers, same selected supplier, unambiguous USD supplier PO, and eligible original offload quantity.
- Distinguish complete, partial, no-stock, invalid-selection, and unsupported-source statuses.
- Never fabricate a second source; show unallocated remainder.

## Phase 3 — Manual allocation UI
- Each imported row has expandable allocation lines, source selector, quantity editor, add/remove controls, and live total remaining.
- Show stock availability, source returned-to-date, source original qty, source purchase rate, current average inventory cost and projected accounting variance.
- Prevent concurrent source double-allocation within same workbook.
- Apply the existing supplier/admin access policy.

## Phase 4 — Posting and inventory
- Convert all row allocations to aggregated per-offload-item commit lines without losing source-row reference in preview/export.
- Enforce exact requested-versus-allocated total server-side, not only in browser.
- Validate all source and per-location inventory totals under locks before any posting.
- Post all lines atomically. No partial batch, negative quantity, or duplicate retry posting.
- Record exact stock movement and return audit line for every source.
- Ensure both stock quantity and inventory value decrement and reconcile.

## Phase 5 — Moving-average value and vouchers
- Use authoritative moving-average cost at company/location/item for inventory issue value.
- Each source supplier debit uses actual source PO purchase rate times returned quantity.
- Inventory credit equals actual value removed; difference is posted to supplier-return cost variance with balanced debit/credit.
- Keep existing historic PO, offload and vouchers unchanged. No unrequested retroactive recalculation.
- Reconcile rounding at line and batch precision; reject invalid zero/negative inventory valuation.
- For multiple locations, use the distinct average for each stock bucket.

## Phase 6 — Excel and history
- Preview export: one allocation per line, source container, offload id, original import row, requested total, allocated qty, available qty, unit purchase rate, moving-average rate, projected value and status.
- Persist container/source allocation in return audit lines; history detail and batch totals match posted journal.
- Retain simple template; add optional explicit source allocations only as a future compatible extension.

## Phase 7 — Tests and database validation
- 18 from 17+1; three-source split; duplicates/aliases; two workbook lines using same stock; 100% and partial allocations.
- Wrong supplier/currency, insufficient stock, sold/consumed stock, concurrent requests, failed voucher, rollback, idempotency replay.
- Mixed purchase costs, shared moving-average bucket, separate locations, precision/rounding and value reconciliation.
- UI tests and backend integration tests; verify balance and no inventory double-decrement.

## Phase 8 — Release readiness
- Run typecheck/tests/CI where available, inspect diff and migration needs, open PR against main.
- No merge or production deployment without explicit authorization.

## Release acceptance criteria
- One article can allocate across any eligible number of source containers.
- The total allocation equals requested quantity; all source and aggregate inventory bounds respected.
- Deducted inventory quantity and value match stock movements and inventory GL credit.
- Supplier balance changes equal the source-based credit, with variance balanced and auditable.
- Repeated requests cannot double-post; failures leave no partial stock or accounting mutations.
