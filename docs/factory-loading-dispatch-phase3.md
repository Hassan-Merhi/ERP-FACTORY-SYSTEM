# Factory Loading Dispatch — Phase 3: Barcode verification

Branch: `feature/loading-dispatch-verification-20261109`

## Delivered

### Server

The Phase 3 module `server/routes/factory/customer-orders/loadingDispatchScanRoutes.ts`
is registered before the generic customer-order handlers.

- `GET /api/factory/customer-orders/:id/loading-dispatches/:dispatchId/scans`
  returns all historical scan records for one trip, including removed/corrected
  records, operator/time, article, barcode and weight snapshots, and whether
  the bale is still assigned to the main loading.
- `POST /api/factory/customer-orders/:id/loading-dispatches/:dispatchId/scans`
  accepts `{ "scanCode": "..." }`. Only a unique, exact reference / factory
  bale code belonging to the selected loading can be verified. Article name
  or article-code quantity guesses are not accepted as physical bale evidence.
- `POST /api/factory/customer-orders/:id/loading-dispatches/:dispatchId/scans/:scanId/remove`
  accepts `{ "reason": "..." }`, soft-removes an active scan and appends an
  audit event. Restricted to Admin, Owner and Developer, on an OPEN trip.

All endpoints use authenticated, company-specific Factory Invoicing → Loadings
page/tab access. View Only and Create Only users cannot create scan records.
Only OPEN dispatches accept new scans or corrections. Cancelled/deleted
source loadings are blocked; verified/finalized orders can still be physically
verified if their individual loaded bale records remain available.

### Concurrency and integrity

- Exact barcode resolution against `customer_order_bales` linked to
  `factory_bales` in the active company.
- Only `factory_loading_dispatch_scans` and append-only dispatch events are
  written. Loading, inventory, pricing, sales and ledger records are unchanged.
- Each trip scan is serialized by locking its dispatch row.
- The Phase 1 database partial unique index prevents an active bale from being
  counted twice in separate concurrent trips for the same loading.
- `ON CONFLICT DO NOTHING` makes the losing concurrent scan return a clear
  duplicate result without aborting its transaction.
- Duplicate errors include previous dispatch number, scanner and timestamp.
- Correction reasons and original scanned-by/time remain permanently stored,
  with `BALE_SCAN_REMOVED` events. Removing an active verification frees the
  unique slot for another truck, but does not erase audit history.

### UI

`FactoryLoadingDispatchScanner.tsx` is mounted on the existing dispatch
detail page. It supports:

- manual input and USB barcode scanner (Enter-to-submit), plus mobile camera;
- continuous scanning without closing the camera (shared decoder component);
- sequential bounded scan queue for scanners faster than a network response;
- green verified, red duplicate/error, amber wrong-container/ambiguous warnings;
- a duplicate red message showing who scanned the bale on which dispatch;
- only server-confirmed quantities/weights; background refresh every 5 seconds;
- recorded refs, articles, products, weights, operator/time, search and paging;
- warning for a previously scanned bale later removed from main loading;
- supervisor correction with required reason and preserved history;
- dark/light mode, mobile layout and no scan/delete controls on closed trips.

## Explicitly deferred

The *expected vs actual* article/individual-bale comparison is Phase 4,
cross-trip allocation/priority coordination is Phase 5 and *End Dispatch* /
supervisor reopening is Phase 6. Scan-only verification is independent of
these future features.

## QA scenarios to run later (CI deliberately not run)

1. Scan two valid loaded bales to trip 1. Confirm quantities, weight and operator.
2. Duplicate-scan either bale on same trip and trip 2. Expect red 409 with
   original trip and scanner; active count must not increase.
3. Simulate concurrent scans for the same bale on two trips; the unique index
   must allow exactly one active verification.
4. Scan an article code or another loading's barcode; expect amber 422, with
   zero stock/loading changes.
5. Add more than one barcode rapidly using USB and camera; each queued code
   should be verified once, with clear feedback.
6. Correct a scan as Admin with reason; check permanent historical row/event,
   then rescan to a different open trip.
7. Verify View Only/Create Only and other companies cannot POST or correct.
8. Confirm closed/cancelled dispatches reject new scans/corrections.
9. Observe 5-second refresh across open tabs, dark/light/mobile layouts,
   and no vouchers/inventory or main-loading modifications.

No CI commands, merge to main, or Render deployment were performed.
