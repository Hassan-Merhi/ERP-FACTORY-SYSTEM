# Permissions Control Center — ERP + Factory
Status: Planning baseline (not wired to production permissions)
Branch: `feature/permissions-control-center`

## Goal
An in-app, company-scoped control center in Settings > Users & Permissions to manage **role templates** and **per-user exceptions**, with a single explicit matrix for **View / Create / Edit / Delete / Approve-Finalize / Reverse-Void / Import / Export / Manage Settings** across ERP, Factory, Retail/POS, Rentals/Properties and Supplier Partner where applicable.

The requested new **Create Only** role can read operational data and add permitted **new** records but cannot alter, delete, void, reverse or approve/finalize previously existing records (including its own). **Create** means strictly creating a new entity. It does not imply permission to modify the state of an existing object or to execute a correction.

### Current state confirmed from main
- Roles use company-scoped `user_company_roles` with Developer, Admin, Owner, Manager, POS, Normal User, View Only and ERP Tester.
- Role-level `role_feature_permissions` includes module/page/tab/action/sensitive/export/pos booleans. Semantics differ: Normal User deny by default; Owner/Manager/POS allow by default.
- Per-user ERP and Factory page access, Factory tab grants, hidden cost fields and other role/location flags live in separate systems.
- There is a global View Only mutation guard; operational route policies and special accounting/security boundaries are spread across route families.
- Existing manager `daybookEditDays=0` is **not** equivalent to no-edit privilege. Avoid reusing date windows as Edit permissions.
- Existing protected controls (company isolation, owner voucher/account delete restrictions, POS location restrictions, privileged repairs, closed periods, CSRF) must stay in force.

## UX — Settings > Users & Permissions
1. **Role Templates** — choose company then role, filter by ERP/Factory/Retail/Properties/Supplier Partner; search modules/pages/actions; unified cells **Allowed / Denied / Inherited** (same meaning for all roles). Bulk allow/deny per module and per verb, with impact preview.
2. **User Access** — assign one active role per company; see effective, read-only preview of every permission; optional per-user exceptions, each with source (system lock, role, user override, location scope); explicit "reset to role" action.
3. **Role Builder** — Create Only as a built-in template; ability to duplicate approved operational templates and name custom roles in later phases. Developer/Admin are system-managed roles, not cloneable paths to privilege escalation.
4. **Audit** — actor, affected user/role/company, old/new grants, timestamp, reason; log attempted forbidden operations and allow filtering.
5. **Safety preview** — "View as user" simulator that evaluates effective permissions server-side without impersonating/performing actions. Show how many users a role edit affects.
6. No toggle should visually suggest success until persisted by server; preserve keyboard accessibility, mobile layout, and English/Arabic/French labels.

### Example per-feature matrix
| Area | View | Create | Edit | Delete | Approve/Finalize | Reverse/Void | Import | Export |
|---|---|---|---|---|---|---|---|---|
| ERP Vouchers | ✓ | ✓ | ✕ | ✕ | ✕ | ✕ | explicit | ✓ |
| ERP Suppliers / Customers | ✓ | ✓ | ✕ | ✕ | n/a | n/a | explicit | ✓ |
| Inventory / Transfers | ✓ | new transfer request | ✕ | ✕ | ✕ | ✕ | explicit | ✓ |
| Factory Mix / Production | ✓ | new plan/batch | ✕ | ✕ | explicit | ✕ | explicit | ✓ |
| Factory Containers | ✓ | new container | ✕ | ✕ | ✕ | ✕ | explicit | ✓ |
| Analytics / Accounting balances | ✓ | n/a | ✕ | ✕ | n/a | n/a | n/a | ✓ |
| Users / Settings / Maintenance | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ |

Table is the *Create Only* default proposal. Posting a newly created voucher is a business **Create** only if no existing document or approval workflow is changed; such endpoints need specific analysis. Existing completed/finalized records must never become mutable because of the new role. Cost/profit/bank field visibility is an independent explicit policy, not inferred from ability to view a page.

