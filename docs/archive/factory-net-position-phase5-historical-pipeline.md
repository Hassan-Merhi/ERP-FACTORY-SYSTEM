# Factory Net Position — Phase 5 historical OTW and uninvoiced-order implementation

Branch: `feature/factory-net-position-historical`  
Status: SOURCE IMPLEMENTATION COMMITTED — CI/test execution, DB-level data reconciliation, merge, rebase, and deployment not performed.

## Historical snapshot contract

The report is a *historical-knowledge-as-of* snapshot. An October 21 receipt, bale scan, loading, or verification must never appear on October 19, even when a document date is backdated to October 19. The business date must be on/before the selected date AND the action must have been recorded by that company's local end-of-day cutoff.

The existing live/current Net Position calculations are preserved. Historical snapshots continue to carry `historyCompleteness: "partial"`; the implementation does not manufacture missing older transitions.

## Phase 5 implementation

1. **New date-specific service:** `server/services/factory/netPositionHistoricalPipeline.ts` returns one historical OTW and scanned-order projection under `FactoryNetPositionAsOf`, with a shared timestamp cutoff and warning codes.
2. **OTW eligibility:** the `factory_containers.created_at` date decides when a container can first enter historical OTW, and `deleted_at` excludes it only if deleted by the cutoff. Never exclude October 19 OTW simply because its *current* status is OFFLOADED/RECEIVED.
3. **Partial/full receipts:** source `factory_container_receipts.receipt_date` and `created_at` events. Only receipts recorded and effective by the cutoff subtract from outstanding planned kg. If a second receipt arrives October 21, the October 19/20 OTW balance still includes those unreceived kilograms. `historicalOtwRemaining` calculates the share; receipts exceeding planned quantity are capped and flagged, not represented as a negative asset.
4. **Legacy offload:** for containers with no receipt events, use qualifying `factory_raw_stock.offloaded_at`/created timestamp as provisional cumulative fallback. Explicitly warn this source cannot reconstruct edits/partial receipts precisely; do not infer unobserved movements. Never use current container status as historical offload timestamp.
5. **Historical OTW valuation:** compute outstanding goods as planned kg × goods/kg, using the selected date's confirmed FX settings. Include only the unreceived fraction of freight, commission and other stored charges. Where unit costs are absent, use current final payable provisionally, with a visible warning. Historical revisions of container weight, price, currency, charges and FX attribution lack versioned master records, so the monetary valuation is explicitly **provisional** even if the receipt quantities have dated evidence.
6. **Dated order stages:** derive LOADING, VERIFIED or FINALIZED from actual creation, loading and verified/finalized transitions, not from `customer_orders.status` now. Reopened orders choose the latest qualifying LOADING/verification transition. A finalized order after October 19 remains an eligible earlier VERIFIED/LOADING order if evidence supports that earlier stage. Historic order stages with insufficient dated evidence are excluded with warnings rather than silently counted.
7. **Backdated verification prevention:** `loading_finalized_at` and `verified_at` can be dates chosen by the operator during an action recorded later. The historical query therefore reads `factory_daybook_entries` (`LOADING_SUBMITTED` / `ORDER_VERIFIED`) through its **created_at** and posting date; a stored earlier verification date by itself cannot prove an earlier verification. The optional current `updated_at` fallback is only accepted if its own timestamp was before the cutoff. Older overwritten/deleted daybook entries may prevent a full reconstruction and are warned.
8. **Individual bale scans:** replay `customer_order_bales.scanned_at` and `customer_order_bales_history.scanned_at` for archived scans cancelled **after** the selected day. Count each bale at most once per order, using its recorded per-bale `price_used` and exact scan count. A bale first scanned October 21 contributes zero on October 19 and October 20, even if it belongs to an earlier order.
9. **Restoration and missing timestamps:** archived scans cancelled before cutoff do not remain allocated. If a previously cancelled scan was restored without a separately dated restoration event, flag uncertainty. Scans with NULL `scanned_at` are not silently backdated; they are flagged.
10. **Uninvoiced selling value:** for historical VERIFIED/LOADING, use the sum of qualifying scanned bale amounts, **not the order's current grand total or present-day bale count**. This deliberately excludes unscanned bale commitments and later scans. Current freight/other charge amounts have no timestamped version history in `customer_order_charges`, so they are not copied backward into historic scanned value; this limitation is surfaced. Current `price_used` could have been amended after original scan, and absent version history remains explicitly provisional.
11. **Complete report integration:** `employeeNetPositionRoutes.ts` conditionally loads this date-specific projection when `scope.isHistorical`; supplies its OTW, pending/verified/loading rows and sums into existing top What We Have/Net Position computation and nested account breakdown; the Phase 4 dated Stock in Hand projection continues to exclude qualifying scanned bale allocations under the identical cutoff. Live/current behavior remains unchanged.
12. **Fail-closed and warning behavior:** historical pipeline failures throw `HISTORICAL_NET_POSITION_PIPELINE_FAILED` and the main API returns its existing structured 503 instead of substituting current values. Warning codes for legacy history, altered prices, unsupported verification timestamps and unversioned charges are surfaced as readable entries in the existing expandable UI warnings.

## Invariants and validation handoff

- As-of October 19: containers added October 21 are absent; containers received October 21 still have their earlier outstanding OTW balance.
- As-of October 20: a 10,000kg container with 4,000kg received through October 20 has 6,000kg remaining OTW; after all 10,000kg have been received OTW goes to zero.
- As-of October 19: a verified/loaded invoice's bale scanned October 21 must not appear in October 19 quantity or value.
- Scans cancelled October 21 still count on October 19, unless they were also cancelled earlier.
- The same bale must not appear both as historical available Stock in Hand and as scanned into a live historical order on that day.
- Historical VERIFIED/LOADING top-line asset amounts must equal their source order rows and nested group totals. Pending remains informational, not included in What We Have.
- Orders finalized after the cutoff must not disappear from earlier snapshots because their *current* status is FINALIZED.
- A loading verified on October 21 with manually chosen October 19 finalized date must not show VERIFIED on October 19 without an independently recorded event before that cutoff.
- Legacy unrecorded lifecycle, changed prices/charges, missing scan timestamps, and partial receipt fallback must remain visible **limitations**, not a claim of 100% historic precision.
- Authored `tests/factory-net-position-phase5-pipeline.test.ts` includes pure order status/reopen and OTW partial receipt cases. Tests are **not executed**, per instruction.

## What is explicitly deferred

Phase 6: Fixed assets, prepaid rent, deposits, loans, and worker advances.  
Phase 7: UI historical date and summary/expand reconciliation across all categories.  
Phase 8: inspect actual DB event availability, missing deleted/replaced history and mutable price/charge amendments; decide evidence-backed migrations/backfills, query/index optimization and independent financial reconciliation.  
Phase 9: manual final review and Claude's independent CI/release checks when requested.

No production accounting voucher, container, invoice, bale or stock mutation was performed. No automatic test runs or CI workflow were triggered. No merge, rebase or deployment.
