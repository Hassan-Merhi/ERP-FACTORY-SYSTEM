# Stock Transfer Order WhatsApp approval — Phase 6

## Scope

Only Stock Transfer Order approval batches originating from the existing
Send to WhatsApp → Request Approval area. Ordinary transfers, POS and Factory
approvals, vouchers, inventory postings and all other ERP workflows are unchanged.

## Admin workflow

1. Open Stock Transfer Order → Send to WhatsApp → Request Approval.
2. In Recent approval requests, choose Reconcile on a fully approved batch.
3. Review the exact Excel filename, checksum, recipient chat, GREEN API
   message ID where available, attempt count, status, and immutable audit.
4. For a failed or uncertain recipient, verify the exact batch and filename
   both in the WhatsApp chat and in GREEN API history.
5. If the file is present, select I found the file. The result becomes
   manually verified (separate from provider-accepted). The actual
   provider message ID is never invented.
6. If the file is not found, select File not found — authorize retry. Both
   verification checkboxes, an evidence reason (20–500 characters), and
   explicit acknowledgment of duplicate-delivery risk are mandatory.
7. The same approved workbook and original frozen recipient are queued.
   No more than three administrator-authorized retries per recipient.
8. When approval and destination are the same WhatsApp chat, reconcile the
   approval group once; the destination shares its result. No second file
   is sent to the same chat.

Only Admin, Owner and Developer can open the detailed audit or authorize a
manual recovery. Manager can view summary results but cannot override them.

## Security and accounting

- Only fully approved batches can be reconciled; never a generic Stock Transfer.
- Active-company scoping on both endpoints, with role enforcement in the
  route and permission context.
- PostgreSQL transaction locks the batch and both recipient delivery rows
  before changing a status. The request must also specify the current
  failed/uncertain status, otherwise a concurrent update is rejected.
- Retry is blocked for accepted or manually verified records, active sends,
  and deliveries with an existing returned provider message ID.
- The original approval group, destination and main WhatsApp instance are
  checked against frozen approval records before reconciliation.
- Every decision writes immutable evidence containing the administrator,
  timestamp, exact recipient and the verification reason.
- When the delivery worker is disabled, a manual retry stays queued.
- Rejected or unknown outcomes still cannot cause automatic blind retries.
- No stock movement, revision, voucher, ledger, amount, price or cost is
  altered by any Phase 6 operation.

## API endpoints

GET /api/stock-transfer-order/wa-approval/requests/:batchId/deliveries
POST /api/stock-transfer-order/wa-approval/requests/:batchId/deliveries/:recipientKind/reconcile

Recipient kind is approval_group or destination. The POST requires action
verify_delivered or authorize_retry, expectedStatus failed or uncertain, a
20–500 character reason, checkedWhatsApp and checkedProvider booleans.
Verify additionally requires confirmedDelivered. Retry additionally requires
confirmedNotDelivered and acknowledgeDuplicateRisk.

## Database

Stage 042 adds manual_retry_count (integer default 0, capped at 3), the
explicit verified delivery status, and two immutable audit event types:
delivery_manually_verified and delivery_manual_retry.

Migration: migrations/20261111_004_stock_transfer_order_whatsapp_reconciliation_phase6.sql
Boot schema: server/startup-schema/042-stock-transfer-order-wa-reconciliation.ts

If running manually on TablePlus, apply previous Phase 1, Phase 3 and
Phase 5 migrations before Phase 6. No existing voucher or stock data is
rewritten. Bootstrap registration is idempotent.

## Verification and rollout

Unit and contract test files:
- tests/stock-transfer-order-wa-phase6-policy.test.ts
- tests/stock-transfer-order-wa-phase6-contract.test.ts

Source-level tests and implementation are committed. No full TypeScript
build, PostgreSQL integration, live WhatsApp test, production migration,
Render deployment or main-branch merge was performed in this phase.

Phase 7 must verify a full real-world workflow, including multiple
locations, one DONE, no-cost workbook consistency, two recipient outcomes,
duplicate prevention, failed/uncertain manual reconciliation and recovery
after interruption before enabling it in production.
