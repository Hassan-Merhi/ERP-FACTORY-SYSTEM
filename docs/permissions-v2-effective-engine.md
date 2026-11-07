# Permissions V2 — effective permission engine and company activation

Status: implemented, **disabled by default**. No company is active and no operator switch is set. Every role behaves exactly as before until an operator and the owner approve activation for a specific company.

Related: [activation runbook](permissions-control-center-activation.md) · [administrator guide](permissions-control-center-admin-guide.md) · [frontend page audit](permissions-v2-frontend-page-audit.md).

## How a decision is made

For one person, in one company, for one business resource and action (for example `erp.suppliers` / `create`):

1. **Membership.** The role is read from `user_company_roles` for the active company. Nothing in the request (body, query, header or session copy of the role) can choose the company, the user or the role. A person with no role in the company gets nothing.
2. **System roles.** Admin and Developer are system-managed and are never evaluated through V2.
3. **Hard restrictions.** No role rule or override can lift these:
   - system users and maintenance are Admin/Developer only; company settings are Admin/Owner/Developer;
   - `manage_users` and `repair` are never granted to an operational role;
   - View Only can only view and export;
   - Create Only can view, export, and create only on the resources with a handler-verified create (suppliers, customers, stock items, factory bale batches and customer orders, rental units and contracts, retail products, supplier-partner sales);
   - ERP Tester never manages settings.
4. **Legacy decision.** Today's role semantics from `role_feature_permissions` at module level (Normal User denied by default; Owner, Manager and POS allowed unless restricted).
5. **V2 rules.** A user override beats the role rule; `inherit` falls through.
6. **Effective result.**
   - In **shadow** or **rolled_back** mode, or while `PERMISSIONS_V2_ENFORCEMENT` is off, the effective result is exactly the legacy decision. V2 is reported as `proposed` only.
   - In **active** mode with `PERMISSIONS_V2_ENFORCEMENT=enabled`, the effective result is **legacy AND V2**. V2 is restrict-only: an `allow` never widens what the legacy system allows.

Route, page, tab, location, cashbox, accounting-period and record-state guards on the server still run on every request, on top of this decision.

Decisions are computed per request from committed database state. There is no cache, so an approved change applies to the next request in every session. Browsers refetch their access data on focus, on a timer and immediately after any role or permission refusal (also in other open tabs).

## Endpoints

| Endpoint | Who | Purpose |
|---|---|---|
| `GET /api/permissions-v2/me` | any signed-in member | The caller's effective permissions in the active company |
| `GET /api/permissions-v2/users/:userId/effective` | company Admin/Developer | A member's effective permissions; 404 for anyone outside the company |
| `GET /api/permissions-v2/activation` | company Admin/Developer | Mode, revision and the two operator switches |
| `PUT /api/permissions-v2/activation` | company Admin/Developer | Move the company between `shadow`, `active` and `rolled_back` |

`PUT /api/permissions-v2/activation` takes `{ "mode", "expectedRevision", "reason" }`. It refuses `active` with `409 PERMISSIONS_V2_ACTIVATION_NOT_AUTHORIZED` unless `PERMISSIONS_V2_COMPANY_ACTIVATION=enabled`. A stale revision gets `409 POLICY_STALE_REVISION`. Moving to `shadow` or `rolled_back` is always allowed. The mode change, revision increment and audit row commit in one transaction; the audit shows it as `policy:mode`.

Role rules and user overrides can be edited only while the company is in `shadow` mode. To change an active company's rules, move it to `shadow`, edit, review the preview, then activate again. Each step is audited.

## Enforcement middleware

`permissionsV2Enforcement` runs after the tenant boundary. While `PERMISSIONS_V2_ENFORCEMENT` is off it returns immediately with no database work. When on, it checks business writes whose route has a reviewed business-action mapping in `config/access-control-v2-route-review.json`, only for companies in `active` mode, and refuses with `403 PERMISSION_V2_DENIED`. If the policy cannot be read for such a write it refuses with `503 PERMISSION_SERVICE_UNAVAILABLE` instead of running unchecked.

## Administrator safety rules

- Only a Developer can grant the Developer role, and Admins cannot change Developer accounts (existing scope policy).
- Administrators cannot assign roles in another company (existing scope policy).
- Nobody except a Developer can change or remove their **own** company role: `403 SELF_ROLE_CHANGE_FORBIDDEN`.
- A company's last Admin cannot be demoted, removed or have their account deleted: `409 LAST_COMPANY_ADMINISTRATOR`. The check locks the company's Admin rows, so two Admins demoting each other at once cannot both succeed.
- Administrators cannot save overrides for themselves (`SELF_ESCALATION_FORBIDDEN`) or for Admin/Developer members, and Create Only can never be given edit, delete, approve, finalize, void, reverse or import rights.

## Operator switches

| Variable | Default | Effect |
|---|---|---|
| `PERMISSIONS_V2_CREATE_ONLY_ASSIGNMENT` | off | Lets administrators assign the Create Only role |
| `PERMISSIONS_V2_COMPANY_ACTIVATION` | off | Lets administrators move a company to `active` |
| `PERMISSIONS_V2_ENFORCEMENT` | off | Lets active companies' V2 rules restrict requests |

Turning any switch off never widens access.

## Database

`migrations/20261107_001_permissions_v2_policy_mode_audit.sql` is an additive follow-up to the shadow migration. It only widens the audit `subject_type` check to accept `policy_mode`. Apply it after the shadow migration, under the same staging procedure. Until both are applied the V2 endpoints answer as before (`503 ACCESS_POLICY_SCHEMA_REQUIRED` for policy storage) and effective reads fall back to legacy decisions.

## Verification

| Check | Command |
|---|---|
| Evaluator, switches, administrator guard, route matching, middleware | `npx vitest run tests/access-control-v2-effective-permissions.test.ts` |
| Real app and PostgreSQL: canonical `/me`, admin preview scope, activation, stale revisions, deny-only enforcement, rollback, hard limits, last Admin, self role change, concurrent demotion | `npx vitest run tests/access-control-v2-effective-permissions-http.test.ts` |
| Both migrations on a throwaway cluster with forced row-level security, plus the store's mode changes and effective reads | `npm run verify:permissions-shadow-migration` |
