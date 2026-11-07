# Permissions Control Center — Administrator Guide

**Scope:** day-to-day administration of company roles and the V2 permission matrix. Today the V2 matrix runs in **shadow mode**: it is reviewed and audited, but it does not change anyone's live permissions until the owner approves activation for a specific company. Company roles (the Company Roles editor) are live and work as before.

Related: [effective permission engine](permissions-v2-effective-engine.md) · [activation runbook](permissions-control-center-activation.md) · [staging certification](permissions-v2-staging-certification.md) · [frontend page audit](permissions-v2-frontend-page-audit.md).

## 1. Assign company roles (live)

1. Sign in as **Admin** (or Developer) of the company and confirm the active company in the top bar.
2. Open **Settings → Users & Permissions → Company Roles** and pick the person.
3. Choose one role for this company: Owner, Manager, POS (needs an assigned location and cash account), Normal User, View Only, ERP Tester, or Create Only (only when the operator has enabled assignment).
4. Save. The change is audited and the person's other sessions are signed out, so the new role applies at once.

Rules the server enforces:

- Only a Developer can grant the Developer role, and Admins cannot change Developer accounts.
- You can only assign roles in the company you are working in.
- You cannot change or remove **your own** role. Ask another administrator. (`SELF_ROLE_CHANGE_FORBIDDEN`)
- A company's **last Admin** cannot be demoted, removed or deleted. Assign a second Admin first. (`LAST_COMPANY_ADMINISTRATOR`)

## 2. Configure role templates (V2, shadow)

1. Open **Role Templates**, choose a role and filter by ERP, Factory, Retail, Properties or Supplier Partner.
2. Each cell is **Allow**, **Deny** or **Inherit**. `Inherit` adds no V2 rule; it does not grant anything.
3. Change cells, write a reason (at least 10 characters), **Review** the diff and the number of affected people, then save.
4. Admin and Developer templates cannot be edited. Protected system actions (user management, settings, maintenance) cannot be allowed. Create Only cannot be given edit, delete, approve, finalize, void, reverse or import rights.
5. If another administrator saved first you get **409 stale revision**. Reload, compare, and review again.

Rules can only be edited while the company is in shadow mode. To change an active company's rules, move it back to shadow first (section 8).

## 3. Apply individual overrides (V2, shadow)

1. Open **User Access**, pick a company member.
2. Change the cells you need for that person only, give a reason, review and save. **Reset visible to role** stages `Inherit` for the visible cells.
3. You cannot save overrides for yourself or for Admin/Developer members.
4. An override can only narrow access once V2 is active. An `Allow` never gives more than the person's role already allows today.

## 4. Preview effective permissions

In **User Access**, choose a resource and action under **View as user**:

- **Effective now** is what the server decides today for that person, and why: *current role permissions*, *system restriction*, *system role* or *active V2 rules*.
- The line above it is the **proposed** V2 decision from role rules and overrides.

When they differ, activating V2 would change that person's access. Every person can see their own effective permissions through `GET /api/permissions-v2/me`. The preview never impersonates anyone and never runs an action.

## 5. Review audit logs

**Permission change audit** shows, for the active company, the newest 100 changes: revision, time, administrator, subject (role, user or `policy_mode`), reason and each changed cell before and after. Activation and rollback appear as `policy:mode shadow → active`. The log is append-only; nobody can edit or delete entries, including in the database.

Company role changes are also in the general audit log (`user_company_roles`).

## 6. Manage Create Only users

Create Only users browse company data like View Only and can add only these new records: suppliers, customers, stock items, Factory bale batches and customer orders, rental units and contracts, retail products and supplier-partner sales. They cannot edit, delete, approve, void, reverse, finalize, import or bulk-change any existing record, including records they created, and they can only date records today. Money and cost fields stay hidden unless you enable them for the role.

In the app, pages that only change existing records show "This page is not available to your role", and voucher edit links open the read-only voucher view. **Create Master Data** shows them only the supplier and stock item forms.

Assigning the role stays off until the release is approved. Follow [the activation runbook](permissions-control-center-activation.md) for the pilot.

## 7. Troubleshooting permission errors

