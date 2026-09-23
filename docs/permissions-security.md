# Permissions & Security

## Roles

Roles are stored in `userCompanyRoles` and set in the session as `currentRole`.

| Role | Level | Notes |
|---|---|---|
| `Developer` | Highest | Global support/break-glass role for explicitly supported workflows. Ordinary feature restrictions may be bypassed, but tenant/company boundaries and sensitive-operation controls still apply. |
| `Admin` | High | Broad company-scoped administration. Sensitive maintenance operations additionally require the named `administration.repair` permission. |
| `Owner` | Medium-high | Full access by default; can be restricted via Advanced Restrictions. Cannot delete records. |
| `Manager` | Medium | Full access by default; can be restricted. Can delete records only if `canDeleteRecords = true`. |
| `POS` | Restricted | Limited route set. Today-only date restriction. Cannot delete records. Must be assigned to a location. |
| `Normal User` | Lowest | Denied by default for most features. Must be explicitly granted access via Advanced Restrictions. |

The `canDeleteRecords` flag is a per-user-company-role boolean that grants delete capability to Managers (not Owners or POS).

---

## Route Auth Pattern

Every protected route applies middleware in this order:

```
requireAuth          → verifies session, populates req.user + req.user.role
requireNonPOS        → (optional) blocks POS role entirely
requireRole(...)     → (optional) allows only specific roles
canDelete            → (optional) used on DELETE routes
checkPOSLocation     → (optional) used on location-scoped POS routes
canModifyDate        → (optional) used on routes that accept a date field
requireModuleAccess  → (optional) checks mod_* permission key
requireActionAccess  → (optional) checks act_* permission key
requireExportAccess  → (optional) checks exp_* permission key
```

Example:
```typescript
app.post("/api/vouchers", requireAuth, requireNonPOS, async (req, res) => { ... });
app.delete("/api/vouchers/:id", requireAuth, canDelete, async (req, res) => { ... });
app.get("/api/pos/inventory", requireAuth, checkPOSLocation, async (req, res) => { ... });
```

---

## Company Access

Each user-company pair has an entry in `userCompanyRoles`. A user can have different roles in different companies. The active company is stored in the session as `currentCompanyId`.

Company switching updates the session's `currentCompanyId`. All subsequent queries use the new company context.

---

## POS Location Access

POS users are additionally constrained by `userLocations`:
- The `checkPOSLocation` middleware queries `userLocations` to confirm the requesting user is assigned to the `locationId` in the request.
- If no assignment exists, the request is rejected with 403.
- Non-POS roles bypass the location check.

---

## Advanced Restrictions System

Defined in `shared/permissionConfig.ts`. Implemented by `server/lib/permissionHelpers.ts` and `server/lib/permissionMiddleware.ts`.

**Key naming conventions**:

| Prefix | Scope |
|---|---|
| `mod_*` | Top-level module visibility (ERP, Factory, POS, Properties, Inventory, Accounting, Analytics, Settings) |
| `page_*` | Full page/route visibility |
| `tab_*` | Tab or sub-section visibility within a page |
| `act_*` | Action buttons / write operations (create voucher, adjust stock, transfer stock, etc.) |
| `fld_*` | Sensitive field visibility (cost price, profit margin, supplier/customer balances, bank balances) |
| `exp_*` | Export / print capabilities (PDF, Excel, WhatsApp, audit log, backup) |
| `pos_perm_*` | POS-specific capabilities (price override, discount, credit sale, refund, shift open/close) |

**Semantics** (from the catalog comment):
- `Developer` / `Admin` → always allowed, cannot be restricted
- `Owner` / `Manager` / `POS` → allowed by default; `enabled = false` in DB means restricted
- `Normal User` → denied by default; `enabled = true` in DB means explicitly allowed

This means the UI checkbox means opposite things for different roles:
- For Owner/Manager/POS: checked = restriction is active (stored as `enabled = false`)
- For Normal User: checked = access is granted (stored as `enabled = true`)

---

## CSRF Protection

Two independent layers in `server/index.ts`:

**Layer 1 — Origin / Referer guard**:
- Checks the `Origin` or `Referer` header on state-changing requests.
- Rejects requests where neither header matches the request host.
- Exceptions: requests without either header (e.g. server-to-server), Capacitor WebView origins.

**Layer 2 — Synchronizer token**:
- A per-session CSRF token is generated and exposed via `GET /api/csrf-token`.
- All state-changing requests must include a matching `X-CSRF-Token` header.
- Controlled by `CSRF_ENFORCE` env var: default = enforcing (hard 403). Set `CSRF_ENFORCE=0` for warn-only mode.

---

## Session Security

- Sessions are stored in PostgreSQL (pg-based session store).
- The session `secret` is read from `SESSION_SECRET` env var. If missing in production, startup logs a critical error and generates a random secret (which means sessions are invalidated on restart).
- `secure: true` cookie flag is set in production, on Replit (when `REPL_ID` is set), or with Capacitor.
- Session does not use `httpOnly: false` by default (Needs verification — confirm httpOnly setting).

---

## Soft Delete

Key entities use soft deletion (Needs verification — confirm which tables have a `deletedAt` or `isDeleted` column). The 30-day purge scheduler (`[Purge]`) runs daily at 2 AM EST and permanently removes soft-deleted rows older than 30 days.

The "Deleted Items" admin page (`server/routes/admin/deletedItemsRoutes.ts`) allows reviewing and restoring soft-deleted records before the purge window expires.

---

## Current Security Boundaries

1. **Tenant isolation is layered**: the global application boundary validates the server-owned active company, while PostgreSQL `FORCE ROW LEVEL SECURITY` protects the highest-risk company tables and voucher entries.
2. **Privileged maintenance is centrally narrowed**: mutation paths for repair, recalculation, rebuild, cleanup, backfill, reconciliation, resync, and fix operations require Admin with `administration.repair` or the explicit Developer support boundary before legacy handlers run.
3. **POS location isolation uses live company-role context**: POS mutations validate assigned location, view-only state, cash-account ownership, and capability permissions from canonical storage instead of login-time session values alone.
4. **Security permissions fail closed**: if the critical named-permission schema is unavailable, privileged permission checks return a service-unavailable denial rather than silently granting access.
5. **Backup access is separate from application access**: the production backup role is read-only but must have `BYPASSRLS` so `pg_dump` can produce a complete dump without weakening `FORCE ROW LEVEL SECURITY`.
6. **High/critical dependency findings and verified leaked secrets are blocking security gates** in the Security workflow. Unknown secret candidates are surfaced for review.
7. **Historical integrity remains explicit**: `NOT VALID` foreign keys or historical anomalies are audited and repaired only through reviewed maintenance workflows; they are not silently rewritten by tenant-security migrations.
