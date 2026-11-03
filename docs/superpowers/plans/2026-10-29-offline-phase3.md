# Phase 3 — Factory LAN edge server (separate from cloud replication)

## Objective

A single server on the factory LAN serves the existing ERP/Factory Express API and React SPA from the same HTTPS origin to all connected factory laptops. The server owns a *local* PostgreSQL 17 database and local sessions. No laptop is provisioned with PostgreSQL credentials. No cloud account cookie is shared with the LAN installation.

**This is not cloud replication.** Cross-database transfer, cloud write fencing, conflict resolution and authoritative dataset provisioning belong to Phase 4. Phase 3 must not imply that independently writable cloud and LAN databases can be reconciled automatically.

## Security/availability contract

1. `FACTORY_EDGE_MODE=lan` is opt-in. Cloud deployments retain their original behavior by default.
2. Factory edge refuses to boot unless configured for production, same-origin HTTPS, server-generated session secret, local database hostname, enforced CSRF and disabled schedulers. Refuse `DATABASE_URL` to avoid accidentally pointing edge at cloud.
3. When not explicitly cut over, all business POST/PUT/PATCH/DELETE requests return 423 with `EDGE_READ_ONLY`, while login/logout, company selection and CSP telemetry still work. Auth, origin, permissions and CSRF are otherwise unchanged.
4. `FACTORY_EDGE_WRITE_MODE=lan-primary` requires exact operator cutover acknowledgment. This is not a server-verifiable cloud lock: do not enable without first fencing cloud writes and approving the restored local data.
5. Public `GET /api/edge/status` exposes only mode, site UUID, read-only/primary mode and replication-not-configured. The existing database readiness probe must additionally refuse an unprovisioned edge database.
6. Docker Compose publishes ONLY HTTPS at the operator-specified LAN IP; app and PostgreSQL have no host-published ports. Database storage persists across upgrades. TLS chain must be trusted by clients; no bypass of browser cert warnings or insecure HTTP.
7. No automatic fallback between cloud and LAN. A user chooses LAN application URL explicitly, signs in to LAN, and sees origin identity. Until Phase 4, that choice cannot be changed mid-write.
8. Startup migration/backup rehearsals require a disposable factory database first. Never import production user data from documentation or example files.
9. Cloud mode, existing desktop, Capacitor and all existing server security boundaries remain unchanged when edge flag is absent.

## Acceptance

- Pure policy tests: reject remote DB, invalid hostname/site, weak secrets, missing CSRF, scheduler enablement, unsafe primary activation, and cloud contamination.
- Middleware tests: read-only blocks business writes, leaves approved session paths working, and never claims synchronization.
- Config and static deployment tests: pinned source build, no DB/API host ports, HTTPS only, strict env handling and persistent Postgres.
- On factory hardware: supply real trusted TLS certificate, test operator laptop/browser login and multiple laptops, validate local-only traffic while WAN is disconnected, verify backups and restore, and perform cloud-primary cutover and reconciliation before LAN-primary authorization.