| Message or code | Meaning | What to do |
| --- | --- | --- |
| "This page is not available to your role" | View Only or Create Only opened a page that changes existing records | Expected. A person with an editing role must do it |
| `VIEW_ONLY_WRITE_DENIED`, "View Only accounts cannot make changes" | The person's current role is View Only | Expected. Check Company Roles if this is wrong |
| `BUSINESS_ACTION_NOT_VERIFIED` | A Create Only user tried something other than an approved new record | Expected |
| `BUSINESS_ACTION_DENIED` | A Create Only form carried a refused field (opening balance, opening stock, backdated contract, another company) | Create the record without it; an editing role adds balances later |
| `PERMISSION_V2_DENIED` | The company's active V2 rules refuse this action | Check **Effective now** in User Access; adjust rules (section 8) |
| `PERMISSION_SERVICE_UNAVAILABLE` (503) | V2 is enforcing and the policy could not be read | Retry; if it persists, roll back the company (section 8) and check database health |
| `ERP_TESTER_SETTINGS_DENIED` | ERP Tester tried settings or user administration | Expected |
| `SELF_ROLE_CHANGE_FORBIDDEN` | You tried to change your own role | Ask another administrator |
| `LAST_COMPANY_ADMINISTRATOR` | The change would leave the company without an Admin | Assign another Admin first |
| `POLICY_STALE_REVISION` (409) | Someone else saved first | Reload and review again |
| `PERMISSIONS_V2_ACTIVATION_NOT_AUTHORIZED` (409) | Activation is switched off by the operator | Expected until the release is approved |
| `CREATE_ONLY_ASSIGNMENT_NOT_ACTIVATED` (409) | Create Only assignment is switched off | Expected until the release is approved |
| `ACCESS_POLICY_SCHEMA_REQUIRED` (503) | The V2 migration is not applied here | Request the reviewed staging migration; never run SQL in production yourself |
| Create Only missing from the role picker | Assignment switch is off | Expected |

Open tabs refresh their access automatically when the server refuses something for a permission reason, and on focus.

## 8. Activate and roll back a company (after release approval only)

Activation needs two operator switches (`PERMISSIONS_V2_COMPANY_ACTIVATION` and `PERMISSIONS_V2_ENFORCEMENT`) that stay off until the owner approves. Then, for one pilot company:

1. In shadow mode, set the role rules and overrides and check **Effective now** for the affected people.
2. Activate: `PUT /api/permissions-v2/activation` with `{"mode": "active", "expectedRevision": <current>, "reason": "…"}`.
3. Watch the monitoring (section 9) for one business day before widening.

**Rollback** works at any time, without a deploy and without the activation switch:

- `PUT /api/permissions-v2/activation` with `{"mode": "rolled_back", …}` (or `"shadow"` to edit rules again). Legacy permissions apply again on the next request.
- To stop V2 for every company at once, the operator unsets `PERMISSIONS_V2_ENFORCEMENT` and restarts.
- Never delete `access_*` tables or audit rows, and never reverse posted vouchers to hide a discrepancy.

## 9. Monitoring

`GET /api/permissions-v2/monitoring` (company Admin/Developer) shows counts since the server started for: permission denials, unexpected 403s, cross-company attempts, failed role assignments, repeated forbidden changes (5 in 10 minutes by one person on one route), policy revision conflicts, permission service errors, policy changes and V2 enforcement denials, plus integrity events and whether alerts are routed.

Each signal is also a structured log line (`event: "permission_signal"`). Cross-company attempts, repeated forbidden changes, permission service errors and business integrity discrepancies are raised as operational events and reach the alert destination (`LOG_ALERT_WEBHOOK_URL`) when the operator configures it. Logs never contain passwords, tokens, cookies, request bodies or query strings.

Treat a sudden rise in denials, any cross-company attempt from a staff account, or any unexplained change in voucher, stock, container or payroll totals as an incident: roll the company back first, then investigate.

## Operational security

- Do not put credentials, personal data, vouchers or bank details in change reasons.
- Do not share elevated access or approve your own changes.
- Keep a protected backup and the audit trail before any rollback.

## Release handoff

The gate registry is `config/permissions-v2-release-readiness.json`. Every gate needs independently verifiable evidence; staging gates need staging evidence; production needs separate explicit owner approval. A green CI run alone never verifies a gate.
