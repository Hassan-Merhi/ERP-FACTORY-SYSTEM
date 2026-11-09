# Factory Loading Dispatch — Phase 5: Priority allocation and cross-trip coordination

**Branch:** `feature/loading-dispatch-verification-20261109`

## Approved invariant

Option A remains **physical verification only**. Expected truck allocations and
physical truck scans must never edit `customer_order_bales`, `factory_bales`,
stock valuation, shipment/invoice status, proformas or accounting vouchers.

## Existing Priority Scan semantics

The ERP stores a Priority Scan queue number/color for each **loading order**
(`customer_order_priority_scan_configs`), not a per-article priority value.
Phase 5 displays the original loading queue priority/color (when present)
without fabricating article priorities. It lists article products in linked
proforma-line order, with loading-line order as fallback, and reserves
existing **loaded** bale references accordingly.

## Delivered API

- `GET /api/factory/customer-orders/:id/loading-dispatches/:dispatchId/allocations`
  returns source loading status, queue priority, loaded quantities and KG by
  article, other trips' reserved/scanned capacity, exact-bale candidates
  (including already assigned/scanned flags), the selected trip's saved
  quantity targets and active exact reservations.
- `PUT /api/factory/customer-orders/:id/loading-dispatches/:dispatchId/allocations`
  accepts `{ lines: [{ articleCode, expectedQty }], baleIds: [123, ...],
  autoAssignBales: true }`. Article targets must be nonnegative whole counts.
  Explicit selected IDs must actually be loaded in the **same** order. With
  `autoAssignBales: true`, the server preserves the manually selected IDs and
  actual scans in the trip, then fills remaining quota by loaded/proforma
  order. With false, only selected/scanned IDs receive exact assignments; the
  balance remains an article-only expected target.

The API validates the entire plan within one transaction, locks the common
loading-order row **before** the trip row, and refuses writes unless the trip
is OPEN and loading is not cancelled/deleted. Only Admin, Owner and Developer
may write. Factory Loadings authorization and active company/order scoping
apply to all reads and writes.

### Concurrency & integrity

- Allocation target for each article cannot exceed loaded capacity after other
  trips' reserved quantities and verified bales.
- Capacity is based on the maximum of each other trip's expected article
  quantity and the union of its actively reserved/scanned **unique** bale IDs;
  it does not double count a scan of an already reserved bale.
- A specific bale can have only one active trip allocation (DB partial
  unique index from Phase 1). An already scanned/assigned bale on a different
  truck cannot be reserved by this trip.
- Replacing a plan soft-removes old exact references rather than destroying
  assignment history. The `TRIP_ALLOCATION_UPDATED` audit event includes the
  target lines, exact IDs, added/removed IDs, actor and loading priority.
- Existing physical scan records cannot be erased by allocation changes.
  The plan must retain targets for the trip's already scanned articles.
- Physical scanning and correction now acquire the same loading order lock
  before the dispatch row lock, to serialize with plan edits.
- When a bale is physically scanned on a truck **other than the one it was
  assigned to**, the physical evidence is saved with a conspicuous amber
  review warning and a `WRONG_TRIP_BALE_VERIFIED` audit event. It is not
  silently claimed as a match. Both the truck and overall Compare screen
  flag this misplacement.

### Interface

The **Expected Truck Load** editor appears above the scanner on an individual
trip page. It shows queue priority and color, per-article loaded/other-trip
reserved/available/verified quantities, editable truck targets, and current
exact reserved references. Users can:

- enter per-article expected quantities, including zero;
- choose individual references from a searchable, paginated loaded-bale list;
- enable auto-pick to allocate remaining exact bale references;
- click **Rebalance refs** to rebuild unscanned exact allocations when targets
  shrink, while preserving physically verified references;
- save atomically and immediately refresh Compare data;
- read the current plans as non-supervisor or after the trip closes.

Unsaved changes remain in the editor during its 15-second background refresh,
and client-side checks help prevent overbooking before server validation.
The server remains the authority for simultaneous devices/operators.

## Comparison integration

The Phase 4 comparator consumes saved article targets and exact IDs:
- planned quantity vs physically scanned quantity per article;
- exact missing barcodes, wrong assigned truck, off-plan scans;
- expected KG and KG variance only when **all** expected article quantities
  are covered by exact reserved bale weights; otherwise KG expectation is
  intentionally unknown (no invented weight);
- loading-wide Compare All now includes wrong-truck discrepancies.

## Deferred QA / CI

No CI, test runner, build, merge or deployment was triggered for this phase.

The user's later CI/manual checks should cover: create parallel trucks, reserve
overlapping article targets, concurrent saves, duplicate exact references,
a conflicting physical scan during reallocation, plan shrink/rebalance,
a cancelled/closed trip, another company's order, View Only/Create Only/worker
role restrictions, manual vs auto exact selection, removed loaded bale,
wrong-trip scanner warning and audit event, and Compare KG after full/partial
exact allocation. Regression scenarios for comparison were added to
`tests/factory-loading-dispatch-comparison.test.ts` but not executed.

## What remains

- **Phase 6:** End Dispatch, discrepancy gate, supervisor approval/reopen.
- **Phase 7:** Printable manifest, Excel/export, deployment verification and CI
  when the user authorizes it.
