# Factory Net Position — Phase 4: Historical Raw Materials, Bales and Balance on Table

Branch: `feature/factory-net-position-historical`  
Status: SOURCE IMPLEMENTATION COMMITTED; never described as production-verified. No CI, test execution, merge, deployment or production writes.

## Contract and scope

A 2026-10-19 factory snapshot may use only records that both *financially/operationally belong on or before October 19* and were *actually recorded by the end of October 19 in the selected company's timezone*. A receipt/mix source/bale first created on October 20/21 must not leak into October 19 even when its effective date was backdated. Reconstruct from the beginning of available history through the selected date, not by reversing the CURRENT quantity or CURRENT value.

Phase 4 covers Raw Materials, Stock in Hand and Balance on Table. Factory Stock OTW and Uninvoiced Orders remain Phase 5. Property/assets/deposits/loans and worker advances remain Phase 6. Data backfill, ambiguous audit history and full reconciliation belong to Phase 8.

## Changes and source mapping

1. **New dated inventory projection:** `server/services/factory/netPositionHistoricalInventory.ts` exports `computeHistoricalFactoryInventory(companyId, scope, valuationMode)`.
2. **Receipt-based raw stock:** prefer immutable `factory_container_receipts` rows (each receipt's received kg, business date, actual creation time and stored USD unit cost). Containers/receipts created later are excluded; a row deleted later remains visible on the earlier date.
3. **Legacy fallback:** when a container has no receipt history, use `factory_raw_stock` received kg and offload/created timestamp only if it was already recorded by that date. Emit `HISTORICAL_RAW_LEGACY_RECEIPT_FALLBACK`; the cumulative row may have been overwritten by adjustments, so exact earlier balances cannot be guaranteed. Do not mistake current `used_kg` for its historical value.
4. **Date mix events individually:** `factory_mix_batch_sources` joined with batches, source created timestamp, batch created timestamp and batch effective date; only material-owning sources (not BATCH-to-BATCH transfer) consume raw stock. Prefer explicit inventory_supplier_id, then supplier or container supplier; flag unresolved owner.
5. **Manual additions/deductions:** `factory_raw_material_adjustments` dated by both event date and created time; respect soft-deletion timestamp. Quantity-only ADD preserves blended stock rate; valued ADD contributes recorded unit value; consumption/removal draws down at the chronological blended rate. Emit warning for missing adjustment valuation basis or unknown unit FX.
6. **Decimal event replay:** `replayHistoricalRawEvents` sorts per effective day, then recorded timestamp and stable id, calculates value from event movements and rounds per supplier/material bucket (not one binary-float total). Flags negative movements and consumed quantity that exceeds known receipts. The replay uses data recorded at the time, never current supplier locked rate or present-day raw-stock remaining balance.
7. **Historical Stock in Hand:** load `factory_bales` only if bale creation and stock entry/pressing occurred by cutoff. Sum recorded bale total_cost rather than today's product production price. Exclude bales finalized on/before cutoff, include those finalized later where finalization timestamp exists. Honor soft deletions relative to cutoff, and exclude scans that were already present; a scan on Oct 21 will not remove a bale from Oct 19. Include cancelled scans from `customer_order_bales_history` if cancellation happened after cutoff. Distinguish NULL legacy scan dates and missing finalization timestamps as warnings.
8. **Valuation toggle:** cost is a stored bale cost. Selling mode uses catalogue selling prices because there is no authoritative per-date product price history for unsold bales; explicitly emit `HISTORICAL_STOCK_SELLING_PRICE_UNVERSIONED` rather than falsely calling it exact. Cost history may also have later mutable cost cascades; emit `HISTORICAL_STOCK_COST_EDITS_NOT_VERSIONED`.
9. **Balance on Table:** `getFactoryBalanceOnTableSnapshot` now takes optional `FactoryNetPositionAsOf`. Only the historical Net Position passes it; existing Production Overview and current-day consumers keep their previous signature/math. Historical mix batches and baled weights respect company date, record time and soft deletions. Rate remains the original cumulative ten-decimal batch-rate algorithm. Unversioned REMOVED/REPACKED status transitions can remain ambiguous until Phase 8.
10. **Main report integration:** `netPositionHistoricalCorrection.ts` no longer subtracts future receipts/consumption from today's mutable raw-material value. It awaits the historical inventory projection, updates INVENTORY, RAW_MATERIAL, BALANCE_ON_TABLE account rows and supplemental fields, recomputes asset category breakdown and main What We Have/Net Position totals; errors fail closed instead of returning current figures as historical.
11. **Warnings:** the historical response includes machine-readable `inventoryHistoryWarnings` and incorporates them into `historyWarnings`. `historyCompleteness` remains `partial` until relevant historical gaps are resolved; do not claim strict period-end accuracy for missing legacy event history.

## Important behavior boundaries

- **No vouchers** or source-quantity updates are created by any date selection.
- Today's view still uses the existing `computeNetPositionInventory`; the read-only historical projection only runs for earlier dates.
- No standalone historical snapshot may use unbounded CURRENT `factory_raw_stock.used_kg`, current product production_price, or current supplier locked USD rate as proof of past values.
- An archival cancellation does not rewrite the original scan date.
- Historical raw-material supply and quantity may differ from current Raw Materials page until Phase 8 verifies legacy event coverage; the discrepancy must not be hidden.
- Past bale price histories, deleted/recreated or edited rows without version logs, source ownership gaps, duplicate/faulty legacy receipts and status transitions without timestamps are not recoverable solely from this implementation. Phase 8 must quantify those cases and add evidence-backed backfill/audit models before setting snapshot completeness to `complete`.
- Factory Stock OTW and Uninvoiced Orders still need chronological transitions in Phase 5, particularly the risk of an allocated bale appearing in two categories.

## Deferred acceptance tests for Claude (not run here)

- Oct 19: one 100 kg @ $2 raw receipt; Oct 20: mix consumes 25 kg; Oct 21: 40 kg @ $3 receipt and 10 kg manual valued ADD. Historic raw = $200 / $150 / $280 by end of Oct 19 / 20 / 21 under chronological weighted costs.
- Oct 21-created mix with Oct 19 effective date does NOT alter Oct 19.
- Receipt posted Oct 21 with Oct 19 receipt_date does NOT appear on Oct 19.
- Partial offloads create separately dated receipts; a second receipt on Oct 21 must not increase Oct 19 Raw Materials.
- A bale stock-entered Oct 21 must not appear in Stock in Hand on Oct 19.
- A bale scanned Oct 21 stays in Oct 19 unallocated inventory; an Oct 19 scan cancelled Oct 21 remains excluded on Oct 19.
- Later-deleted bale and raw material remains visible for earlier date where deletion history proves it.
- Raw Material rounding: 10kg @ .35 minus 3.3 kg at .35 = 2.35 (Decimal half-up), and two separate 1.005 USD rows = 2.02.
- Balance on Table historical batch selection and ten-decimal rate; flag unknown repack/removal timestamps.
- Verify cost/selling and nested asset lines/total invariants against independently documented transactions.
- Ensure no CI/workflows, tests, deployment or main-branch merge occurs during implementation.

## Phase 5 handoff

Preserve `FactoryNetPositionAsOf` and the period-end inventory projection. Add historical order lifecycle/status and scan state to the same cutoff, dated OTW container state and partial receipt balances; verify no double-count between dated Stock in Hand, in-progress orders and OTW.
