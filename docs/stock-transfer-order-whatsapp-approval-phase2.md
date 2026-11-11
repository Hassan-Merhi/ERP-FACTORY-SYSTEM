# Stock Transfer Order WhatsApp approval — Phase 2

## Delivered on the Phase 1/2 branch

The existing **Stock Transfer Order → Export → Send to WhatsApp (without Cost)** dialog now has a **Request Approval** tab, without removing or modifying the original manual workbook-sending controls. It lists saved, pending, unreserved Stock Transfer Orders for one destination, with multi-selection and a count of pending revisions. The selected orders' revisions from *every source location* are included.

The new approval settings are in **Settings → Export Center → Stock Transfer Order — WhatsApp Approval**, under the existing transfer export group management. Admin/Owner/Developer configures the approval group from the company's existing linked WhatsApp groups, the single authorized E.164 phone number, and a WhatsApp group or phone recipient for each receiving destination. The feature is **disabled by default**. Admin/Owner/Developer/Manager may submit requests.

### New endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/stock-transfer-order/wa-approval/settings` | Current-company settings, groups, destinations and role |
| PUT | `/api/stock-transfer-order/wa-approval/settings` | Save group, authorized number, enabled flag |
| PUT | `/api/stock-transfer-order/wa-approval/destinations/:destinationId` | Link destination WhatsApp recipient |
| GET | `/api/stock-transfer-order/wa-approval/eligible` | Only persisted pending order-origin vouchers |
| GET | `/api/stock-transfer-order/wa-approval/legacy` | Explicitly identifiable historical order candidates (admins only) |
| POST | `/api/stock-transfer-order/wa-approval/enroll-legacy` | Admin-confirmed one-time historical order classification |
| GET | `/api/stock-transfer-order/wa-approval/recent` | Recent request statuses |
| POST | `/api/stock-transfer-order/wa-approval/requests` | Freeze a batch and send one approval-group message |
| POST | `/api/stock-transfer-order/wa-approval/requests/:batchId/cancel` | Admin cancellation and reservation release |

**Security:** New Stock Transfer Order creation goes through `POST /api/stock-transfer-orders`. The server sets `workflow_origin='stock_transfer_order'` only on that route, and rejects all client-supplied origin markers. Regular stock transfers retain `POST /api/stock-transfers` with default origin `stock_transfer`. Inventory module authorization guards both routes, while the new WhatsApp approval routes have a dedicated inventory mount. Retail mode still rejects manual Stock Transfer Order creation. The old manual export endpoint is unaffected by the new mount.

Existing historical vouchers are **not** automatically backfilled based on mutable descriptions. Administrators may explicitly enroll older clearly labelled order-view vouchers after verifying their identity. This changes the workflow-origin metadata only; no stock, prices, balances, voucher entries, or prior revisions are modified.

### Message and delivery handling

1. Check the main WhatsApp connection and that the configured approval group is visible.
2. Create a Phase 1 immutable snapshot of the **exact selected orders**, every current pending revision, and existing line fingerprints.
3. Revalidate the snapshot and build one summary (source locations, order numbers, revision numbers and net quantity changes; never costs).
4. Send one text message with the exact main Green API instance and store its returned `idMessage` and instance/group in the batch. These values will be used to correlate a directly quoted `DONE` in Phase 3.
5. If the provider definitively rejects the send, cancel the unsent batch and release its reservation. For network timeouts, missing message IDs or post-send database errors, **do not automatically retry**: keep the batch reserved for administrator review.

The request message explicitly states that `DONE` replies will not be processed until Phase 3. Phase 2 has **no incoming WhatsApp listener, approval execution, stock posting or final Excel sending**.

### Verification and rollout

- New `tests/stock-transfer-order-wa-phase2-contract.test.ts` checks source contracts and permission boundaries.
- `config/route-manifest.json` records 10 additional routes (one dedicated order-create path, nine approval paths) and two inventory module mounts.
- The Phase 1 schema remains idempotent, with startup registration required before any order-origin inserts.
- Source-level static consistency checks were run through the GitHub connector, but **a full TypeScript/Vitest/PostgreSQL integration run has not been performed**.
- Nothing has been merged into main or deployed to Render; enabling this feature on a deployed environment requires deployment, configured WhatsApp credentials/groups, and Phase 1 tables.

## Next phases

- **Phase 3:** authenticated Green API inbound webhook; exactly matched authorized number, group, instance and quoted message ID; `DONE` and `DECLINE` parsing and replay guards.
- **Phase 4:** atomic all-at-once approval of every frozen pending revision across all selected orders. Reject stale or changed batches.
- **Phase 5:** send the consolidated, approved **Excel without cost** to both approval-group and destination-linked WhatsApp, with persisted independent delivery outcomes.
- **Phases 6–7:** audit/retries and production end-to-end testing/rollout.
