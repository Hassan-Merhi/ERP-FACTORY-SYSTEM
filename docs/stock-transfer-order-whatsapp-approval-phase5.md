# Stock Transfer Order — WhatsApp approved Excel, Phase 5

## Result

This phase applies **only to Stock Transfer Order**. All normal Stock Transfers,
POS, Factory, Properties, old manual Send to WhatsApp and cost-included exports
remain unchanged.

A verified reply **DONE** to one specific consolidated approval message now
performs the Phase 4 atomic all-location approval. In the same transaction,
the system stores a permanent, cost-free snapshot of the final approved stock
quantities. Phase 5 generates **one exact Excel workbook** and automatically
sends it to:

1. the original linked WhatsApp approval group; and
2. the receiving destination's original linked WhatsApp number or group.

An explicit **DECLINE** does not create a final Excel or a delivery request.

## Workbook contents

The workbook preserves the existing Truck Trip no-cost template:
company header, destination, date, article names, source locations, quantities,
per-location subtotals, and grand total. A second **Approved Orders** sheet
names all included Stock Transfer Order references and the approval batch key.

No price, cost, rate, margin, value_moved, ledger journal or total monetary
amount enters either sheet. Editable names and order references are escaped
to prevent spreadsheet formula injection.

The final source is read inside Phase 4's approval transaction, *after* all
revision changes but *before* commit. Aggregation combines identical articles
from the same source location across all selected orders. The snapshot JSON
and its SHA-256 are immutable. Phase 5 renders Excel from that archived
snapshot, stores a single immutable workbook bytea and SHA-256, and always
loads that same persisted file for both recipients.

Post-approval stock edits cannot change the already-approved Excel.

## Delivery behavior

Only batches marked approved are eligible. Each batch has a separate durable
delivery record per recipient with states:

- pending — approved; not sent yet
- sending — a uniquely claimed attempt is underway
- accepted — GREEN API accepted the file and returned an idMessage
- failed — GREEN API definitively rejected the file; at most three
  automatically spaced attempts, with backoff
- uncertain — a connection timeout, unclear provider response or interrupted
  worker means it *may already have arrived*. Never automatically retry

The sender uses the SAME configured main GREEN API instance that produced the
quoted approval message. The destination is read from Phase 1's frozen batch
audit; it is never silently rerouted to a newly configured number. The worker
checks both recipients against the original batch again before sending.

If the approval group and destination chat IDs are identical, only one
physical GREEN API upload is performed. The destination delivery record
aliases the accepted message ID from the group attempt; no duplicate Excel
is sent to the same chat.

A PostgreSQL claim token and lease, independent of process memory, guard
against parallel Render workers. If a worker crashes during a claimed send,
the claim expires to uncertain instead of being sent again. Both delivery
results are saved in the DB alongside immutable event history.

**Important:** Status accepted means GREEN API accepted the message; it is
not proof that the recipient's phone received or read it.

## Operators and status

In Stock Transfer Order → Send to WhatsApp → Request Approval, recent batches
show the approving phone, review time, and an independent status line for the
approval group and receiving destination. Results refresh while the dialog is
open. Uncertain status explicitly instructs users to check WhatsApp rather
than blindly resend.

The Settings → Export Center page shows delivery-worker readiness. New
approval requests are prevented when the authoritative delivery worker is
disabled. Existing queued approved sends are held, not erased, when it is
paused. Environment kill switch: STO_WA_DELIVERY_ENABLED=false. Production is also default-denied until STO_WA_PRODUCTION_ACTIVATED=true is deliberately set after certification.

## Files

- server/services/stockTransferNoCostWorkbook.ts
- server/services/stockTransferOrderApprovedWorkbookSnapshot.ts
- server/services/stockTransferOrderWaDeliveryWorker.ts
- server/services/whatsappService.ts
- server/services/stockTransferOrderWhatsAppBatchExecution.ts
- server/services/stockTransferOrderWhatsAppApprovalWorker.ts
- server/routes/stockTransferExportWhatsAppRoutes.ts
- server/routes/stockTransferOrderWaApprovalRoutes.ts
- server/index.ts
- server/startup-schema/041-stock-transfer-order-wa-delivery.ts
- migrations/20261111_003_stock_transfer_order_whatsapp_excel_phase5.sql

## Tests

- tests/stock-transfer-order-wa-phase5-workbook.test.ts validates the real
  XLSX structure, subtotals, grand total, references and formula protection.
- tests/stock-transfer-order-wa-phase5-contract.test.ts checks frozen
  transaction reads, JSONB/bytea immutability, delivery claims, retries,
  same-chat de-duplication, auth-instance confinement, and status integration.
- tests/startup-schema-integrity.test.ts pins the new Stage 041 statements
  after Stages 039/040 and retains the previous schema baseline.

## Deployment / remaining work

No merge to main, production SQL execution, WhatsApp message, or Render deploy
has been performed during this phase's code work.

Production startup runs the additive, idempotent Stage 041 independently of
the optional bulk migration run. If deploying via a manual migration process,
run migrations in order: Phase 1 (001), Phase 3 (002), Phase 5 (003).

Live end-to-end testing is still essential before relying on this for stock
and accounting: a verified approver reply, multi-order all-or-nothing commit,
correct workbook contents, two distinct recipients, same-chat deduplication,
simulated network timeouts and restart recovery. Phase 6 can add administrator
reconciliation and controlled manual retry of uncertain deliveries; Phase 7
covers the complete deployment verification and rollout.

Do not retry an uncertain delivery without separately verifying that the
first upload was not accepted by WhatsApp.
