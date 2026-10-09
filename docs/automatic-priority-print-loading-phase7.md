# Automatic Priority Printing & Loading — Phase 7 handoff

## Status

Phase 7 implementation has been committed on the **same single feature branch**, `feat/automatic-priority-print-loading`, as Phases 1–6. The proposed PR will cover all phases together. **No CI, TypeScript checks, unit tests, integration tests, formatting checks or live-printer tests were run**. Claude is responsible for all verification, fixes and CI before merge/activation.

## Approved behavior

**When a previously auto-completed loading loses an allocated bale and is still editable, it returns to Priority #1.** It finishes its missing proforma quantity before subsequent automatic allocations route to the next eligible loading.

Example:

1. **Red #1** requires two Jogger Pant bales. **Blue #2** also requires two.
2. Red gets its two and auto-completes, releasing its active queue slot. Blue becomes #1 and may receive its own bales.
3. A physical Red bale is deleted (or removed from its editable loading), reducing Red to one of two required.
4. Red reopens as **#1** and Blue becomes **#2**. Previously allocated Blue bales remain attached to Blue with their **original** immutable snapshots and HMD label colors.
5. The next eligible Jogger Pant bale goes to Red. When Red reaches its requirements again, it auto-completes and Blue returns to the front.

Turning the company-wide automatic mode OFF prevents **new** automatic assignments, but does not reverse existing assignments or disable manual Priority Scan management. A newly available slot from a valid deletion remains represented in the priority queue.

## Completion eligibility: PER LOADING, not global proforma usage

`getLoadingProformaProgress(snapshot)` (in `proformaCapacityEnforcement.ts`) computes requested, current-order loaded, remaining, and satisfied quantities across **each article** on that loading's linked proforma. Its sibling loadings are ignored.

The same exact per-loading article-demand rule is now shared by:

- `advanceSatisfiedPriorityScanConfigsLockedTx`: a loading auto-completes only when **all of its own required articles** are satisfied.
- `reactivateAutoCompletedPriorityLoadingsLockedTx`: a completed loading reopens only if **it personally** has outstanding required articles.

This prevents the old aggregate/global remaining-quantity check from completing or reactivating the wrong loading when multiple active loadings share a reusable proforma. Overloading one article cannot mask shortage of another.

## Manual overrides and eligibility

Auto-recovery is exclusively for configurations with:

- `enabled = false`;
- `updated_by_name = 'system:auto-completed'` (exact lifecycle marker);
- existing company/order/config association;
- order still in editable `LOADING` status, not deleted and still linked to a proforma;
- at least one outstanding article quantity on **that** proforma/loading.

The system never silently re-enables a **manually disabled/cleared** configuration or a `DRAFT`, `VERIFIED`, `FINALIZED`, cancelled or deleted loading.

Manual disables update the configuration with the real operator identity, replacing the auto-completed lifecycle marker. Clearing a config deletes it. These human decisions are higher priority than automatic recovery. Verification/finalization order rows are rechecked under database locks.

## Stable queue ordering and concurrency

All queue mutations, including stale-loading cleanup and recovery, acquire the same company-scoped Priority Scan advisory lock (namespace `73202`) as manual scanning, mode changes, Stock Entry and allocation. Recovery acquires proforma locks in ascending ID order before loading row locks and queue rewrites.

To handle physical deletion of multiple bales across multiple completed loadings:

- Phase 6's centralized `deletePhysicalFactoryBalesTx` pre-acquires all affected proforma locks.
- It reverses each physical bale's customer link, totals and historical active status but **defers queue recovery** until the full batch has been detached.
- The helper reactivates all eligible previously completed loadings **once** at the front, in their original configuration creation order (oldest first, tie-breaker by loading ID), followed by previously active loadings.
- `/api/factory/customer-orders/:id/bales/empty` likewise recovers once after all links are detached.
- Repeated or competing reactivation attempts are idempotent: the initial queue transaction enables the config; subsequent attempts see it active and perform no reactivation.
- Priority numbers are re-compacted to 1..N under the same lock. No existing bale/customer-order links are migrated to new loadings.

