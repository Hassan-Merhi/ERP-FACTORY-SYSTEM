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

## Phase 9 — Complete ERP / Factory / POS offline business coverage
- Audit every write endpoint and add explicitly supported atomic capture/apply policies, including inventory, production, scanner, purchasing, retail/POS, payments, attachments and document operations.
- Provide precise UI status: local only, staged, cloud-applied, conflict, or blocked. Unsupported operations fail closed, never pretend to sync.
- Verify each workflow against stock, finance, attachments and all tenant boundaries.

## Phase 10 — Offline identity, conflicts, secure storage and server controls
- Implement reviewed local-session/cold-start policy, encrypted legacy-cache migration, authorization/role revocation, and scoped credentials and browser/device protections.
- Add deterministic multi-device conflict review with no silent financial/stock overwrites.
- Provide operator controls to pause/resume sync and safely stop the factory server only when local pending writes and restore/recovery state are visible and protected.

## Phase 11 — End-to-end factory certification and rollout
- Integrate Phases 7–10 and run full repository CI, schema/migration, security and release tests on the exact integration release SHA.
- Run all 15 Phase 6 acceptance drills on disposable factory hardware: two laptops with WAN cut, failed ACKs, power loss, restore, attachment/ledger/stock reconciliation and supervised failback.
- Obtain independent security/database review and explicit operator/owner sign-off; only then choose a staged production rollout.

**Do not merge to `main`, install on the live factory server, or enable offline mode until these gates are passed.**
