# Stock Transfer Order WhatsApp Approval — Phase 4

## Delivered

Phase 4 automatically processes verified WhatsApp **DONE** and **DECLINE**
decisions for the exact batch of Stock Transfer Orders listed in the quoted
request. It reuses the existing immutable stock-transfer revision lifecycle.
Normal Stock Transfers and all unrelated ERP workflows are unchanged.

### DONE — one full-batch approval

1. Phase 3 verifies the main WhatsApp instance, group, authorized sender and
   the exact quoted approval-message ID, then commits one immutable decision.
2. Even after Phase 3 verified the webhook, Phase 4 checks the stored
   authenticated decision again against the exact outbound WhatsApp instance,
   group, authorized phone and quoted message ID inside its transaction.
3. The executor locks the batch and rechecks all frozen orders, pending revisions,
   existing stock-line fingerprints, approval settings and the destination
   WhatsApp recipient in one PostgreSQL transaction.
3. For each selected Stock Transfer Order, the existing approval lifecycle
   merges **all pending revisions from every contributing source location**.
   Phase 4 calls it once per selected transfer, not once per location.
4. All inventory, voucher, fiscal-period and stock-value guards stay active.
   If any order cannot be approved, all orders and audit changes roll back.
5. Every included revision must finish as approved or superseded. The latter
   reflects an older same-item/location change replaced by newer revisions.
   No pending revision from the frozen batch can be silently left behind.
6. After success, the batch becomes approved with reviewer phone and timestamp;
   reservations are released and audit entries describe every revision.
7. Two pending final-Excel delivery records are created atomically: original
   approval group and frozen destination WhatsApp recipient. **Phase 4 does not
   generate or send files**; that work belongs to Phase 5.

### DECLINE — one full-batch rejection

Rejection runs the existing immutable rejection service for **every included
pending revision** in the same parent transaction. Any error rolls back all
rejections. Once all succeed, batch status becomes declined, each revision is
recorded as rejected, review history is updated and reservations are released.
No Excel delivery is queued.

### Failure safety and recovery

- An immutable first-decision event and batch row locks prevent repeated or
  contradictory WhatsApp replies from executing twice.
- The webhook stages the decision durably, then schedules immediate execution.
  A database-backed worker scans for unprocessed accepted decisions every
  20 seconds and recovers after Render restarts or interrupted requests.
- Known business or inventory conflicts roll back everything and mark the
  batch stale, with a reason in the immutable event history.
- Transient infrastructure/database errors roll back and stay queued for
  retry; a one-minute in-memory backoff prevents rapid repeated failures.
- Admin cancellation is blocked after a verified DONE or DECLINE has been
  recorded, even if execution is not yet complete.
- Only the authoritative, scheduler-enabled ERP writer may process decisions.
  Environment switch STO_WA_PRODUCTION_ACTIVATED=true is required to activate the feature after certification; otherwise execution is disabled. STO_WA_APPROVAL_EXECUTION_ENABLED=false pauses processing
  and prevents new approval requests.
- The existing approval history UI shows completed status, approving phone,
  review timestamp and included revision count.

### Changed files

- server/services/stockTransferOrderWhatsAppDecisionPolicy.ts
- server/services/stockTransferOrderWhatsAppBatchExecution.ts
- server/services/stockTransferOrderWhatsAppApprovalWorker.ts
- server/routes/stockTransferOrderWaApprovalWebhookRoutes.ts
- server/routes/stockTransferOrderWaApprovalRoutes.ts
- server/index.ts
- client/src/pages/stock-transfer-order/StockTransferOrderApprovalRequestPanel.tsx
- client/src/pages/settings/StockTransferOrderApprovalSettings.tsx

### Test coverage added

- tests/stock-transfer-order-wa-phase4-policy.test.ts — pure selection and
  conflict handling unit tests.
- tests/stock-transfer-order-wa-phase4-contract.test.ts — full transaction,
  replay, permissions, audit and no-file-sending source contracts.

Verification is source-level only. Full TypeScript build, PostgreSQL migration
testing, multi-order rollback integration, and live GREEN API callback
testing have not been executed from this chat.

**Phase 5 next:** send the final cost-free Excel to both WhatsApp recipients
using the already queued delivery records. Pending delivery is not proof of
actual WhatsApp receipt.
