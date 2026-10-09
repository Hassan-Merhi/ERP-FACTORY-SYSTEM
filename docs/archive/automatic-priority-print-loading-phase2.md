# Automatic Priority Printing & Loading — Phase 2 handoff

## Status

Phase 2 is implemented in code on the **same** `feat/automatic-priority-print-loading` branch as Phase 1 and the rest of the feature. No PR, local checks, unit tests, integration tests or CI have been run. Claude owns verification before this becomes production-ready.

## Historical contract

For every successful automatic or manual Priority Scan allocation, the server saves a durable historical event in `factory_priority_scan_history` in the same transaction as the order-bale link. The original snapshot includes:

- Active factory company ID and physical bale ID
- Reference, article, and product name at assignment time
- Original customer loading ID and linked proforma ID
- **Original** position/priority and hex color, never recomputed from today's priority queue
- Source: `stock-entry`, `reprint` or `manual` (legacy rows may use `automatic`)
- User ID, operator name, business date, and timestamp

The active snapshot table `factory_priority_auto_allocations` additionally stores the original assignment, source, user, and a `history_id` pointing to the exact historical event. A partial unique index protects against **two simultaneous active automatic allocations** for the same company/bale.

### Deletion / reversal

A successful removal updates only reversal fields, preserving the original assignment: `reversed_at`, `reversed_by`, `reversed_by_user_id`, `reversal_reason`. Records are **not deleted**, and the normal scanner's today-history query continues to hide reversed events.

A newly reallocated physical bale receives a **new** history row; the older reversed row remains queryable. Archive tables deliberately do not FK-reference live bale/order records so future physical/order hard deletes cannot erase or block historical evidence.

### OFF behavior

The automatic allocator checks for an already-active snapshot before reading the company-wide ON/OFF flag. Switching OFF blocks **new** automatic allocations, but all existing active allocations, historical rows, and the color used on earlier printed labels remain unchanged. Reprinting an already assigned bale returns its original color even while OFF.

## Read API (GET)

`/api/factory/customer-orders/loading-list/priority-allocation-history`

Authentication and current company scope are mandatory. At least one of `baleId`, `orderId`, `referenceNumber` must be provided. Multiple filters combine with AND. Optional `limit` is 1–100 (default 50) and `beforeId` performs newest-first cursor pagination.

Response:

```json
{
  "items": [
    {
      "id": 100,
      "baleId": 501,
      "orderId": 14,
      "referenceNumber": "REF-501",
      "articleCode": "PANT-A",
      "productName": "Adult Jogger Pant",
      "originalPriority": 1,
      "originalColor": "#dc2626",
      "originalProformaId": 10,
      "allocationSource": "stock-entry",
      "assignedByName": "Operator",
      "assignedByUserId": "user-id",
      "businessDate": "2026-10-09",
      "assignedAt": "2026-10-09T11:00:00.000Z",
      "reversedAt": null,
      "reversedBy": null,
      "reversedByUserId": null,
      "reversalReason": null,
      "active": true
    }
  ],
  "nextCursor": null
}
```

The archive read deliberately does **not** join to current priority configurations; reordering the queue or editing a loading's color cannot rewrite history. Responses are `Cache-Control: private, no-store`.

## Changed Phase 2 files

- `server/startup/priorityScanSchema.ts`: additive idempotent history and allocation fields, indexes and archive independence from physical FKs.
- `shared/schema/runtime/factory.ts`: matching Drizzle declarations.
- `server/routes/factory/customer-orders/priorityAutoAllocation.ts`: original source/user/proforma and linked history ID, original reprint color after OFF, reversal evidence.
- `server/routes/factory/customer-orders/bale-scanning/scan.ts`: original manual operator/proforma snapshot.
- `server/routes/factory/customer-orders/priorityAllocationHistoryRoutes.ts`: new paginated company-scoped history read endpoint.
- `server/routes/factory/customer-orders/priorityScanConfigRoutes.ts`: route registration.
- `server/routes/factory/stock/stockRemovalRoutes.ts`, `server/routes/factory/bales/balesCrudRoutes.ts`, `server/routes/factory/customer-orders/bale-scanning/remove.ts`: actor identity on reversal.
- `tests/automatic-priority-allocation-history-phase2.test.ts`: unrun regression suite.

## Verification for Claude

Run TypeScript compilation, `tests/runtime-declared-tables-ddl.test.ts`, `tests/automatic-priority-allocation-history-phase2.test.ts`, existing Priority Scan tests, concurrency/inventory tests, and eventually full CI **only when Claude starts review**. Check automatic insert/reprint with both modes, queue changes after printing, live/deleted order reads, two scans competing for one bale, idempotence, audit after reversals, pagination, and company isolation.

The feature remains OFF by default and is not ready to enable in production until all phases have passed verification.
