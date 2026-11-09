# Security Posture

Single source of truth for the current security controls, residual risks, and
measurement path. Companion documents describe *how* individual controls work;
this page states *what is enforced today* and *what still blocks a 100/100
security score*.

Run the live scorecard:

```bash
npm run audit:security-posture
node scripts/audit-security-posture.mjs --json
```

Related reference docs:

- [permissions-security.md](permissions-security.md) — roles, route auth, CSRF layers
- [security-privacy.md](security-privacy.md) — authentication, sessions, data handling
- [security-company-isolation-wave3.md](security-company-isolation-wave3.md) — RLS, privileged maintenance, backups
- [security/scorecard-review-and-exceptions.md](security/scorecard-review-and-exceptions.md) — OpenSSF Scorecard review practice
- [permissions-control-center-activation.md](permissions-control-center-activation.md) — Permissions V2 Create Only activation status

---

## Scorecard summary (Phase 0 baseline)

| Control area | Status | Notes |
|---|---|---|
| Authentication | **Enforced** | Session + bcrypt + WebAuthn; `SESSION_SECRET` required in production |
| Session cookies | **Enforced** | `httpOnly: true`; `secure` in production / Replit / Capacitor; `sameSite: lax` (or `none` when `CAPACITOR_ENABLED=true`) |
| CSRF (Origin/Referer) | **Enforced** | Layer 1 in `server/security/originGuard.ts` |
| CSRF (synchronizer token) | **Enforced by default** | Layer 2; `CSRF_ENFORCE=0` is warn-only and **blocked in production** unless an explicit escape hatch is set |
| Security headers / CSP | **Enforced** | Helmet + production CSP (no `unsafe-inline`/`unsafe-eval` for scripts); violations → `/api/csp-report` |
| API rate limiting | **Enforced** | Per-user when authenticated, per-IP when anonymous; stricter privileged limits |
| Tenant isolation (app) | **Enforced** | Server-owned active company; request-supplied company IDs are validated targets |
| Tenant isolation (DB) | **Enforced** | `FORCE ROW LEVEL SECURITY` on highest-risk company tables |
| Privileged maintenance | **Enforced** | Admin + `administration.repair` or Developer break-glass; rate/concurrency/body budgets |
| Permissions V2 | **Shadow / not activated** | Create Only code path exists; assignment and company activation switches remain off |
| Dependency / secret gates | **Enforced** | High/critical production advisories and verified secrets block CI |
| Accepted risks | **Documented** | `xlsx` prototype pollution / ReDoS (auth-gated upload surface) |

---

## Authentication & sessions

| Setting | Value | Source |
|---|---|---|
| Cookie name | `erp.session` | `server/services/security/sessionCookiePolicy.ts` |
| Store | PostgreSQL (`connect-pg-simple`) when `DATABASE_URL` / `PGHOST` present | `server/startup/sessionMiddleware.ts` |
| `httpOnly` | `true` | session middleware |
| `secure` | `true` when `NODE_ENV=production` **or** `REPL_ID` set **or** `CAPACITOR_ENABLED=true` | session middleware |
| `sameSite` | `"lax"` normally; `"none"` when `CAPACITOR_ENABLED=true` (required for Capacitor WebView) | session middleware |
| `maxAge` | 24 hours, rolling | session middleware |
| `SESSION_SECRET` | Required; process exits in production if missing | session middleware |

Logout and cookie clearing must use `SESSION_COOKIE_NAME` so the same name is always cleared.

---

## CSRF

Two independent layers:

1. **Origin / Referer guard** (`server/security/originGuard.ts`) — rejects state-changing requests whose Origin/Referer does not match the request host (with documented Capacitor / server-to-server exceptions).
2. **Synchronizer token** (`server/security/csrfProtection.ts`) — per-session token from `GET /api/csrf-token`; state-changing `/api/*` requests must send matching `X-CSRF-Token`.

### Enforcement policy

| Environment | Default | `CSRF_ENFORCE=0` |
|---|---|---|
| Development / test | Enforcing | Allowed (warn-only for local debugging) |
| Production | Enforcing | **Rejected at process start** unless `CSRF_ALLOW_WARN_ONLY_IN_PRODUCTION=1` is also set |

