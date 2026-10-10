# Automatic Priority Printing & Loading — Phase 6 handoff

## Status

Phase 6 **implementation code is committed** on `feat/automatic-priority-print-loading`, alongside Phases 1–5. No separate branch/PR was opened. Per user instruction **no TypeScript, unit tests, integration tests, lint, formatting, CI or physical hardware checks were executed**. Claude must verify before any production activation or merge.

## Business rules

A physically deleted factory bale must:

1. Be marked `DELETED` with `deleted_at`, never be available to load/print again.
2. Lose all **active editable** customer-loading bale links. Update affected customer order quantities, weight and monetary totals in the same transaction; append rows to `customer_order_bale_removals`.
3. Leave **permanent original allocation evidence intact**: original loading, priority, HMD color, product, actor and timestamps remain recorded. Set `reversed_at`, `reversed_by`, `reversed_by_user_id`, `reversal_reason` on active Priority Scan/auto-allocation rows rather than hard-deleting history.
4. If the physical bale was still `IN_STOCK` with a real ERP location, decrement that location's matching ERP stock item **exactly once**, through the same `adjustInventory` method used by existing stock removal. Append one canonical stock movement with the stable idempotency key `factory-bale-removal:<companyId>:<baleId>`. V5 customer-order attachment **does not itself decrement inventory**.
5. Remove any matching active `factory_daily_bale_scans` record. The immutable Priority Scan event remains queryable, annotated as reversed, for audit and historical tracing.
6. Write the `BALE_REMOVAL` factory daybook entry **inside the same database transaction** as stock movement, link deletion, totals and reversal history. There must be no successful deletion followed by a false retryable error due to a post-commit daybook failure.
7. Reject duplicate IDs, already deleted bales, wrong-company bale IDs, missing inventory/ERP stock item, and partially invalid batches. One failed item **rolls back the entire batch**. Repeating a committed deletion must not debit inventory or create a second movement.
8. Protect verified, finalized, sold and dispatched orders/bales. **Direct physical deletion is blocked** until the proper existing accounting/return process has been completed. Order rows are locked and rechecked after taking the proforma capacity lock.
9. Preserve the previously approved recovery rule: if removing a physical bale reopens an auto-completed, still-editable loading, it is eligible to return to Priority #1 without moving any other bale. Detailed queue-recovery hardening is Phase 7, but Phase 6 already calls the shared recovery service.

## One authoritative physical deletion service

`server/routes/factory/stock/physicalBaleDeletion.ts` exports `deletePhysicalFactoryBalesTx(tx,args)`, which requires the caller to hold the company Priority Scan advisory transaction lock. It performs all checks, link reversal, customer-order removals, physical inventory movement, daily scan cleanup, permanent deletion evidence, soft-delete and daybook as **one transaction**. No route may manually soft-delete a physical bale while bypassing this service.

### Covered write surfaces

| Entry point | Phase 6 behavior |
| --- | --- |
| `POST /api/factory/stock-entry/remove` | Supervisor-authenticated, all-or-nothing list removal |
| `POST /api/factory/stock-entry/remove-by-product` | Supervisor-authenticated, selected location/product bales; excludes already deleted stock |
| `DELETE /api/factory/bales/:id` | Factory Bale History physical deletion, including location inventory for unallocated stock |
| `PATCH /api/factory/bales/:id/status` with `DELETED` | Delegates to the deletion service |
| `PATCH /api/factory/bales/bulk-status` with `DELETED` | Delegates the whole set to the same service |
| Status PATCH with `REMOVED` | Rejects bypass (use controlled physical deletion) |
| Status PATCH trying to revive a deleted bale | Rejects |
| Stock Entry Remove Selected UI | Corrected endpoint to `/api/factory/stock-entry/remove` and `removed` response field |
| Generic `/api/deleted-items/factoryBale/:id/restore` | Blocks previously audited physical deletions; a stock receipt and reconciliation are required for restoration |

