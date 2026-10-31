# Phase 2: Offline reads and verified preparation

> Deployment flag remains off. Phase 2 is a preparation/read-only capability, **not an offline authentication bypass**.

## Safety design
- Never replay `/api/auth/me` or session checks from cached responses. Offline reads require a *live, previously verified and still active in-memory identity* from the current tab. A cold restart without server or a future secure offline-unlock implementation must refuse private data.
- Cache exact read URLs only, scoped to both authenticated user ID and server-selected company ID; do not trust locally selected company for authorization.
- Cache only responses that succeeded online, are JSON, have correct contract shape, and were wholly downloaded (including paginated endpoints).
- All reads from offline snapshots carry explicit marker metadata. Never serve cached results on HTTP 401/403, business 500, or arbitrary 503. Only network transport failures and the known service worker `{offline:true}` 503 response may fallback.
- Prepared datasets must not be publicly or cross-company exposed. Metadata includes actor, timestamp, expiry, and the required dataset set. On authentication logout or company change, revoke the active in-memory scope. Prepared data is read-only until a newer validated online snapshot replaces it.
- A snapshot is limited to 8 hours after preparation and the verified live scope has the same ceiling. No record is labelled `ready` unless every requested dataset was stored and counts reconcile; partial is explicit.
- Existing insecure `offlineMeta(key=main)` and entity caches are not trusted for the new readiness checks. No automatic migration/erasure.
- Phase 2 does NOT solve cold-start offline authentication, files, dynamic routes, the factory LAN server, or encrypted-at-rest browser storage. These remain rollout blockers.

## Acceptance
1. Account/company A cannot read B's snapshot, even with the same URL, including a company switch in another tab.
2. A missing/expired snapshot and an offline session that never completed online verification both fail closed.
3. 401/403/ordinary 5xx never fallback.
4. Paged data materializes *all* pages or marks the dataset failed.
5. Network interruption midway through preparation cannot replace a prior complete snapshot.
6. The offline preparation UI communicates partial readiness and last successful timestamp, not false full-system readiness.
7. Unit tests and CI; real browser outage drills and secure offline unlock remain before live activation.
