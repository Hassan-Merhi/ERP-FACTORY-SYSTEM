# Factory Loading Dispatch — Phase 4: Comparison

Branch: `feature/loading-dispatch-verification-20261109`

**Approved model:** Option A (verification only). Comparison is read-only. Existing
customer-order scans, loadings, inventory, journal vouchers, prices and stock
movements are not mutated by any Phase 4 operation.

## Implemented

### Dedicated Compare pages
- Loading-wide: `/factory/sales/loading/dispatch/:orderId/compare`
- One truck: `/factory/sales/loading/dispatch/:orderId/:dispatchId/compare`
- **Compare All** in Dispatch Management header, and **Compare this trip** in
  individual truck detail. A horizontal selector switches between the overall
  order and every truck without navigating away from Dispatch Management.
- Both views automatically refresh every five seconds (read-only polling).

### Server API
- `GET /api/factory/customer-orders/:id/loading-dispatches/comparison`
- `GET /api/factory/customer-orders/:id/loading-dispatches/:dispatchId/comparison`

Both endpoints require existing Factory Invoicing/Loadings authorization, use
active-company scoped lookups, and return a transactionally consistent
`REPEATABLE READ, READ ONLY` snapshot. They use the same backend pure
comparator, `loadingDispatchComparison.ts`, with no writes or hidden stock
side effects.

### Overall loading comparison
- **Expected** = each unique bale currently in the selected loading
  (`customer_order_bales`). **Verified** = unique active physical verification
  scans across all truck trips for that order.
- Missing loaded bale references are listed individually, including article
  code, product name and KG, with searchable/paginated article totals.
- Previously scanned bale references removed from the main loading are marked
  as unexpected; they're retained in permanent physical verification history.
- Article summary shows expected/scanned/matched/missing/extra counts and KG,
  plus total progress and weight difference. Duplicate active scan anomalies
  are surfaced separately instead of double-counted.

### Per-trip comparison
- If a trip has explicit expected article quantities and/or exact bale
  assignments, show item-by-item expected vs scanned, exact missing
  references where available, unexpected/off-plan scans, cross-trip barcode
  misplacements and weights.
- Correct totals do not conceal wrong exact bale IDs: exact-bale plan misses
  and off-plan scans appear even when article quantities match.
- **No artificial per-trip expectations.** Until an actual allocation exists,
  the trip view shows verified barcodes and article totals, with expected and
  missing quantities displayed as **unknown**, not zero. The overall order
  view still identifies every physically unverified loaded bale.
- Phase 5 will populate priority-driven per-trip article / exact-bale
  allocations. Phase 4 consumes those records already reserved in Phase 1,
  without overriding or guessing them.

### UX
- Status filters (All, Missing, Extra, Match, No target).
- Search by article/name; progressive pagination for large article tables.
- Exact barcode discrepancy panels with progressive pagination, linked
  source-truck/operator information and cross-trip allocation diagnostics.
- Accessible explicit refresh, 5-second background polling, mobile table
  scrolling, dark/light styling.

## What remains for later phases
- Automatic priority assignment and coordination: Phase 5.
- Close/reopen/end dispatch and supervisor discrepancy approval: Phase 6.
- Print/Excel/PDF export and production rollout/CI: Phase 7.

## Tests added but intentionally NOT run
`tests/factory-loading-dispatch-comparison.test.ts` contains deferred
regression cases for order-wide missing exact references, deleted-after-scan
bales, unplanned trips, wrong exact-bale scans with equal item counts, cross
trip misplacements, article-only targets, off-plan articles, and anomalous
active duplicates.

**No CI checks, test runner, merge to main, or Render deployment were run.**
Manual QA and CI remain pending by user request.
