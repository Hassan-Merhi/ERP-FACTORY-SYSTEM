# Permissions Control Center — Phase 1 completion handoff

**Scope:** architecture, inventory, typed policy and shadow-only contract.
**Branch:** `feature/permissions-control-center` (draft PR #2480).
**Production impact:** zero. There is NO new selectable role, active middleware, settings UI or database migration in Phase 1.

## 1. Inventory evidence

The existing ordered manifest `config/route-manifest.json` records **2,239 registered Express routes** and **137 middleware mounts**. At the Phase 1 snapshot it includes:

- 1,009 GET, 2 HEAD, 1 OPTIONS and **1,227 potentially mutating** route registrations (including uncommon methods).
- 112 unique **candidate** business route/action mappings in `config/access-control-v2-route-review.json`, matching 135 registrations in the ordered manifest; duplicates are not mistaken for separate authorization decisions.
- **1,092 potentially mutating registrations remain unreviewed**, including routes that perform bulk mutation, repair, import and status changes. This is an explicitly tracked, fail-closed **Phase 3** queue, NOT an approval to activate Create Only.
- All candidate routes were checked to occur in the existing registered route manifest. The exact route signature includes HTTP method and the Express path with `:id` segments, not any URL prefix guessed from user input.

Run `node scripts/audit-access-control-v2-routes.mjs --json` to enumerate every registered route and its current classification. Default output summarizes domains, possible writes, unknown routes and stale candidate signatures. `--strict` is an **enforcement readiness** guard and is expected to FAIL until Phase 3 verifies handlers and closes the unreviewed write queue. Do not delete or weaken this failure to make CI green.

**Important:** a GET can expose privileged information or trigger legacy side effects. No GET is automatically granted by the route inventory. The new Create Only policy also demands verified handler evidence before granting views/exports.

## 2. Existing permissions and UI owner inventory

| Existing source | Stores or controls | Target V2 interpretation |
|---|---|---|
| `shared/schema/users.ts` / `user_company_roles` | Company role, location, POS cash account, daybook date window and delete flag | One company-scoped role assignment and separate location/account limitations |
| `role_feature_permissions` | Role-specific module/page/tab/action/sensitive/export/POS booleans | Import through compatibility adapter; NEVER invert `enabled` without considering role |
| `shared/permissionConfig.ts` | Current module/page/tab/action/sensitive/export/POS catalog | Candidate source for browsable role templates, distinct from V2 business actions |
| `shared/factoryPermissionCatalog.ts` | Factory tab hide/grant convention | Preserve opt-in and hidden fields until individually migrated |
| `shared/factoryAccessRegistry.ts` | Factory page registry | Map canonical UI pages and legitimate Factory module availability |
| `client/src/pages/settings/PageVisibilityTree.tsx` | Legacy Owner/Manager page switches | Replace UI once parity is demonstrated |
| `client/src/components/AdvancedRestrictionsPanel.tsx` | Legacy role checkbox inversion | Replace with explicit Allow / Deny / Inherit decisions |
| `client/src/pages/settings/users/AdvancedRestrictions.tsx` | ERP/Factory page selections and cost visibility per user | Preserve as separate visibility grants and sensitive-field boundaries |
| `client/src/pages/settings/users/InlineRoleEditor.tsx` | Company role picker, presets, daybook/edit/delete flags | Add Create Only and effective rights in Phase 5, not Phase 1 |
| `client/src/pages/settings/users/UserRolesCard.tsx` | Per-company assignments | Integrate Phase 5 |
| `server/lib/permissionHelpers.ts` + `permissionMiddleware.ts` | Legacy `enabled` behavior and DB-backed module/action checks | Shadow-evaluate per request, preserve legacy effective result until migration |
| `server/routes/core/permissionBoundaryRoutes.ts` | ERP, Factory and finance module boundaries | Preserve restrictions and add reviewed business-action guards |
| `server/services/security/operationalPermissionRoutePolicy.ts` | Import/export/repair/shift route guards | Map these separately from Create, never treat POST as automatically Create |
| `server/auth.ts` + `server/index.ts` | View Only blocking, ERP Tester restrictions, delete and role checks | Retain existing hard denies and optional transport-only exceptions |
| `server/services/security/activeCompanyPermissionContext.ts` | Canonical current-company role resolution | Required V2 company context; do not trust a session or browser override alone |

Further API surface to review includes POS + Retail, Supplier Partner, Properties/Rental, cost centers, Factory containers, bale explorer, customer orders, raw-stock, production, payroll and the financial posting engine.

### Existing role defaults / security parity

- **Developer / Admin:** current feature-permission helper bypasses role-feature booleans; company isolation, named elevated repair controls and other route-specific checks continue to apply.
- **Owner / Manager / POS / View Only / ERP Tester:** generally allow-by-default in the legacy helper unless explicitly denied; route-specific policies still narrow privileges. Owner has special voucher/account deletion protection (not a universal deny on all deletes). POS has location and shift boundaries. ERP Tester cannot access system configuration.
- **Normal User:** deny-by-default in the legacy helper, explicit `enabled=true` grants access.
- **View Only:** global mutation guard blocks business writes, with exact narrowly approved session/presence transport exceptions.
- Per-user Factory page/tab and cost-field visibility can further limit reads even where role permissions allow.
- **Daybook edit-days = 0** is NOT a general no-edit rule; **canDeleteRecords = false** is NOT a general no-edit rule.

No existing role may change effective access merely because V2 is present in shadow mode.

## 3. Phase 1 contract

`shared/accessControlV2.ts` defines:
- Typed actions: View, Create, Edit, Delete, Approve, Finalize, Void, Reverse, Import, Export, Manage Settings, Manage Users, Repair.
- Typed business resources across ERP, Factory, Retail/POS, Properties and System.
- Three choices per matrix cell: `allow`, `deny`, `inherit`.
- Company assignment and valid company ID enforced first, with an explicit Developer support bypass only for that named role.
- Protected business/accounting/security guard denials always win over role/user grants.
- **Create Only** cannot edit/delete/approve/finalize/void/reverse/import/repair/manage configuration, including items it created itself.
- A purported Create route that actually edits an existing document is denied regardless of endpoint verb.
- Automatic inventory and accounting postings *from a newly created legitimate transaction* may occur, but they require review of that route's full transactional effects.
- An unverified route has `routeVerified !== true` and cannot authorize a new Create Only user even if a role/user override says allow.
- Individual user decision takes priority over role decision ONLY after company scope, hard guards and hard Create Only restrictions.
- Existing roles can be compared by passing the current `legacyAllowed` decision. Missing/unmapped permissions fail closed for the new policy.

**Candidate != verified.** `shared/accessControlV2RouteReview.ts` reads 112 candidate signatures from `config/access-control-v2-route-review.json`. Its exported lookup is for inspection only and never authorizes a request. Phase 3 must inspect actual handlers, downstream posting effects, and the immutable/approval states before converting candidates to enforceable routes.

## 4. Proposed migration/schema specification — Phase 2, NOT executed

Separate from existing tables, introduce versioned, company-scoped capability data:

1. `access_role_templates`: `id`, `company_id`, immutable system `role_key`, display name, `system_managed`, active, timestamps. A unique (company,role_key) constraint; company FK; protected Admin/Developer role family.
2. `access_role_rules`: company + role FK, resource/action keys, `decision` enum (allow/deny/inherit), unique (role_id,resource,action); DB rejects unknown decision values. Explicit deny should be representable without inversions.
3. `access_user_overrides`: company, user id, resource, action, `decision`, unique (company,user,resource,action), FK to an existing company-role assignment. Overrides must not bypass hard locks or create elevated roles.
4. `access_policy_versions`: company, monotonically increasing revision, activated timestamp, activation actor and release state (shadow/active/rolled-back). Compare old and new in shadow mode before switching.
5. `access_policy_change_audit`: append-only company/user/actor, before/after JSON and reason; audit writes commit in same transaction as permission changes. Never save passwords/tokens here.

Migration requirements: company-scoped PK/FKs and relevant row-level policies, indexes on company/role/user, idempotent DDL, no role auto-activation, no destructive rewriting of `role_feature_permissions`, no balance/voucher/stock mutation. New role rows are created only after schema is validated. Per-user overrides should be explicitly company-limited. Stale-session handling: checked policy revisions invalidate stale effective permission caches promptly.

## 5. Next-phase release checklist

- **Phase 2:** implement migration, effective read-only preview and company-scoped Admin APIs; support explicit bulk save, validation, audit transaction and rollback.
- **Phase 3:** enumerate and inspect actual handler side effects for all unreviewed mutations, starting accounting, POS sales/returns, inventory, containers and Factory production. Make the explicit route/business-action map verified; protect special WebDAV/nonstandard methods too. No unknown business write is allowed for Create Only. Check resource-state and company controls under transactional locks.
- **Phase 4–6:** build the matrix and user overrides, update selectors/visibility, and integrate checked permission decisions into every relevant UI action.
- **Phase 7:** run the Phase 1 tests plus full security/direct-API tests; compare old/new authorization by user/company, check financial totals, and reject unexpected differences.
- **Phase 8:** only after review, separately authorize merge, SQL migration and deployment.

## 6. Phase 1 deliverables

- [x] Architecture and phased rollout plan.
- [x] Typed resource/action evaluation (shadow-only).
- [x] Create Only baseline and hard-deny precedence.
- [x] Full-route inventory generator and fail-closed readiness indication.
- [x] Initial 112 candidate route-action signatures (NOT approved for enforcement).
- [x] Existing page/role/permission source inventory.
- [x] Schema/migration design and reversible rollout policy.
- [x] Test sources for policy precedence, route inventory and legacy parity.
- [ ] Actual test execution and handler-level sign-off — scheduled for verification/Phase 3–7, **not claimed as completed**.

**Phase 1 source deliverables complete. Remaining phases are required before any user can select or use Create Only.**
