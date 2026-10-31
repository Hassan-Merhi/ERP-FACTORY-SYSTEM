# Offline Phase 1 — durable operation foundation

> Scope: establish a safe, testable foundation; **do not enable offline writes across the ERP** until each endpoint has a server-enforced idempotency and conflict policy.

## Requirements

1. Each operation has a stable UUID, a device ID, authenticated actor/company, source module, original client date, exact request body, and durable state.
2. Save the operation transactionally in IndexedDB **before attempting a network submission**. Fail visibly when storage is inaccessible.
3. Never silently discard, collapse, or reorder a financial/stock mutation. A receipt is persisted separately from the write intent.
4. Retry network errors, 408, 429, and 5xx with bounded exponential backoff and the *same* UUID; do not discard after an arbitrary retry count.
5. A 401 pauses processing without changing the actor. A 409 or business 4xx preserves a reviewable conflict/rejection record, not a dropped request.
6. Before delivery, revalidate the authenticated user and active company against the operation's scope. Do not replay other users' or companies' writes.
7. Two tabs must not deliver the same operation simultaneously: atomic IndexedDB leases and server-side idempotency jointly protect replay, including a lost acknowledgement.
8. Only explicitly audited operations may be automatically delivered. Phase 1 starts with the already-idempotent ERP voucher-with-entries POST path; other paths remain blocked for review. Existing pressing scans retain their own dedicated proven queue.
9. Existing localStorage and IndexedDB legacy queues must not be blindly replayed. Do not delete their contents during migration; surface them as legacy pending work requiring an explicit safe migration.
10. Keep the current `OFFLINE_MODE_ENABLED=false` until end-to-end offline readiness and existing CI are verified.

## Boundary

This phase does **not** implement offline API reads, factory LAN server replication, offline authentication, local accounting posting, cloud sync, or arbitrary endpoint write support. Those require later phases. A local saved intent is **not** a posted voucher or committed stock movement.

## Validation / acceptance

- Unit tests: endpoint allowlist, sensitive payload blocking, stable idempotency, actor isolation, retry classification, conflicts, lease recovery, and acknowledged receipts.
- Integration: test an accepted write whose HTTP acknowledgement is lost and retry it with the *same ID* against the existing transactional posting service.
- Real browser: IndexedDB write refusal and interrupted-session recovery, including cross-tab contention.
- Release gate: CI and real multi-device drills must pass before production flag rollout.

## Existing code

- `client/src/lib/db.ts`: Dexie database, pre-existing `syncQueue` and `offlinePackages`.
- `client/src/lib/offlineQueue.ts`: legacy localStorage queue; broad unsafe allowlist.
- `client/src/lib/syncEngine.ts`: old replay path (not sufficiently safe for enabling globally).
- `client/src/pages/factory/pressing-scanner/pressingOfflineQueue.ts`: proven durable capture model.
- `server/routes/vouchers/voucherCreateRoutes.ts`: transactional posting identity for `POST /api/vouchers/with-entries`.

## Rollout

The new queue is additive. Existing queues remain untouched. Never turn the global flag on simply because Phase 1 foundation code is merged. Future integration must route all mutations through a single registration and delivery policy and remove the old replay implementation only after safely migrating pending legacy records.
