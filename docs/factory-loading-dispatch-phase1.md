# Factory Loading Dispatch — Phase 1 (Verification Only)

Branch: `feature/loading-dispatch-verification-20261109`

## Approved scope

Option A is strictly read-only with respect to the existing loading and stock.
A dispatch is an independent **physical truck verification** against a single
Factory customer loading order, not the existing `dispatch-batches` invoicing
workflow. It must never add/remove `customer_order_bales`, move `factory_bales`,
generate journals, or post invoices.

## Phase 1 delivered

- Order-linked dispatch trips with consecutive per-order numbers. Unlimited
  trips are allowed, including multiple `OPEN` records at the same time.
- Each record stores its active-company ID and the immutable order ID, plus a
  snapshot of the container number, operator, truck details and timestamps.
- Company/order-scoped SQL foreign keys for trips and all child records.
- `factory_loading_dispatch_expected_articles`: product/priority quantities.
- `factory_loading_dispatch_expected_bales`: specific anticipated bale refs.
- `factory_loading_dispatch_scans`: physical scan evidence with weight and
  product snapshots. Database partial unique index prevents the same active
  bale appearing twice across trips of the same loading.
- `factory_loading_dispatch_events`: audit event history (Phase 1 emits
  `CREATED`; future phases will record every scan/correction/finalization).
- Schema is ensured during regular server startup. No manual SQL required.
- API is guarded by existing Factory Invoicing/Loadings page+tab permissions;
  `View Only` and `Create Only` cannot create dispatch trips. All API lookups
  use the active company and the selected loading order.

## Phase 1 API

- `GET /api/factory/customer-orders/:id/loading-dispatches`
  Lists trips, counts and weights for one loading.
- `POST /api/factory/customer-orders/:id/loading-dispatches`
  Creates one `OPEN` trip; optional `truckPlate`, `driverName`,
  `destination`, and `notes` text fields. The source order must be active.
  The order row is locked for sequential trip numbering.
- `GET /api/factory/customer-orders/:id/loading-dispatches/:dispatchId`
  Returns one company/order-scoped dispatch.

Deletion/archiving of a loading does not delete historical trip rows, and trip
reads remain possible by authenticated users with the appropriate access.

## Deferred by design

Phase 2 adds the Dispatch button and dashboard, active trip UI and metadata
editing. Phase 3 implements physical scan-only operations (including mobile
scanner, duplicates and audit). Phase 4 adds per-trip and cross-trip comparison.
Phase 5 extends allocation coordination. Phase 6 adds close/reopen controls.
Phase 7 adds reports, exports and automated testing.

CI was **not run**, as requested. These commits have not been merged into
`main` or deployed. Before releasing, run type-checks, migration checks,
API authorization and concurrent creation/scan tests.
