# Factory Loading Dispatch — Phase 2 implementation

**Branch:** `feature/loading-dispatch-verification-20261109`

## Done

1. The Scanned Bales header now includes a small **Dispatch** button for a loading order.
2. The button navigates to a dedicated workspace for that **specific order**:
   `/factory/sales/loading/dispatch/:orderId`. A unique, bookmarkable detail
   URL is available at `/factory/sales/loading/dispatch/:orderId/:dispatchId`.
3. The dashboard shows the order's main loaded bale count/weight alongside
   independent dispatch-verification count/weight, remaining unverified bales,
   percentage, and open trip count. It refreshes every 15 seconds.
4. Trips have permanent per-order numbers. Multiple trips can be OPEN in parallel.
   Users can filter All / Open / Finished, open a trip, and return to the parent loading.
5. **New Dispatch** creates a record using the Phase 1 API. Truck plate,
   driver, destination and notes are optional; errors show a toast.
6. **Edit details** can change those four fields on an OPEN trip.
   The backend validates permitted fields and logs a DETAILS_UPDATED audit event.
7. Factory routing and direct-route tab restrictions inherit the existing
   Invoicing → Loadings permissions. View Only and Create Only cannot create
   or edit dispatch trips.
8. The new UI follows the Factory dark/light layouts and works on narrow screens.

## API added in Phase 2

`PATCH /api/factory/customer-orders/:id/loading-dispatches/:dispatchId`

Only supplied truckPlate, driverName, destination and notes may change. Rejected
when the dispatch is not OPEN, the loading or trip does not belong to the active
company, or the user has insufficient access. The transaction locks the trip row
and writes an audit event atomically with the metadata update.

## Option A remains invariant

Dispatch verifies what entered trucks without modifying:
- customer_order_bales
- factory_bales and stock journals
- proforma capacity
- invoice state or accounting vouchers

This phase deliberately DOES NOT implement barcode scanning, priority
allocation, per-item comparison, or closing/reopening. Their dedicated phases
remain 3/5, 4, and 6 respectively. The trip page calls them out as not yet
available, rather than offering buttons which would seem to work.

## Checkpoints for future CI / manual review

- Authenticated, company-scoped routing including hidden Loadings tab.
- Create two simultaneous OPEN dispatches for one order; confirm numbering.
- Confirm other companies/orders cannot read or PATCH a trip.
- Verify View Only and Create Only cannot create/edit.
- Confirm PATCH on CLOSED/CANCELLED returns 409; changes recorded in event log.
- Verify live loaded count is read from loading and dispatch count is independent.
- Confirm no stock/voucher writes across all Phase 2 API actions.
- Navigate dashboard -> trip -> dashboard -> original loading in both modes.

**No CI, test jobs, merge, or Render deployment was run for this phase.**