Loading-only `DELETE /api/factory/customer-orders/:orderId/bales/:linkId` is **not physical deletion** and must continue returning an editable bale to stock without a second ERP decrement. Its priority history gets a reversal marker; its physical factory bale remains present.

## Permanent deletion evidence

An additive startup/Drizzle table `factory_physical_bale_deletions` stores:

- Original `company_id`, `bale_id`, `reference_number`
- Physical `previous_status` and `original_location_id`
- `removed_by_user_id`, `removed_by_name`, `reason`, `removed_at`
- Unique `(company_id, bale_id)`: a second deletion cannot overwrite original evidence

The audit is independent of hard-deletable bale/order foreign keys. The generic restore route uses it, with fallback to canonical removal evidence for legacy deletions, to prevent `DELETED → IN_STOCK` from creating phantom stock.

## Concurrency and accounting

All physical deletion routes acquire the same company Priority Scan lock used for stock-entry allocation and queue changes. The reversal helper acquires linked proforma capacity locks in ascending order, then locks destination order rows before verifying `DRAFT`/`LOADING` status, then locks the physical bale before modifying inventory. A competing verified/finalized transition must not be silently bypassed.

The canonical removal journal reuses the existing production key format, so all routes reach the **same** single movement identity for a physical bale. If an ERP item or inventory balance is absent, the transaction fails without deleting the bale or its loading link.

## Files added or changed

- `server/routes/factory/stock/physicalBaleDeletion.ts` — centralized physical deletion service.
- `server/routes/factory/stock/stockRemovalRoutes.ts` — supervised list and per-product routes now use centralized reversal.
- `server/routes/factory/bales/balesCrudRoutes.ts` — general delete and single/bulk `DELETED` status routes now use centralized reversal; revival and `REMOVED` bypass blocked.
- `server/routes/factory/customer-orders/priorityAutoAllocation.ts` — post-proforma-lock destination order locking/status recheck.
- `server/startup/priorityScanSchema.ts` — idempotent permanent deletion audit DDL.
- `shared/schema/runtime/factory.ts` — Drizzle audit table declaration.
- `server/routes/admin/deleted-items/restore.ts` — guard against inventoryless restoration.
- `client/src/pages/factory/bale-stock-entry/RemoveFromStockTab.tsx` — corrected supervised removal path.
- `tests/setup.ts` — isolated factory test fixture.
- `tests/automatic-priority-physical-deletion-phase6.test.ts` — authored/unrun integration regression contract.

## Claude verification checklist (NOT run in this phase)

1. Run TypeScript/build checks, the new Phase 6 tests, existing factory stock-removal, Priority Scan, stock journal, customer-order removal and admin restore tests.
2. Create Red Priority #1 with an allocated Jogger bale; delete that bale from Stock Entry. Assert loading link removed, loading totals recalculated, priority history original color/priority retained and reversed, and location inventory **decreased by exactly one**.
3. Delete an ordinary unallocated bale from Bale History and from single/bulk status routes; verify the **same** inventory and canonical journal behavior.
4. Delete two bales at once, then retry with the same IDs. The second attempt must fail without any additional inventory or audit movement.
5. Simulate a batch containing a bale linked to a verified/finalized loading; the **whole** batch must roll back, including any earlier candidate.
6. Simulate missing ERP stock item, missing inventory balance, duplicate movement, daybook write failure and proforma conflict; no physical bale or customer-order data may be partially removed.
7. Check that user-company isolation, supervisor authentication, audit actor and reason snapshots are correct.
8. Try restoring a bale deleted by this service through generic Deleted Items: it must not become in-stock without a controlled new receipt.
9. Confirm that loading-only removal returns the bale to stock and does not post a physical stock decrement.
10. Exercise concurrency: two operators deleting the same bale, deletion racing with Stock Entry reprint, and deletion racing with finalization.
11. Run full CI only when Claude performs its eventual single-PR review and fix whatever is found.

Phase 7 (priority advancement/recovery hardening) and Phase 8 (full verification and rollout) remain. The company switch stays OFF by default. Do not enable in production or merge yet.
