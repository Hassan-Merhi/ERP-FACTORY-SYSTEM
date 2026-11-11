# Stock Transfer Order → WhatsApp approval — Phase 1

## Scope

**Stock Transfer Order only.** This is not the POS "Stock Transfer" form and not
Factory Dispatch. Existing revision approve/reject routes, voucher posting,
inventory accounting, and manual "Send With/Without Cost" remain unchanged.

The operator will eventually select exact persisted orders from the existing
Stock Transfer Order **Send to WhatsApp** surface (Phase 2). The resulting
one-message request will list *every* pending location revision for those
orders. A verified reply from one authorized phone will approve the entire
frozen batch atomically (Phases 3–4), then send the approved no-cost Excel to
the approval group and destination recipient (Phase 5).

## Phase 1 storage and migration

- `stock_transfer_vouchers.workflow_origin`: defaults to `stock_transfer`.
  The dedicated new-order editor explicitly writes
  `stock_transfer_order`. No historical vouchers are backfilled based only on
  their editable description; existing historical Stock Transfer Orders need a
  separately reviewed enrollment path in Phase 2 if they must be included.
- `stock_transfer_order_approval_settings`: one disabled-by-default approval
  configuration and authorized E.164 phone per company.
- `stock_transfer_order_destination_recipients`: one enabled WhatsApp recipient
  (person or group) per company and destination.
- `stock_transfer_order_approval_batches`: one internal batch key, frozen
  destination, approval group and authorized phone, plus request-message ID and
  lifecycle timestamps.
- `stock_transfer_order_approval_batch_items`: exact transfer voucher IDs,
  display numbers, and SHA-256 snapshots of stock-transfer item IDs, locations,
  quantities, rates, amounts, and row IDs.
- `stock_transfer_order_approval_batch_revisions`: exact pending revision IDs,
  revision numbers, and immutable revision payload hashes.
- `stock_transfer_order_approval_events`: append-only intended audit/event
  facts, with WhatsApp message de-duplication key.
- `stock_transfer_order_approval_deliveries`: future independently tracked
  group and destination delivery states, including ambiguous Green API sends
  and claim/retry data.

A partial unique index allows only one reserved approval batch per transfer.
Company-scoped composite foreign keys prevent children from referencing another
tenant's batch. New tables have company-scoped read/write RLS policies and FORCE
RLS enabled. Application access must use an authenticated company scope;
an incoming provider webhook must first resolve its mapped trusted company and
enter the server's maintenance/tenant scope (Phase 3).

The idempotent SQL is provided in
`migrations/20261111_001_stock_transfer_order_whatsapp_approval_phase1.sql`.
It is also part of startup stage 039. Render's production boot path runs
`ensureStockTransferOrderWhatsAppApprovalSchema` independently of its optional
bulk migration pass, before declaring the app ready.

**Never run `drizzle-kit push` against production.** Existing stock
movements, vouchers, ledger entries, and historical revisions are not rewritten.

## Draft snapshot service (not yet exposed as an HTTP route)

`createStockTransferOrderApprovalDraft` accepts an authenticated company,
one destination, a selected list of 1–100 persisted order IDs and an actor.
It requires enabled group/phone settings, a configured destination recipient,
orders with `workflow_origin='stock_transfer_order'`, correct company, correct
destination and at least one pending revision. It then freezes all pending
revisions from *all source locations* in one transaction.

`assertStockTransferOrderApprovalBatchCurrent(tx,...)` is intended to run
inside the **same database transaction** as Phase 4 approval. It rejects orders
that were changed/deleted/moved, new or superseded pending revisions, changed
item fingerprints, changed approval phone/group, or released reservations.

Phase 1 does **not** expose a request button, receive webhook events, approve
or reject revisions, post accounting, or send WhatsApp documents.

## Phase 2–7 implementation boundaries

1. Phase 2: settings UI, destination routing, selected-order batch creation,
   delivery preflight, and the approval request message with correlated ID.
   On successfully accepted send, atomically mark `requested` and store the
   instance ID/message ID. If a send status is unknown, do not auto-send again.
2. Phase 3: authenticated/verified Green API webhook intake, sender identity
   resolution, quoted-message correlation, replay guard and `DONE/DECLINE`
   parser. An unquoted or unrelated DONE must be ignored.
3. Phase 4: one atomic transaction revalidates the full snapshot then approves
   every pending revision on every selected transfer. Reuse the existing
   immutable revision approval service and audit hook. Roll back all changes
   if any revision fails. Release reservations on terminal state.
4. Phase 5: one consolidated Excel **without cost**, generated only from
   approved persisted order quantities. Send to both the approval group and
   destination recipient, deduplicating identical chat IDs. Never send an
   unapproved workbook as final.
5. Phase 6: append-only review audit, delivery status, retry policy and
   out-of-date request management. An uncertain delivery is not retried until
   someone verifies whether WhatsApp accepted it.
6. Phase 7: production-style integration/tenant/security testing, safe Render
   rollout and manual rollback path.

## Verification

`tests/stock-transfer-order-wa-phase1-schema.test.ts` checks SQL and runtime
migration parity, RLS, origin stamping and the no-approval/no-send boundary.
`tests/startup-schema-integrity.test.ts` pins the 39 new statements after
the reviewed existing 1481-statement baseline.

Before production rollout, a migrated disposable PostgreSQL 16 instance must
prove the schema creates and re-runs cleanly, the new RLS policies reject
cross-company operations, and old Stock Transfer behavior is unchanged.
