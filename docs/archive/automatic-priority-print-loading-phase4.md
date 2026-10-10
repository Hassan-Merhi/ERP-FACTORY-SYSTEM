# Automatic Priority Printing & Loading — Phase 4 handoff

## Status

Implementation code for **Phase 4 (new Stock Entry to Priority Scan allocation)** has been committed on the existing **`feat/automatic-priority-print-loading`** branch. This is one branch for the entire feature; no PR has been opened yet. **No type checking, unit tests, integration tests, print tests, or CI have been run**. Claude is the designated verifier. Factory feature switch remains OFF by default.

## Authoritative business behavior

1. On `POST /api/factory/stock-entry`, acquire the **company Priority Scan advisory transaction lock before any stock/inventory/proforma locks**, then read the company's operational ON/OFF flag. All bales in this Stock Entry batch use the same authoritative mode.
2. Create physical `factory_bales` records and worker production attribution, update mix batch usage, apply **one stock receipt per stock item**, and record canonical movement evidence using the existing service. This is not a stock deduction.
3. With ON, for each inserted bale in reference order:
   - Identify its actual article and inventory location. Only exact company-owned, physically `IN_STOCK`, not-deleted bales can be allocated.
   - Resolve the **first queue position whose current LOADING order, active configuration and linked proforma still require the article**. Use the existing Priority Scan routing function; no client-supplied color or loading target is trusted.
   - Take the proforma capacity lock before bale/order row locks. Recheck the target's current status, proforma, **per-loading membership/remaining quantity** and cross-order duplicate ownership. **No overload or out-of-proforma bypass**.
   - Calculate price according to the linked proforma's per-bale/per-kg pricing (fallback only as manual scanner does), insert `customer_order_bales`, store immutable allocation and Priority Scan history with source `stock-entry`, record production-date Daily Scan, then update the affected article's loading totals.
   - Auto-advance satisfied priority configurations **under the same transaction lock**. The next bale in this same batch can move immediately to the next eligible loading.
   - If nobody needs the article, leave the physical bale unallocated and return it for **normal label printing**. It remains in inventory.
4. With OFF, skip all automatic allocation; physical Stock Entry and ordinary printing continue. Existing saved assignments are never undone by turning OFF.
5. The daybook `BALE_STOCK_ENTRY` entry is now **in the same database transaction** as physical bale creation, stock receipt, allocation, scans, pricing and queue advancement. A failed step rolls back the entire operation; the API cannot return an error after successfully committing new bales.
6. A successfully auto-loaded V5 bale **remains physically `IN_STOCK`** (existing ERP convention) while `customer_order_bales` makes it unavailable to other loading scans. Do not separately reduce ERP inventory at the allocation stage.

## Stock Entry response

Previous `bales` and `totalWeight` fields remain. Added:

```json
{
  "automaticPriorityModeEnabled": true,
  "autoPriorityAllocations": [
    {
      "baleId": 501,
      "referenceNumber": "REF000501",
      "orderId": 21,
      "priority": 1,
      "color": "#dc2626",
      "source": "stock-entry",
      "existing": false
    }
  ],
  "autoPrioritySummary": {
    "allocated": 1,
    "leftInStock": 0
  }
}
```

The response assignments are server-authoritative; missing a bale from `autoPriorityAllocations` means it did **not** auto-load at commit. The printed color is taken only from an immutable allocation record.

## Printing handoff

The Stock Entry page now displays `autoPrioritySummary`, invalidates Priority Scan/loadings caches after automatic allocations, and passes assignment data to its existing `printLabels` call. The printing function waits for the label-print audit/preflight response and merges **the most recent server assignment snapshots before rendering any labels**, eliminating a race where a priority becomes active between stock-entry commit and printing. When auto mode was ON and preflight cannot be confirmed, printing fails closed with a warning instead of producing a possibly misleading label. When OFF, the legacy best-effort print audit fallback is retained.

All `/api/bale-label-prints` and `/api/bale-label-prints/reprint` company IDs use the selected factory company, and physical bale/product lookups cannot borrow another company's records.

## Concurrency and no-overload guarantees

- Feature toggles, priority configuration changes and automatic Stock Entry routing take the same company queue lock.
- Proforma capacity locks are acquired before locking the destination order/bale, using the existing manual Priority Scan order.
- Subsequent bales cannot overfill a loading: each allocation re-resolves the queue, validates remaining capacity, updates counts and advances completed loadings inside the same transaction.
- Multiple Stock Entry requests waiting on the company lock see committed results of the previous request. Distinct receipt batches use independent canonical idempotency keys and are never deducted for a loading allocation.

## Code files

- `server/routes/factory/stock/stockEntryRoutes.ts`: atomic Stock Entry, original stock journal, queue lock and response.
- `server/routes/factory/customer-orders/priorityAutoAllocation.ts`: final per-loading authoritative capacity validation.
- `client/src/pages/factory/bale-stock-entry/StockEntryTab.tsx`: status/queue refresh and immutable color handoff.
- `client/src/pages/factory/bale-stock-entry/StockEntryPrinting.ts`: awaited server print preflight and authoritative color merge.
- `server/routes/baleRoutes.ts`: company-scoped print preparation for new Stock Entry and existing bales.
- `tests/setup.ts`: isolated factory test-company prefix.
- `tests/automatic-priority-stock-entry-phase4.test.ts`: **authored but not executed** integration regressions.

## Claude acceptance checklist (deferred)

- Run TypeScript compilation, the new Phase 4 tests, canonical Stock Entry journal tests, existing Priority Scan tests, UI print-gate tests and full CI.
- Verify an ON company creating 3 Jogger bales against Red #1 (2 required) and Blue #2 (2 required): **2 Red, 1 Blue**; then a 2-bale batch: **1 Blue, 1 unallocated**.
- Verify separate proformas and sibling loadings have independent per-loading capacity, correct price used, and article-specific limits.
- Confirm the original Stock Entry inventory receipt is **unchanged** by digitally loading a V5 bale; canonical stock movement quantity equals physical bale count exactly once.
- Run concurrent creation requests competing for two remaining proforma bales; never exceed 2, never create duplicate active bale allocations.
- Confirm unconfigured articles use normal labels without allocation; the switch OFF does no automatic loading and cannot undo earlier allocations.
- Confirm the Print endpoint returns the same historic color before/after queue changes, and handles last-moment newly eligible allocations before rendering.
- Verify daybook, stock movement and loading history commit or roll back **together**. Simulate a forced daybook failure during Stock Entry and verify zero new physical bales and no partial inventory/scan record.
- Check company boundaries for incoming product IDs and existing bale print requests, including cross-company print attempts.
- Confirm physical print hardware and label layout later under Claude's end-to-end verification, including monochrome Zebra handling.

The remaining implementation Phases 5–8 and Claude's full verification are still pending. Do not enable the switch in production before approval.
