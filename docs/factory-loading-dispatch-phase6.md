# Factory Loading Dispatch — Phase 6: End Dispatch and audit controls

Branch: `feature/loading-dispatch-verification-20261109`

## Verification-only invariant

Phase 6 ONLY updates `factory_loading_dispatches`, inserts closure history
and writes append-only dispatch audit events. It never changes main loading
scans (`customer_order_bales`), Factory stock, proformas, invoices, sale
movements, payments or accounting journals. Each truck remains independent
and closing one does not close the parent container/loading or another trip.

## Shipped server endpoints

- `GET /api/factory/customer-orders/:id/loading-dispatches/:dispatchId/close-preview`
  returns current trip comparison summary, discrepancy checks, a
  tamper-resistant review fingerprint and clean/approval eligibility.
- `POST /api/factory/customer-orders/:id/loading-dispatches/:dispatchId/close`
  requires `{ confirm: true, fingerprint: "<64-character SHA-256>",
  discrepancyReason?: "..." }`. It atomically locks the parent order and
  the trip (same order as Phase 3 scanning and Phase 5 planning),
  recalculates the same comparator used by the live Compare page,
  refuses a changed/stale review (`409 REVIEW_CHANGED`), checks the
  user's role, closes the trip and inserts numbered immutable closure
  evidence plus a `DISPATCH_CLOSED` audit event.
- `POST /api/factory/customer-orders/:id/loading-dispatches/:dispatchId/reopen`
  requires a supervisor role and a 10–1,000-character reason. Only a
  `CLOSED` trip under an active loading can be reopened. The past closure
  gets reopen metadata without ever changing its original signed snapshot,
  and `DISPATCH_REOPENED` is logged.
- `GET /api/factory/customer-orders/:id/loading-dispatches/:dispatchId/lifecycle`
  returns the trip, all closure revisions and up to 100 recent audit events.
- `GET /api/factory/customer-orders/:id/loading-dispatches/:dispatchId/lifecycle/closures/:closureId`
  retrieves the exact immutable comparison/issue/summary snapshot from
  a historical closure revision, scoped to company, order and dispatch.

All endpoints require authenticated Factory Invoicing → Loadings access
and company/order/dispatch scoping. View Only and Create Only roles cannot
end a trip. A user with write access may end a fully reconciled trip.
Only **Admin / Owner / Developer** may approve discrepancies or reopen.

## Closure policy

A trip must have at least one server-confirmed physical bale scan to end
(never allow an empty trip through a supervisor override).

**Clean close:** A saved expected truck plan exists, no missing or unexpected
scans, no allocated-to-another-truck mismatch, no duplicate anomalies, and
expected-vs-scanned KG agrees when exact expected weights are available.

**Discrepancy close:** If a plan was never saved, a planned item is missing,
a scan is unexpected, a bale is on the wrong truck, or weight does not
reconcile, the trip requires Admin/Owner/Developer approval with an explicit
10–1,000-character written reason. It is not silently marked clean.

**Stale review rejection:** The preview fingerprint is recomputed within the
closure transaction. It includes the selected trip's scan evidence, expected
quantities and exact refs, its relevant loaded-bale rows and conflicting
assignments/verification on other trucks. Unrelated scanning on a different
trip does not invalidate a close review. Any relevant change requires
refresh/review before the server accepts finalization.

**After close:** Existing scan, correction, allocation and trip detail
write endpoints already restrict updates to status `OPEN`. Closing locks
the trip only; read-only scanner and Compare remain visible. Reopen enables
editing/scanning again while retaining the previous closure revision.

## Database migration

The boot-time schema ensure now creates
`factory_loading_dispatch_closure_history` with:
- unique `(dispatch_id, revision)`, company/order/dispatch foreign key;
- immutable-at-close reconciliation snapshot and SHA-256 fingerprint;
- discrepancy checks, approval flag, supervisor reason;
- who/when closed and who/when reopened, with a mandatory reason.

No manual SQL is required when the server is deployed and runs its
startup migration.

## Phase 6 interface

A **Dispatch finalization** card in the individual truck detail provides:
- **End Dispatch** with expected/verified/missing/unexpected KPIs;
- explicit review checkbox and current discrepancy details;
- **Review barcode differences** link to the Phase 4 Compare page;
- supervisor reason if discrepancies remain;
- post-close **Completed / locked** status and recorded operator/date;
- **Reopen Dispatch** for Admin/Owner/Developer with mandatory reason;
- expandable **Closure & audit history**, each historical revision linked
  to its frozen article/bale comparison.

The UI follows mobile, desktop, light and dark Factory layouts. Existing
main loading and other truck pages are unaffected.

## QA handoff (deliberately not executed)

`tests/factory-loading-dispatch-close-policy.test.ts` includes staged
regressions for clean closure, missing bales, unplanned truck, empty trip,
cross-trip mismatch, weight difference and off-plan scans. Phase 4/5
comparison tests remain staged.

When authorized to run checks, verify:
1. Close a fully matched planned trip: status CLOSED, unchanged main loading,
   locked scanner, locked allocation editor and metadata.
2. Close missing/off-plan/weight-different trip as worker: 403; as supervisor
   with a 10+ character reason: closure and saved discrepancies.
3. Submit stale fingerprint after scanning, reallocating or correcting an
   affecting bale: 409 REVIEW_CHANGED; refresh then retry.
4. Scan concurrently from unrelated trip: closing this trip remains possible.
5. Close twice concurrently: at most one revision; second receives 409.
6. Reopen with/without supervisor role and reason; verify audit and previous
   revision, then close again as revision 2.
7. Read closure history after main loading changes: original saved comparison
   remains unchanged.
8. Reject cross-company/order IDs, deleted/cancelled orders and unauthorized
   access; verify no stock, financial or main loading writes.

**As requested, no CI jobs, tests, build, merge or Render deployment were run.**

## Next

Phase 7 will add printable trip manifests, spreadsheet exports and the
overall dispatch closing report, plus release checks/deployment when approved.
