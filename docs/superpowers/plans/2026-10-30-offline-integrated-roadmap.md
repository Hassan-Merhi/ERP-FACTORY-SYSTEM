# Unified offline mode — remaining release phases (draft)

**Branch:** `feat/offline-mode-integration` — contains development work for Phases 1–6, including two separate Phase 5 slices. **Not production certified.** `main` is unchanged. Keep `OFFLINE_MODE_ENABLED=false`, `FACTORY_EDGE_WRITE_MODE=read-only`, and do not authorize LAN-primary until a verified cutover.

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

**Production gate remains blocked:** This is a manual frozen-LAN failback/replay foundation, **not automatic cloud sync while factory laptops keep writing**. The Phase 7 trusted baseline, independently arbitrated single-writer epochs, restricted runtime/migration role split and actual factory hardware are not certified. The PostgreSQL acceptance callback uses a disposable minimal voucher fixture; the real central accounting adapter still requires full migrated-ERP read-after-apply and financial reconciliation tests. There is no approved uploads transfer, non-USD, stock, supplier, factory/POS or universal business apply. Do not enable `FACTORY_PHASE8_APPLY_ENABLED`, `FACTORY_PHASE8_RECEIPTS_ENABLED`, `OFFLINE_MODE_ENABLED`, LAN-primary or merge the draft PR into `main` until the external gates are independently satisfied.

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
- On a LAN instance, startup provisions an independent `factory_edge_pressing_counter` and immutable `factory_edge_pressing_outbox`. These tables are **separate from the Phase 8 voucher cursor** so a pressing event cannot create gaps in financial replay. Unique constraints cover site/operation and source confirmation; triggers forbid UPDATE/DELETE.
- The existing pressing confirmation handler captures this immutable evidence **inside its original transaction**, after its audit. If the evidence insert fails, the business scan and audit roll back together; idempotent replay does not append a duplicate capture. Cloud and read-only modes do not emit these rows.
- Added schema, envelope, rollback and transaction-sharing tests to both Phase 8/9 contract workflows.
- **Not an approved offline route:** The LAN writer guard still rejects `POST /api/factory/pressing-machines/confirm`. A typed authenticated cloud staging receiver, exclusive-fence-proven exactly-once posting, applied receipts, source-to-cloud mappings, scan corrections/voids and tenant/hardware reconciliation must all be implemented and verified before the route can be unblocked. The overall remaining business write backlog stays open.

## Phase 10 — Offline identity, conflicts, secure storage and server controls
- Implement reviewed local-session/cold-start policy, encrypted legacy-cache migration, authorization/role revocation, and scoped credentials and browser/device protections.
- Add deterministic multi-device conflict review with no silent financial/stock overwrites.
- Provide operator controls to pause/resume sync and safely stop the factory server only when local pending writes and restore/recovery state are visible and protected.

## Phase 11 — End-to-end factory certification and rollout
- Integrate Phases 7–10 and run full repository CI, schema/migration, security and release tests on the exact integration release SHA.
- Run all 15 Phase 6 acceptance drills on disposable factory hardware: two laptops with WAN cut, failed ACKs, power loss, restore, attachment/ledger/stock reconciliation and supervised failback.
- Obtain independent security/database review and explicit operator/owner sign-off; only then choose a staged production rollout.

**Do not merge to `main`, install on the live factory server, or enable offline mode until these gates are passed.**
