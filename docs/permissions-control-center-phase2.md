# Permissions Control Center — Phase 2 API and storage handoff

**Branch:** `feature/permissions-control-center`; draft PR **#2480**.
**Release state:** Shadow only. New rules are NOT consulted by live authorization.
**Database state:** The additive SQL migration is committed but **not executed**.

## Deliverables

1. `migrations/20261024_001_permissions_control_center_shadow.sql`
   creates 5 company-scoped tables with strict foreign keys, unique constraints,
   FORCE ROW LEVEL SECURITY and append-only audit protection:
   - `access_role_templates`
   - `access_role_rules`
   - `access_user_overrides`
   - `access_policy_versions`
   - `access_policy_change_audit`
2. `shared/schema/accessControlV2Storage.ts` represents the tables in Drizzle.
3. `server/services/security/accessControlV2Store.ts` provides read-only
   preview and versioned transactional writes with a permanent per-company audit.
4. `server/routes/admin/permissionControlCenterRoutes.ts` adds seven guarded
   endpoints through `server/routes/adminRoutes.ts`.
5. `tests/access-control-v2-phase2-store.test.ts` pins revision conflicts,
   protected role behavior, transaction/audit consistency, and company membership.
6. `config/ci-ratchet-allowances.json` describes seven exact intentional
   new API route registrations; the original route manifest remains the
   old baseline and is not rewritten to hide unrelated route changes.

## API contract

All requests require authentication plus the **canonical active-company
Admin or Developer role**. Company is resolved server-side; clients must NOT
send a company ID to any V2 mutation or preview.

| Endpoint | Purpose |
|---|---|
| `GET /api/permissions-v2/catalog` | Typed business resources, actions and configurable built-in roles; no migration needed |
| `GET /api/permissions-v2/roles` | Stored templates, proposed role rules and company revision |
| `GET /api/permissions-v2/users/:userId/overrides` | Company-member-only proposed individual rules |
| `GET /api/permissions-v2/preview?resource=erp.vouchers&action=create&role=Create%20Only` | Shadow-only diagnostic; includes provisional verified-route outcome and a **coarse legacy module** comparison (not an authorization result) |
| `GET /api/permissions-v2/audit?limit=25` | Append-only company policy change history, maximum 100 records |
| `PUT /api/permissions-v2/role-rules` | Batch role rule save with optimistic concurrency and atomic audit |
| `PUT /api/permissions-v2/user-overrides` | Batch member-specific rules, preventing self-escalation and administrator overrides |

Example request (never modifies current ERP permissions):

```json
{
  "roleKey": "Create Only",
  "expectedRevision": 0,
  "reason": "Restrict modifications in Factory workflow",
  "changes": [
    {"resource": "factory.containers", "action": "edit", "decision": "deny"},
    {"resource": "factory.containers", "action": "create", "decision": "allow"}
  ]
}
```

The server enforces max 100 unique changes per batch; all resources/actions and
`allow/deny/inherit` must be from the shared typed catalog. Responses
include `revision`, `mode: "shadow"` and `applied`. A concurrent update
produces `409 POLICY_STALE_REVISION`; refresh before trying again.
User rules additionally require `user_id` to exist in that same company
before or inside the transaction. Admin/Developer templates cannot be edited;
untrusted users cannot grant System/Repair rights, and Create Only cannot
be given protected mutation rights by a role or user override.

### Effective preview is deliberately NOT permission enforcement

Preview reports the legacy **module** result separately from the proposed
shadow policy. It does not know all legacy page/tab/location controls or
route-level hard denials. `hypotheticalIfHandlerVerified` is a proposed
decision **under an explicit hypothetical**; `currentlyEnforcedByV2=false`
and `routeVerified=false` always. Do not use the preview response as
permission to execute a business API request.

### Storage and auditing

The insert/update of each rule, company revision increment and
before/after JSON audit row commit inside the same transaction. Company
writers serialize on `access_policy_versions ... FOR UPDATE`, protecting
against lost updates. Stale revision rejects before writing business rules.
Policies are scoped by active-company RLS, plus explicit per-company SQL
predicates. No live `role_feature_permissions`, vouchers or stock rows
are modified.

### Migration execution

The migration is **not** registered as an automatic startup repair: do not
silently roll it out on Render. Before applying, take a verified database
backup and verify `erp_company_scope_matches(integer)` is installed. Run
the reviewed migration once on staging, verify all five tables and FORCE RLS,
and separately approve production installation. The migration is additive,
idempotent, and does not grant user access. Missing tables make mutation/read
endpoints return `503 ACCESS_POLICY_SCHEMA_REQUIRED`; the catalog endpoint
remains available.

Rollback before activation: simply stop use of the shadow endpoints and leave
the new tables untouched. **Never drop** policy audit history or remove
company-scoped RLS to resolve an error. To reverse a staged policy change,
resubmit the prior decisions from audit as a new versioned, audited batch;
do not delete audit entries. An automated historical rollback UI may be added
after the permissions matrix is available.

### Gate to Phase 3

- Complete handler-side-effect review and explicit verification of each
  business API route; the Phase 1 112 mappings remain **candidate**.
- Preserve current role defaults, hard denies, company boundaries,
  financial approval policies and closed-period enforcement.
- Do not activate Create Only or mark PR ready for merge before
  the Phase 3 server guards and Phase 4–7 UI and security verification.

### Verification disclosure

Source and unit test cases committed. Database migration was NOT executed.
Direct API smoke tests in a migrated environment and full CI certification
remain outstanding.
