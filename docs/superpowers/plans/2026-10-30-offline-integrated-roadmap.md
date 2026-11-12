# Unified offline mode — remaining release phases (draft)

**Status (2026-11-07):** the development work for Phases 1–10, the owner-approved offline plan (batches 1–5) and its staging drill material are on `main` (most recently #2871 and #2967), **switched off**. **Not production certified.** Keep `OFFLINE_MODE_ENABLED=false`, `FACTORY_EDGE_WRITE_MODE=read-only`, every Phase 8 flag off and `EDGE_APPROVED_PLAN_BATCHES` empty, and do not authorize LAN-primary until a verified cutover. The open gates are listed in the resume checklist at the end.

The existing Phase 4 cloud transport **stages evidence only**; it does not apply business transactions to the cloud. Existing Phases 1–6 are development milestones, not approved release gates. Complete the following phases sequentially where dependencies require it.

## Phase 7 — Trusted bootstrap and exclusive write authority
- Restore an approved, consistent, encrypted cloud data and upload baseline into the active factory PostgreSQL instance with independent verification, tenants, permissions, sequences and balances.
- Implement a durable, database-enforced primary epoch/lease across **all** cloud API instances, background workers, WebSocket routes, cron, integrations and direct writes, then explicit operator-driven LAN cutover and failback.
- Prove no dual-primary transactions can commit. Factory server remains read-only by default.

### Phase 7 development status — 2026-10-30 (NOT CERTIFIED)

Implemented on the unified branch (not main): fail-closed LAN-primary authority checks, explicit site/baseline/epoch configuration; a DBA-only PostgreSQL state-row write fence with transaction-held locks, current-table triggers and optional-by-capability DDL event-trigger guard; pooled connection epoch announcements; a disposable PostgreSQL 17 contract suite exercising denial, in-flight transaction fencing, DDL coverage and stale epochs; plus a read-only, privacy-preserving comparison of all disposable-clone public table contents, schema metadata, sequences and uploads. Phase 7 contract CI is separate from release certification.

Additional Phase 7 development: reviewed-fence-only DBA SQL now prepares a NOLOGIN restricted runtime role and grants business DML without DDL, owner, trigger, or writer-state-update rights; disposable PostgreSQL tests exercise role permissions. Factory .env preflight now accepts the complete Phase 7 operator sample and passes epoch/digest settings to the policy validator. Neither change activates the role or changes running credentials.

**Release gate still BLOCKED:** The current LAN Compose app/database login is a PostgreSQL superuser and startup schema ensures require DDL rights. Production needs a reviewed split between privileged migration/DBA duties and a restricted runtime database role on cloud and LAN, with a compatible migration path and managed Postgres event-trigger capability review. No approved, transactionally consistent CLOUD database+uploads baseline has been provisioned to a factory server or independently reconciled. No independent cloud fence, real hardware / outage / two-site transaction proof, production cutover, failback, DBA/security review or operator sign-off has happened. The existing source/baseline digest setting is not a cryptographic attestation. The Phase 7 work MUST remain draft, with `OFFLINE_MODE_ENABLED=false` and the LAN in `read-only`.

## Phase 8 — Transactionally safe LAN → cloud business apply
- Finish the cloud receiver beyond staged evidence: validated, exactly-once business posting for the initial approved voucher route, idempotent durable applied receipts and acknowledgement-loss retry handling.
- Reconcile voucher ID mappings, ledger, business dates, immutable outbox sequence, uploaded files and user/company authority without re-posting money or stock.
- Prove real PostgreSQL read-after-apply correctness, duplicate/out-of-order rejection, and safe WAN outage recovery.

### Phase 8 development status — 2026-10-30 (RELEASE BLOCKED)

Committed on the unified branch, not on `main`:

- Phase 8 cloud applied-voucher cursor, immutable receipts and local-voucher-to-cloud-voucher mappings are written **in the same PostgreSQL transaction** as the initial accounting posting. The operator path replays only contiguous pre-staged events, returns the stored receipt after lost ACK, rejects divergent replay and rolls back partial business effects on errors.
- The supervised adapter uses the existing central posting engine and its target-company, balanced-journal, fiscal-period and idempotency validators, with a narrower USD, active Journal / ledger-only allowlist. A Phase 8 LAN capture admission guard prevents unsupported voucher types from entering that claimed path. Central protected voucher posts now capture LAN outbox evidence transactionally.
- Applied receipts can be fetched through a signed, read-only cloud endpoint and compared against immutable LAN source evidence; only independently verified receipts persist as `cloud-applied` in a separate append-only LAN log. Staging receipts do not change meaning.
- Dedicated tests include contract-level rejection, business-date/tenant/payload checks, disposal-only PostgreSQL tests for sequence ordering, missing approvals, role revocation, rollback after a failed business statement, durable read-after-apply and ACK-loss replay. CI verification is required on the exact final head.

**Production gate remains blocked:** This is a manual frozen-LAN failback/replay foundation, **not automatic cloud sync while factory laptops keep writing**. The Phase 7 trusted baseline, independently arbitrated single-writer epochs, restricted runtime/migration role split and actual factory hardware are not certified. The PostgreSQL acceptance callback uses a disposable minimal voucher fixture; the real central accounting adapter still requires full migrated-ERP read-after-apply and financial reconciliation tests. There is no approved uploads transfer, non-USD, stock, supplier, factory/POS or universal business apply. Do not enable `FACTORY_PHASE8_APPLY_ENABLED`, `FACTORY_PHASE8_RECEIPTS_ENABLED`, `OFFLINE_MODE_ENABLED`, or LAN-primary until the external gates are independently satisfied.

## Phase 9 — Complete ERP / Factory / POS offline business coverage
- Audit every write endpoint and add explicitly supported atomic capture/apply policies, including inventory, production, scanner, purchasing, retail/POS, payments, attachments and document operations.
- Provide precise UI status: local only, staged, cloud-applied, conflict, or blocked. Unsupported operations fail closed, never pretend to sync.
- Verify each workflow against stock, finance, attachments and all tenant boundaries.

### Phase 9 development status — 2026-10-30 (NOT COMPLETE, PRODUCTION BLOCKED)

- Added a **read-only**, no-store `GET /api/edge/status?operationId=<uuid>` projection on a LAN server. It requires a session actor and company and queries immutable LAN outbox evidence using site + operation + company + actor constraints. `local-only`, `staged`, `cloud-applied`, and `conflict` are only derived from exact source/stage/applied receipt matches. Missing evidence and database errors never become positive apply claims.
- The prepared-device UI now exposes those statuses for the current verified account's most recent durable vouchers; rejected browser requests show `blocked` and missing/invalid network proof stays `local-only`. It never treats an HTTP 2xx or an unverified staged ACK as a cloud-applied accounting write.
- The read-only manifest audit `node scripts/edge/audit-phase9-write-coverage.mjs` classifies **every unique API write** into approved voucher capture, narrow session-only action, or blocked. It compares the manifest to the actual LAN-primary write guard and fails if a new endpoint escapes without an explicitly reviewed capture policy. `--require-complete` intentionally exits nonzero until unsupported business routes are implemented. Dedicated contract tests exercise scope, mismatch, and policy drift. The remaining categories include inventory, factory, purchasing, POS, payments, and attachments.
- This slice adds **no new business mutation allowlist**, no attachment uploads/replication, no background cloud apply, no production data migration, and no LAN-primary cutover. Phase 9 as a whole remains OPEN. Before each new write path can be approved, deliver an atomic local capture, typed protocol, tenant/auth checks, safe cloud posting, immutable applied receipts and real PostgreSQL finance/stock/file reconciliation. The Phase 7/8 external release gates still apply.

### Phase 9 continuation — strict admission and authorization (development only)

- Hardened `/api/edge/status?operationId=...` to call the application's live `requireAuth` session/credential guard, then assert current company membership. The public no-operation LAN health/status probe remains unchanged. Stale or revoked actors receive no receipt proof.
- Narrowed the LAN read-only session exemption to reviewed **POST + exact path**, not any mutating verb on a session path. The Phase 9 manifest audit uses that same method/path policy.
- Browser durable outbox admission now matches the approved Phase 8 USD, balanced Journal, ledger-only and no-attachment contract. Stored records are revalidated before each actual HTTP replay and poisoned or legacy inputs enter a retained `needs_review` state without a network business write. The LAN server also rejects unknown top-level voucher payload keys and impossible calendar days.
- Expanded Node/HTTP/Vitest tests and Phase 8/9 workflows for stale sessions, revoked company access, false cloud-applied receipts, unsupported write guards, invalid voucher dates, payload drift, and saved device tampering. Full CI on the exact latest head is required before any green claim.
- **No new business route was approved.** This is risk reduction, not a claim that Phase 9 production/stock/POS/attachments coverage is finished. Existing Phase 7/8 and security/factory sign-offs remain blockers.

### Phase 9 continuation — legacy replay closure and receipt proof

- Closed the separate OfflineBanner legacy localStorage replay button and its destructive auto-delete/success claims. The UI now exposes only verified actor/company durable vouchers and offers the versioned outbox engine as its sole retry action. Legacy localStorage and IndexedDB queue entries are retained but shown as **blocked, not syncable**, with no exposed record contents or HTTP replay. The connectivity counters also distinguish those blocked records from actually retryable requests.
- While the new offline feature flag is enabled, the old localStorage `enqueueRequest` and IndexedDB `addToSyncQueue` APIs refuse new unscoped offline writes. When the flag is disabled, existing legacy behavior remains unchanged; neither path is approved for cutover.
- Strengthened the saved browser voucher delivery contract: HTTP 2xx must return the **original operation UUID, matching company, valid posted Journal voucher, accounting date and matching ledger lines/amounts** before being acknowledged on the device. Mismatched or malformed 2xx responses remain as `needs_review` to prevent silent duplicate money posting on retry.
- Strengthened atomic LAN voucher outbox capture: missing/invalid request UUID now throws inside the source transaction rather than minting a fresh unrelated operation ID. Entry admission and HTTP capture already require matching UUIDs. Added targeted frontend and server tests plus workflow triggers.
- **Release gate unchanged:** This does not approve or implement inventory, production, scanning, purchasing, POS, payments, documents or file attachments. Existing factory capture/apply and cross-site reconciliation is incomplete. The feature flag remains disabled and Phase 9 remains open.

### Phase 9 continuation — unverified 2xx and cloud-time safeguards

- Legacy replay eligibility now reports false under the new offline mode even for endpoints historically considered `SAFE_PATTERNS`; the old queue schema remains untouched for supervised recovery.
- Durable vouchers require response identity, tenant, date and ledger line/money evidence to match the immutable request before a browser accepts a 2xx. An ambiguous receipt stays `needs_review` and is shown as review-required to the operator rather than eligible to retry.
- The Phase 9 sync engine no longer advances the global `lastSyncedAt` timestamp on LAN/server acknowledgement. A distinct verified cloud-applied receipt is required before claiming cloud sync. CI includes explicit regression checks for this separation.
- **Status: Phase 9 still incomplete, not certified.** Only the existing constrained voucher route has a transactional LAN capture/apply development path; no stock, scan, POS, factory, financial payment or document/attachment route was enabled. Do not turn on the feature flag, LAN-primary, or merge the PR.

### Phase 9 Factory pressing confirmation — atomic source capture development

- Introduced a strict `pressing.confirmation.v1` envelope for source-confirmed physical scans, with exact company/actor/request UUID, source confirmation ID, bale, machine, assignment, reference, timestamps and shift production day. The payload explicitly declares `inventoryFinalized: false`; it never authorizes stock, voucher, mix-cost or bale-state changes.
- A separately invoked, LAN-only schema installer function prepares an independent `factory_edge_pressing_counter` and immutable `factory_edge_pressing_outbox` in a **reviewed DBA/migration transaction, not automatic startup**. The tables are separate from the Phase 8 voucher cursor so pressing events cannot create gaps in financial replay. Unique constraints cover site/operation and source confirmation; tenant-scoped foreign keys and triggers protect source identity and forbid UPDATE/DELETE.
- The existing pressing confirmation handler captures this immutable evidence **inside its original transaction**, after its audit. If the evidence insert fails, the business scan and audit roll back together; idempotent replay does not append a duplicate capture. Cloud and read-only modes do not emit these rows.
- Added envelope, transaction-sharing, rollback and disposable PostgreSQL 17 tests to the Phase 8/9 contract workflows. Schema installation still requires a reviewed DBA migration.
- **Not an approved offline route:** The LAN writer guard still rejects `POST /api/factory/pressing-machines/confirm`. A typed authenticated cloud staging receiver, exclusive-fence-proven exactly-once posting, applied receipts, source-to-cloud mappings, scan corrections/voids and tenant/hardware reconciliation must all be implemented and verified before the route can be unblocked. The overall remaining business write backlog stays open.

### Phase 9 continuation — pressing cloud pipeline and reusable event streams (2026-10-30)

- **Pressing scans are now an approved LAN-primary write**, end to end: atomic LAN capture → signed staging (`/api/edge/sync/events/stage`, own HMAC domain) → operator-only exactly-once cloud apply (`server/edge/phase9OperatorApply.ts`) → signed read-only receipts → LAN-verified receipt log. The route is admitted only for LAN-primary, behind the Phase 7 epoch and provisioned-data proofs, and only when the DBA-installed capture tables **and** immutability triggers exist (else 503).
- Reusable framework (`phase9EventProtocol.mjs`, `phase9CloudEventStore.mjs`): per-stream registry of event kinds, canonical payload rebuild, gapless per-stream staging and apply cursors, stored-receipt replay after lost ACK, divergent-replay refusal, shared Phase 7 cloud-writer proof (extracted from Phase 8 unchanged).
- Deterministic conflicts: a cloud disagreement (bale already scanned, missing machine/assignment/bale, revoked or view-only actor) rolls back, is recorded in an append-only register and blocks the stream until a named DBA `reject-event` decision produces an auditable `rejected-conflict` receipt. Nothing is overwritten or skipped silently.
- `GET /api/edge/status?operationId=` now also projects pressing operations.
- Evidence: `tests/offline-phase9-pressing-sync-drill.test.ts` (separate LAN and cloud PostgreSQL databases, real fence, restricted role) plus protocol and boundary tests; wired into the Phase 8/9 workflows.
- Coverage now: 2 approved captures (USD Journal vouchers, pressing scans), 3 session-only, 1,173 blocked. Remaining workflows and the reason each is still online-only are listed in [factory-offline-operations-runbook.md](../../operations/factory-offline-operations-runbook.md) §2. `--require-complete` stays red by design.

### Phase 9 owner decisions (2026-11-01)

The owner chose to make all remaining workflows available offline (stock movements, POS sales, payments, supplier receiving, attachments) under the conflict policies recorded in [the runbook](../../operations/factory-offline-operations-runbook.md) ("Owner-approved offline policies"). Admin and Developer users review held conflicts. The owner will run the staging outage drills after implementation; each workflow is enabled only after its drill passes and the owner signs off.

### Phase 9 stock movements — quick adjust (2026-11-01, development)

- `POST /api/inventory/quick-adjust` is an approved LAN-primary write on the shared event framework, stream `stock`, kind `stock.quick-adjust.v1`: atomic capture in the adjustment transaction (`server/edge/phase9StockOutbox.ts`), cloud replay through the same implementation as the live route (`inventoryQuickAdjustCore.ts`, `server/edge/phase9StockApply.ts`) as a quantity delta, with idempotency on the LAN operation id.
- Owner policy: a replay that would take cloud stock below zero is held (`PHASE9_STOCK_WOULD_GO_NEGATIVE`) until an Admin/Developer approves (`approve-override`) or rejects it. Approval is limited to conflict codes a stream declares overridable; reviewers are checked against current Admin/Developer roles.
- The LAN guard admits the route only when the DBA-installed stock outbox and its immutability trigger exist (otherwise 503 `EDGE_PHASE9_STOCK_CAPTURE_NOT_INSTALLED`).
- Evidence: `tests/offline-phase9-stock-apply.test.ts` (real handler on the full schema: deltas, lost-ACK replay, held/approved below-zero, divergence, missing item, revoked access/permission) and `tests/offline-phase9-stock-sync-drill.test.ts` (separate LAN/cloud databases, fence, restricted role, relay, approve and reject decisions, verified receipts).
- Coverage: 3 approved captures, 3 session-only, 1,172 blocked.

### Phase 9 POS cash sales (2026-11-02, development)

- `POST /api/pos/sales` is an approved LAN-primary write, stream `pos`, kind `pos.sale.v1`. Owner policy: cash, USD, non-supplier-partner sales with a client sale id; credit, bank, non-USD and id-less sales are refused offline before anything is written (`server/services/pos/posSaleOfflinePolicy.ts`).
- Offline sales are numbered from the LAN invoice series (`LAN-<site>-000123`, allocated from the stream's gapless counter in the sale transaction) and captured in the same transaction (`server/edge/phase9PosOutbox.ts`).
- Cloud replay (`server/edge/phase9PosSaleApply.ts`) re-checks access, the till cash account and stock, then runs the normal sale service with the offline price; the cloud voucher keeps a cloud number and records the LAN invoice number. Exactly-once is the sale's `clientSaleId`. Below-zero stock and a changed POS till account are held for approve/reject; a missing/non-cash account, unsupported company or any sale-service refusal can only be rejected.
- Evidence: `tests/offline-phase9-pos-sale.test.ts` (LAN capture, series, retry, refusals; cloud replay, lost-ACK, held/approved below-zero, bad till account, divergence). The shared store, relay and decision mechanics are the ones proven by the stock drill.
- Coverage: 4 approved captures, 3 session-only, 1,171 blocked.

### Phase 9 offline payments — factory cash box (2026-11-02, development)

- The Phase 8 voucher pipeline (posting and receipt in one cloud transaction) now also accepts USD `Payment` and `Receipt` vouchers that move exactly one Cash-type ledger account against expense (Payment) or income (Receipt) accounts (`server/edge/phase8CashBoxPolicy.mjs`). Bank, payable, receivable, stock, employee and intercompany accounts are refused, which keeps bank transfers and supplier/customer payments online-only as the owner decided.
- The rule is enforced on the LAN at capture (the voucher rolls back with a 4xx) and again against current cloud account types at apply.
- Evidence: `tests/offline-phase8-cash-box.node.test.mjs` (policy) and `tests/offline-phase8-cash-box-posting.test.ts` (cloud posting on the full schema, with supplier/bank refusals).

### Phase 9 supplier receiving — container offload (2026-11-02, development)

- `POST /api/containers/:id/offload` is an approved LAN-primary write, stream `receiving`, kind `receiving.container-offload.v1`. Owner policy: a first offload against the container's existing purchase orders, quantities only; duties, charges, cost corrections, agent lines and offload edits are refused offline (`server/routes/containers/containerOffloadOfflinePolicy.ts`).
- The offload lifecycle now runs on a caller-provided transaction (`executeContainerOffloadLifecycleTx`): the LAN captures in the offload transaction, and the cloud replay (`server/edge/phase9ReceivingApply.ts`) runs the same lifecycle on the Phase 9 receipt's transaction. Cloud purchase order prices value the stock. A quantity digest (no prices) detects order changes, which are held for approve/reject; an already-offloaded or non-offloadable container can only be rejected.
- Evidence: `tests/offline-phase9-receiving.test.ts` (quantity-only policy, LAN capture with digest, cloud replay, no double receipt, held/approved changed order).
- Coverage: 5 approved captures, 3 session-only, 1,170 blocked.

### Phase 9 attachments — file upload (2026-11-02, development)

- `POST /api/files/upload` is an approved LAN-primary write, stream `attachments`, kind `attachment.file.v1`, with a 10 MB offline cap. The upload's row and the record (metadata + SHA-256) commit together (`server/edge/phase9AttachmentOutbox.ts`).
- Owner policy "record first, then the file": the relay stages the record, then uploads the bytes to the signed `/api/edge/sync/files/stage` endpoint (own HMAC domain over the SHA-256; body must hash to it; must match a staged record and its size). The cloud keeps verified bytes in an immutable, content-addressed `factory_edge_staged_files` table; the LAN logs acknowledgements so files are sent once.
- Cloud replay (`server/edge/phase9AttachmentApply.ts`) waits without a conflict until the bytes are staged, then creates the file on the receipt's transaction and verifies its hash; a missing folder is held for approve (top level) or reject.
- Evidence: `tests/offline-phase9-attachments.test.ts` (LAN capture, relay staging, tampered/unreferenced bytes refused, upload once, replay, held/approved missing folder).
- Coverage: 6 approved captures, 3 session-only, 1,169 blocked.

### Owner decisions 2026-11-02 — wider offline scope

The owner extended offline coverage: offload edits, duties and charges; supplier, customer and bank payments; POS credit, bank and Kwacha sales at the rate the cashier enters, plus returns and cancellations; and stock transfers, imports and bulk edits.

- Receiving: the `receiving` event now carries the full offload as entered and edits (`PATCH /api/containers/:id/offload`).
- POS: offline sales may now be cash, bank or credit, in USD or another currency at the rate the cashier enters (`EDGE_POS_OFFLINE_RATE_REQUIRED` if missing). The `pos.sale.v1` evidence carries the payment type and account, currency, rate and original prices; the cloud replay passes the LAN rate as `lockedCurrency`, so it is never re-derived. Tests: `tests/offline-phase9-pos-sale.test.ts`.
- POS returns/corrections: `PUT /api/vouchers/:id/sales` (and the PATCH alias) are approved captures; kind `pos.sale-edit.v1` on the `pos` stream so an edit always follows its sale. The cloud replay finds the sale by client sale id or (pre-outage) voucher id, maps existing lines to the cloud's lines so they keep their cost, and runs `applyPosSaleUpdateTx` on the receipt's transaction.
- POS cancellations: `DELETE /api/vouchers/:id` is admitted on the LAN for sales vouchers only (`EDGE_VOUCHER_DELETE_OFFLINE_SALES_ONLY` otherwise); its transaction body moved to `deleteVoucherTx`, which the `pos.sale-cancel.v1` replay runs on the receipt's transaction.
- Payments: `POST /api/vouchers/payment-receipt` is an approved capture (stream `payments`); its create path moved to `server/services/accounting/paymentReceiptVoucherPosting.ts`, shared by the route and the cloud replay (`server/edge/phase9PaymentApply.ts`), which posts at the LAN rate on the receipt's transaction. Evidence: `tests/offline-phase9-payments.test.ts`.
- Stock transfers: `POST /api/stock-transfers` (create-from-scratch form) is an approved capture, kind `stock.transfer.v1` on the `stock` stream. The transaction body moved unchanged to `server/services/inventory/createStockTransfer.ts`, which now derives the stock-document idempotency key from the request id itself; the cloud replay (`server/edge/phase9StockTransferApply.ts`) runs it on the receipt's transaction under the LAN request id, so a lost ACK is already-present and a reused id with different lines is reject-only. A cloud shortfall is `PHASE9_STOCK_WOULD_GO_NEGATIVE` (overridable). The existing-voucher form is refused on the LAN (`EDGE_PHASE9_STOCK_TRANSFER_FORM_CLOUD_ONLY`). Tests: `tests/offline-phase9-stock-transfer.test.ts`.
- Stock-item bulk edits and imports: ten routes (bulk prices, bulk category, bulk rename, bulk unit fix, update-categories, update-names-by-code, import-barcodes, import-opening-balances, location prices, `PATCH /api/stock-items/:id`) write through `server/services/inventory/stockItemEditCapture.ts` on one transaction; on the LAN each whitelisted field change is recorded as "before -> after" and appended as `stock.item-edit.v1` (chunks of 2,000 changes). Changing a cloud-only field (code, grade, reorder level) is refused on the LAN with `EDGE_PHASE9_STOCK_ITEM_FIELD_CLOUD_ONLY`. The cloud handler (`server/edge/phase9StockItemEditApply.ts`) locks the items, checks id + code, applies a field only while the cloud value equals "before", and holds a field the cloud changed as `PHASE9_STOCK_ITEM_CHANGED` (overridable: the LAN value wins). Creating, deleting, merging and re-coding items stay cloud-only because offline records find their items by id and code; Excel transfer/inventory imports and transfer edits/approvals stay cloud-only (no replay handler yet). Tests: `tests/offline-phase9-stock-item-edit.test.ts`.

## Phase 10 — Offline identity, conflicts, secure storage and server controls
- Implement reviewed local-session/cold-start policy, encrypted legacy-cache migration, authorization/role revocation, and scoped credentials and browser/device protections.
- Add deterministic multi-device conflict review with no silent financial/stock overwrites.
- Provide operator controls to pause/resume sync and safely stop the factory server only when local pending writes and restore/recovery state are visible and protected.

### Phase 10 development status — 2026-10-30 (PARTIAL)

Done on the branch:
- Operator pause/resume of LAN→cloud delivery: append-only `factory_edge_sync_control_log` with operator name and reason; both relays honour it (`server/edge/phase10SyncControl.mjs`).
- Deterministic multi-device conflict review with no silent financial/stock overwrite: Phase 8 divergent-replay refusal; Phase 9 conflict register + named DBA decisions.
- Permission revocation after capture: cloud apply re-checks the actor's CURRENT access (Phase 8 Admin/Owner + DBA approval; Phase 9 active user and non-view-only company role).
- Tenant isolation: tenant-scoped source FKs on capture, envelope/payload identity binding, approved-company check at apply.
- Safe server stop/handover visibility: `scripts/edge/factory-handover-preflight.mjs` (status / handover gate) and the read-only, Admin/Owner-only LAN endpoint `GET /api/edge/operator/status` (same report, no database access needed).
- Reviewed DBA schema installer with explicit acknowledgement (`server/edge/offlineSchemaInstall.ts`).

Done in the owner-approved offline plan (2026-11-05):
- Reviewed local-session/cold-start policy for laptops that cannot reach the LAN server — **done 2026-11-05 (plan batch 5, decision 10)**: a read-only viewer for at most 24 hours after the last online sign-in, opened with the encrypted cache's passphrase through a sealed ticket; every write is refused in the browser; sign-out or a disabled/removed account wipes the ticket (`client/src/lib/offline/offlineReadCache.ts`, `client/src/components/OfflineColdStartGate.tsx`, `tests/ui/offline-cold-start-*.test.ts*`).
- Encrypted migration of legacy localStorage/IndexedDB queue entries — **done 2026-11-05 (plan batch 5)**: moved at sign-in into an encrypted store (non-extractable browser key), listed for Admin/Owner/Developer with date, type and amount, each re-entered through the normal form or discarded, every choice recorded in the audit log with the user's name, unhandled entries deleted after 30 days; nothing is ever sent automatically (`client/src/lib/offline/legacyQueueRecovery.ts`, `tests/ui/offline-legacy-queue-recovery.test.ts`, `tests/offline-legacy-queue-decisions.test.ts`).
- Operator UI for pause/resume and conflict decisions — **done 2026-11-05 (plan batch 1, owner-approved)**: Pause/Resume on the factory server and Approve/Reject on the cloud operator console, each with password re-entry and a reason, written only through DBA-owned functions (`server/edge/phase10OperatorControls.mjs`) that re-check the user; the runtime role keeps read-only access to the control tables (`tests/offline-phase10-operator-decisions.test.ts`, `tests/offline-phase10-operator-sync-control.test.ts`). The read-only operator view is done: `FactoryEdgeOperatorPanel` in the Offline panel shows per-stream pending / staged / applied / rejected counts, relay pause state (who and why) and handover readiness from `GET /api/edge/operator/status`; it renders nothing on the cloud or for non-Admin/Owner users, and never reports handover ready while anything is pending (`tests/ui/offline-phase10-operator-panel.test.tsx`).
- Offline stock item create/delete — **done 2026-11-05 (plan batch 2, owner-approved)**: `POST /api/stock-items` and `DELETE /api/stock-items/:id` on the factory server record `stock.item-create.v1` / `stock.item-delete.v1` in the stock stream; LAN-created items take ids from a reserved range and the cloud maps them to cloud ids before any later record naming them is applied (`server/edge/phase9StockItemMap.mjs`, `tests/offline-phase9-stock-item-lifecycle.test.ts`). Merge and re-code stay online-only (owner decision).
- Offline transfer edits, finalizes and revisions — **done 2026-11-05 (plan batch 3, part 1, owner-approved)**: `stock.transfer-edit.v1`, `stock.transfer-finalize.v1`, `stock.transfer-revision.v1` and `stock.transfer-revision-review.v1` on the stock stream; each change carries the transfer as the factory saw it and applies only while the cloud copy still matches (edit/finalize held as approvable, stale revisions reject-only) (`server/edge/phase9StockTransferWorkflowApply.ts`, `tests/offline-phase9-stock-transfer-workflow.test.ts`). The Excel transfer import (single and multi-source) is offline too: on the LAN each import goes through the hand-typed transfer code and is recorded as an ordinary `stock.transfer.v1` (plan gate: a 50-row import replays once with no second stock movement). The Excel inventory import is offline too: each row is recorded as a quantity change through the quick-adjust code, so the cloud adds it to its own figure and holds a below-zero result (`server/services/inventory/locationImportOfflineCapture.ts`, `tests/offline-phase9-inventory-import.test.ts`). Plan batch 3 is complete.
- Offline payment edits/deletes and file renames/moves — **done 2026-11-05 (plan batch 4, owner-approved)**: `voucher.payment-receipt-edit.v1` / `voucher.payment-receipt-delete.v1` carry a SHA-256 of the voucher as the factory saw it (`server/edge/phase9PaymentSnapshot.ts`); `attachment.file-update.v1` carries the file's name and folder before and after. Changed records are held; reconciled, intercompany or closed-period vouchers and missing folders are reject-only (`tests/offline-phase9-payment-followup.test.ts`, `tests/offline-phase9-file-update.test.ts`). Each plan batch's routes stay refused on the factory server until its staging drill is approved (`EDGE_APPROVED_PLAN_BATCHES`). Fixed on the way: the central Payment/Receipt create route served the app's payments on the factory server without recording them; on the LAN those requests now go to the recording route.

## Phase 11 — End-to-end factory certification and rollout
- Integrate Phases 7–10 and run full repository CI, schema/migration, security and release tests on the exact integration release SHA.
- Run all 15 Phase 6 acceptance drills on disposable factory hardware: two laptops with WAN cut, failed ACKs, power loss, restore, attachment/ledger/stock reconciliation and supervised failback.
- Obtain independent security/database review and explicit operator/owner sign-off; only then choose a staged production rollout.

**The code is on `main` but switched off. Do not install the offline schema on the live factory server, approve plan batches or enable offline mode until these gates are passed.**

### Phase 11 development status — 2026-10-30 (PARTIAL)

- Operations runbook with authority-handover, conflict, backup/restore, DR and monitoring procedures plus a scenario-to-evidence matrix: [factory-offline-operations-runbook.md](../../operations/factory-offline-operations-runbook.md).
- Database-level drills cover concurrency, failed transactions, WAN loss, lost ACKs, duplicates, restore, interrupted apply, conflicts, revocation, stale epochs and reconciliation.
- Branch CI repairs: merged `main`, fixed `main`-introduced TypeScript errors, the `drizzle-kit push` BigInt default crash, the pressing PostgreSQL SQLSTATE assertion, the Phase 4 fixture, formatting, env documentation and runtime-table declarations for every offline table.
- Still open: real hardware drills (Phase 6 matrix), independent security/DBA review, owner sign-off, and full CI on the exact release SHA.

## Phases 13–16 — Standalone browser offline mode (2026-11-09, development)

Laptops keep working without the internet and without the factory server, then
sync straight to the cloud. Code and tests are in place; it is switched off
(client `OFFLINE_MODE_ENABLED=false`, cloud `OFFLINE_BROWSER_SYNC_ENABLED` unset)
and not verified on laptops or in production. Details, supported entries and
the reasons for everything still online-only:
[runbook](../../operations/factory-offline-operations-runbook.md#standalone-laptops-browser-offline-mode-phases-1316).

- Phase 13: encrypted per-user queue in IndexedDB, capture only when known to be
  offline, saved/pending/synced/failed states, offline editing of unsent records.
- Phase 14: `/api/offline/browser-sync/*` applies each record exactly once through
  the Phase 9 handlers with the session as the actor; receipts, lost-ack replay,
  per-stream order, backoff, conflicts, Admin/Developer override, discard.
- Phase 15: Payment/Receipt, stock adjustment, stock transfer, new stock item and
  POS sale work offline; every other write is refused with a reason.
- Phase 16: offline panel (banner drawer and Factory settings) with counters,
  Sync now, Pause/Resume, conflict decisions, storage and a recovery copy.

## Resume checklist (next session)

All development in the owner-approved offline plan is merged (#2871, 2026-11-06). The coverage audit (`node scripts/edge/audit-phase9-write-coverage.mjs`) reports 39 captured routes, 17 of them waiting for drill approval, and 1,140 refused; `--require-complete` stays red by design. What remains is rollout and certification:

1. **Plan batch drills (owner, material ready).** Batches 2–4 stay refused on the factory server until the owner runs each batch's staging outage drill and signs its drill record; the approved batch is then listed in `EDGE_APPROVED_PLAN_BATCHES` on staging, and in production only at rollout. The owner approved the drill plan on 2026-11-06 (staging on a spare factory PC and a separate cloud instance, a masked production copy, one batch per day in the order 2, 3, 4, every scenario must pass). The setup, the per-batch scripts, the per-session checks, the drill record and the read-only reconciliation command (`scripts/edge/drill-reconcile.mjs`) are in [offline-drills/](../../operations/offline-drills/README.md) (#2967). Next step: set up staging and run the batch 2 drill.
2. **Phase 7 gates.** A reviewed split between a restricted runtime database role and the DBA/migration role on cloud and LAN (the LAN Compose login is still a superuser); an approved, independently verified cloud data and uploads baseline restored onto the factory server; single-writer proof across every cloud instance, worker, cron job and integration, with a rehearsed cutover and failback.
3. **Phase 8 gate.** Full migrated-ERP read-after-apply and financial reconciliation tests for the real central accounting adapter.
4. **Phase 11 certification.** The 15 Phase 6 drills on real factory laptops, an independent security and database review, owner sign-off, and full CI on the exact release SHA; only then a staged production rollout.
5. **Online-only by owner decision (not planned).** Stock item merge and re-code; laptop-local cash sales (decision 11); every other refused route.