The production escape hatch exists only for emergency regression recovery and must be temporary. Prefer fixing the client token attachment path over disabling enforcement.

---

## Security headers

Built in `server/security/securityHeaders.ts` via Helmet:

- Production CSP: `script-src 'self'` only (no inline/eval); `object-src 'none'`; `frame-ancestors 'self'`
- Development keeps Vite allowances (`unsafe-inline`, `unsafe-eval`)
- CSP violation reports: `POST /api/csp-report`
- HSTS / upgrade-insecure-requests enabled in production
- Referrer-Policy: `strict-origin-when-cross-origin`

---

## Access control & tenancy

- Route middleware order is documented in [permissions-security.md](permissions-security.md).
- View Only mutations are blocked globally after session middleware.
- POS users are location-scoped; sensitive cost/profit fields are API-hidden.
- Privileged repair/rebuild/cleanup paths require Admin + `administration.repair` or Developer.
- Permission checks **fail closed** if the named-permission schema is unavailable.

### Permissions Control Center V2

| Switch | Purpose | Production state (Phase 0) |
|---|---|---|
| `PERMISSIONS_V2_CREATE_ONLY_ASSIGNMENT` | Allows assigning the Create Only role | **Unset / off** |
| Company activation / enforcement | Moves a company out of shadow mode | **Shadow** — not activated |

Activation requires the gates in `config/permissions-v2-release-readiness.json` and owner sign-off. See [permissions-control-center-activation.md](permissions-control-center-activation.md).

---

## Rate limiting & privileged budgets

| Limiter | Typical budget | Module |
|---|---|---|
| Global API | ~600/min authed, ~120/min anon (configurable) | `server/middleware/apiRateLimit.ts` |
| Privileged read | 120 / 15 min | `privilegedEndpointSecurity.ts` |
| Privileged mutation | 30 / 15 min | same |
| Privileged destructive | 8 / 15 min | same |
| Body / collection budgets | 1 MB / 2_000 items default | `privilegedRequestBudget` |
| Concurrency | 1 in-flight privileged op per actor+scope | `privilegedConcurrencyLimit` |

---

## Database isolation & backups

- Highest-risk tenant tables use **FORCE ROW LEVEL SECURITY** (migration `0016_company_scope_rls_readiness.sql` and follow-ons).
- Missing/malformed tenant context fails closed.
- Production backup role: read-only + `BYPASSRLS` so `pg_dump` is complete without disabling RLS.
- Backup verification workflow fails if `BACKUP_DATABASE_URL` is missing or the role lacks `BYPASSRLS`.

---

## Accepted risks (explicit)

| Risk | Advisory / topic | Why accepted | Exit path |
|---|---|---|---|
| `xlsx` (SheetJS) | Prototype pollution / ReDoS | Only reachable by authenticated users uploading crafted spreadsheets; no unauthenticated vector | Migrate parse/export paths to `exceljs` (Phase 3 of the security roadmap) |

All other production high/critical npm advisories are either fixed or require a written, dated exception in the dependency-audit verifier.

---

## Residual gaps toward security 100/100

These are the intentional Phase 0 residual items (not bugs — open work):

1. **Permissions V2 not activated** — largest remaining access-control gap (Phase 1).
2. **Session absolute lifetime / idle timeout** — rolling 24h only; consider shorter idle timeout (Phase 2).
3. **`xlsx` accepted risk** still present (Phase 3).
4. **Soft-delete coverage inventory** not fully formalized as a continuous gate (Phase 4).
5. **Master-password / Developer break-glass** monitoring and dual-control still light (Phase 4).
6. **Authz regression matrix / continuous fuzz** can be expanded (Phase 5).

---

## Measurement

| Command | What it proves |
|---|---|
| `npm run audit:security-posture` | Live posture scorecard from source + env policy |
| `npm run check:security` | Focused security suite (company-scope, tenant regressions, privileged policy, Wave 3 closeout) |
| `npm run verify:dependency-audit` | No unreviewed high/critical production vulnerabilities |
| `npm run audit:company-scope` | Unreviewed high-risk SQL / request-company findings |
| `npm run audit:access-control-v2-routes` | Permissions V2 route inventory consistency |

Phase 0 is complete when this document, the scorecard script, production CSRF hard-fail policy, and discoverability from `docs/README.md` are all in place.
