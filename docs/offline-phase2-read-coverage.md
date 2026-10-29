# Offline Phase 2 — supported read coverage and release boundaries

This implementation is on `feat/offline-phase1-durable-foundation-20261029` and remains behind `OFFLINE_MODE_ENABLED=false`.

## Exact prepared GET endpoints

All successful responses below are stored under the authenticated user AND active server-selected company ID:

| Pack | Read endpoints |
|---|---|
| Shared | `/api/company-settings`, `/api/my-erp-pages`, `/api/exchange-rates` |
| ERP | `/api/locations`, `/api/ledger-accounts`, `/api/suppliers`, `/api/customers`, `/api/stock-items/light`, `/api/inventory` |
| POS | `/api/pos/drafts`, `/api/bale-products`, `/api/employees` |
| Factory | `/api/factory/suppliers`, `/api/factory/categories`, `/api/factory/bale-products`, `/api/factory/containers`, `/api/factory/raw-stock`, `/api/factory/suppliers/with-balances`, `/api/factory/daybook`, `/api/factory/fx-rates` |

**Excluded:** session endpoints (`/api/auth/me`, `/api/auth/session-company`, `/api/user/companies`) and unlisted/dynamic URLs. Authenticated session data must never be silently fabricated from a business snapshot.

## Preparation and offline read semantics

1. Online-only preparation checks `/api/auth/me`, server session company and company assignments.
2. Download each exact endpoint and all pages if the response has a `data / totalPages / pageSize` envelope or trusted pagination headers. Unsupported multi-page envelopes fail instead of claiming success.
3. Verify server session ownership **again** before promoting the complete generation to IndexedDB in one transaction. Mid-preparation error leaves the previous complete generation intact.
4. The new `offlineReadSnapshots` (Dexie v8) keys include `companyId`, `userId` and exact URL. `offlineReadGrants` has the same owner and an eight-hour expiry.
5. GET fallback is allowed only when there is a live, already-verified identity in this browser tab, the snapshot and grant are unexpired, and the network truly failed or the service worker emitted its known offline 503. Business 401, 403, 500, and ordinary 503 responses are never hidden.
6. Responses are marked `X-ERP-Offline-Snapshot: 1` and `X-ERP-Offline-Cached-At`. The UI must treat data as last-known values, not live totals.
7. Logout, confirmed session expiry and cross-tab identity signals revoke live offline access. Stale user/company snapshots remain inaccessible to the new identity.

## Known constraints — not production-ready

- Cold-start offline authentication is **not** implemented. Without a securely authenticated live browser session, the cache refuses to return private data. This is intentional and must not be bypassed with a raw cached `/api/auth/me` response.
- All user-facing pages are not covered: only the exact prepared reads above can fall back. Queries with filters, detail IDs or pagination parameters are not automatically authorized. Uncached screens remain online-only.
- The browser cache is **not encrypted at rest**. Device storage loss or clearing browser data loses snapshots; physical profile access may expose the files. Evaluate encrypted desktop storage and secure offline unlock before deployment.
- Cached balances, stock and authorizations age during an outage; role changes cannot be learned offline. Current eight-hour expiry limits but does not eliminate this.
- Offline writes, local factory PostgreSQL, peer synchronization and cloud replication are outside Phase 2; server-posting guarantees remain Phase 1/3 work.
- Service-worker page assets must be prepared independently before offline navigation. A successful read manifest does not certify every React route.
- No CI or on-device test has been asserted green until corresponding GitHub checks and browser drills are actually observed.

## Manual acceptance

Use a dedicated nonproduction tenant. Verify: populate snapshots online; disconnect the backend/internet with a still-authenticated tab; load exact prepared GET endpoints and inspect the snapshot response header; check original HTTP 401/403/500 is returned unchanged; expire grant and ensure data becomes unavailable; switch user/company and ensure another identity sees no stale records; break download on page 2 and check previous complete data remains accessible; sign out in another tab and check offline access revoked; clear IndexedDB and verify offline reads fail visibly rather than invent data.