`disableStalePriorityScanConfigs` previously changed active rows outside a queue lock; it now acquires that lock and compacts the queue atomically.

## Color reused during completion

An auto-completed Red loading releases its active color slot, so an operator may legitimately assign that same color to a later loading. Both cannot be active with an identical color (uniqueness boundary).

On automatic recovery:

- Keep the original color if it remains available.
- If its color is taken, choose a distinct, safe palette hex color; when all standard palette colors are occupied, derive a deterministic unused hex color.
- Named legacy colors and their hex equivalents are treated as the **same visual color** for collision checking.
- Update only the **current configuration's** color/color key. Historic bale allocations, previously printed labels and archived Priority Scan events retain the ORIGINAL color forever.
- Future bales use the reopened loading's new current color, clearly visible in the priority configuration UI. The recovery result includes `colorChanged`.

## Files changed in Phase 7

- `server/routes/factory/customer-orders/proformaCapacityEnforcement.ts` — per-loading article-demand progress helper.
- `server/routes/factory/customer-orders/priorityScanQueue.ts` — shared locked deterministic auto-recovery, lifecycle markers, collision-safe colors and per-loading completion.
- `server/routes/factory/customer-orders/priorityAutoAllocation.ts` — shared recovery invocation and optional bulk deferral.
- `server/routes/factory/stock/physicalBaleDeletion.ts` — ordered proforma locks and once-per-batch recovery after all physical deletions.
- `server/routes/factory/customer-orders/bale-scanning/remove.ts` — once-per-emptied-loading recovery.
- `server/routes/factory/customer-orders/priorityScanConfigRoutes.ts` — locked, atomic stale queue cleanup/compaction.
- `client/src/pages/factory/bale-stock-entry/RemoveFromStockTab.tsx`, `client/src/pages/factory/baleshistory/useBalesHistoryModel.tsx`, `client/src/pages/factory/FactoryLocationInventoryModel.tsx` — immediately invalidate queue/loading query caches on physical deletion.
- `tests/setup.ts` — Phase 7 factory test fixture.
- `tests/automatic-priority-queue-recovery-phase7.test.ts` — **authored, not executed** integration regression suite.
- `tests/automatic-priority-loading-progress-phase7.test.ts` — **authored, not executed** pure per-loading capacity regression suite.

## Claude's required checks (deferred)

1. Run TypeScript, Phase 7 tests, Phases 1–6 test suites, Priority Scan Wave 1 regression suite and full CI.
2. Test **Red #1 → Red complete → Blue #1 → Red bale deleted → Red #1, Blue #2**, asserting Blue's previous order-bale link and saved color remain unchanged.
3. Share a single proforma between two customer loadings and verify that only the truly satisfied loading advances.
4. Delete a batch spanning two previously completed loadings, in reversed input order; confirm recovery is deterministic and queue priorities contiguous.
5. Manually disable an auto-completed loading, remove one of its original bales and confirm it does not silently reactivate.
6. Test verified, finalized, cancelled and deleted loadings; none can reopen through deletion.
7. Reuse Red's color after Red completes, then reopen Red. Assert new current color is unique but historic Red labels/history stay Red.
8. Recover with automatic mode OFF: no new automatic bale assignment until enabled; historic snapshots remain unchanged.
9. Test concurrent print/scan/config modification/recovery, manual priority reordering, priority-color uniqueness and proforma lock ordering for deadlocks or stale states.
10. Confirm scanner/Factory Settings/stock removal UIs reflect queue changes and print labels match their saved original allocation colors.
11. Verify retry/idempotence, no double inventory decrements and no reactivation for already satisfied proformas.

**Phase 8 remains**: full system-wide regression verification, rollout controls, draft PR and Claude handoff. Do not enable in production or merge before Claude approves the complete PR.