## Security contract
- Evaluate **authenticated user + active company + company type + location scope + feature + action + resource state** on the server; never trust a supplied role/company/permission in the browser.
- **Hard denials** (tenant isolation, privileged maintenance, protected accounting, closed periods, maker-checker constraints, and any existing restrictive special rules) win over role grants and individual exceptions.
- Effective decision: hard guard => deny; otherwise explicit user override when permitted; otherwise role-company grant; otherwise secure default. Lack of a classified sensitive mutation must **fail closed for new policy**, not become unrestricted.
- An HTTP **POST is not necessarily Create**. PATCH/PUT/DELETE are not the only forms of mutation. Operations that finalize, cancel, reverse, adjust balances, return stock, offload, change allocations, or approve must use their *business action*, regardless of HTTP verb.
- Distinguish safe operational state changes on a new draft from editing an existing approved record; use resource lifecycle/status checks where required.
- All access is per assigned company, no cross-company widening. Preserve POS assigned location/cash restrictions and ERP Tester no-Settings rule.
- Never allow users to give themselves permission grants, escalate to Admin/Developer, modify protected approval controls, or revoke the last company access administrator.
- Separate **View financial/cost data** from View page; default Create Only visibility includes normal operational detail but configure sensitive money fields independently.
- Authentication/profile/heartbeat and narrowly scoped transport routes are lifecycle exceptions, not permissions to mutate ERP data.
- Validate and persist permission edits transactionally and audit the commit. Ensure same-session/other-session changes take effect promptly (revalidation or version invalidation).
- Backwards compatibility: existing live roles must retain the same effective permissions until their company is explicitly migrated to the new matrix. Migration begins in **read-only comparison/shadow mode**; do not silently re-grant denied features.

## Phases
1. **Inventory & unified contract** — enumerate protected API routes and current UI controls; map each to domain/action; define typed permission catalog, role/override precedence, locked actions and default Create Only rules; add parity tests and schema migration plan. No behavior changes.
2. **Storage & effective permission API** — company-scoped role permissions and user overrides; policy versions; transaction/audit; GET effective permissions and preview; backward compatible with existing storage. Database migration idempotent and reviewed before running.
3. **Server-side authorization** — attach business-action checks to ERP, Factory, POS/Retail and Properties endpoints; enforce Create Only and existing hard restrictions; reject direct API edits/deletes/finalize/void/bulk routes; prioritize accounting/stock/containers/payroll.
4. **Role Templates UI** — company/role selector, searchable matrix, bulk per-action controls, inherited vs explicit states, preview before save, role impact count; no hidden inversion of "checked".
5. **User Access UI** — assign role per company, per-user overrides with reset, effective permission breakdown, scope controls, and simulation; add Create Only selection in all role pickers and validators.
6. **Frontend behavior** — one shared `useCan(feature,action)` read model; hide/disable forbidden controls; readable messages; handle permission changes without stale UI.
7. **Verification & migration** — automated allow/deny tests per role, module, company, resource state, API verbs, and direct requests; data-integrity assertions; staging migration with comparison reports and admin rollback.
8. **Release & audit** — draft PR/review, CI/security checks, guarded rollout by company, Render verification, user training, documentation and monitoring. Merge/deploy only after explicit release authorization.

### Acceptance tests for Create Only
- Can sign in to an assigned ERP company and its Factory module if enabled; can list, search, view and export allowed company data.
- Can create a new supplier/customer/stock item/new draft voucher/new factory draft/production input (subject to action-specific safety checks) without unintentionally changing an existing record.
- Cannot edit or delete any previously existing row, including records the user created; cannot cancel, reverse, void, finalize an existing container, change pricing, change a voucher, alter inventory through adjustment, or perform repair/maintenance.
- All forbidden requests return 403 and preserve existing records, vouchers, accounting totals and stock totals; bypass through direct API, bulk import, hidden URL, automation/WhatsApp is not possible.
- Company A grants do not grant Company B access. An admin changing permissions can verify the effective policy before and after saving.
- Existing Owner, Manager, POS, ERP Tester and View Only roles have no permission regression during shadow-mode rollout.

## Non-goals and deployment note
- This planning document does **not** change live permissions, schema, or application behavior.
- No SQL, CI, tests, merge or deployment were executed as part of creating this plan.
- In particular, do not reinterpret the legacy `enabled` booleans or replace the existing authorization in a single cutover.
