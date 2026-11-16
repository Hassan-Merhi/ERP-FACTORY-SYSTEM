# Manifest-driven access layer

One middleware authorizes every API request from a rule its route declares in
one file. This document is the reference for that layer: how it works, how to
add or change a route's access, what it replaced, and what it deliberately
leaves alone.

- Declarations: `config/route-access-manifest.json`
- Enforcement: `server/security/access/manifestAccessBoundary.ts`
- Gate: `tests/route-access-manifest.test.ts` (`npm run verify:route-access-coverage`)

## Why

Access rules used to be spread over 57 separately mounted middlewares, each
re-deriving "what does this URL need?" from its own path table:

- 38 `requireModuleAccess` prefix mounts, 14 action-permission prerequisite
  routes, one action mount and 4 export mounts in
  `server/routes/core/permissionBoundaryRoutes.ts`;
- the operational-permission table and middleware;
- tenant isolation with five hard-coded path exception lists, plus an Express
  `:companyId` parameter hook;
- privileged-maintenance, permissions V2, Factory company pin, Factory
  page/tab access, shared Factory access, cost-center page access, five admin
  company-scope mounts and a composite of resource-ownership guards.

Whether a check applied to a route depended on where its registrar happened to
be called relative to each mount. Nothing listed a route's access in one place,
and nothing failed when a new route was registered with none.

## How it works

`registerTenantIsolationBoundary` mounts `manifestAccessBoundary` once, ahead
of every API registrar. For each `/api` request it:

1. **Resolves the rule.** The manifest is compiled at start-up with the same
   path semantics as the router (case-sensitive, optional trailing slash). No
   matching rule means `404 API_ROUTE_NOT_FOUND` before any handler or later
   middleware runs. An invalid manifest stops the server from starting.
2. **Lets signed-out requests through** to the route's own `requireAuth`, which
   answers 401, or to a route declared `public`.
3. **Binds the company** (`companyScopeStage.ts`): reads the caller's role in
   the bound company from the database, refuses a caller-supplied company ID
   the rule does not allow, and opens
   the tenant runtime context and database scope that row-level security reads.
4. **Runs the rule's checks** inside that scope, in this order:
   `permissions-v2`, `privileged-maintenance` → module permission keys → the
   other policies → company-role rule → remaining permission keys →
   `factory-page-access`, `admin-company-scope` → the `:companyId` URL
   parameter.
5. Calls `next()`. Any refusal is sent by the stage that refused; any thrown
   error goes to the error handler. Nothing falls through to the handler.

### Which rule governs a request

A request can reach more than one registration. Two rules keep the answer the
same as the path-based checks this layer replaced:

- **Duplicates merge.** Registrations of the same method and path run as
  prerequisites of one another (`next()` / `next("route")`), so their rules are
  merged: every permission key and policy of every duplicate applies; a
  cross-company allowance or permission bypass holds only if all of them
  declare it.
- **The most specific route governs.** When a literal route and a parameter
  route both match (`/api/pos/shifts/current` and `/api/pos/shifts/:id`), the
  literal one governs, whichever was registered first.

`HEAD` uses the `GET` rule when no `HEAD` route exists. A method with no rule
of its own (`OPTIONS`) is matched on the path.

## The declaration

One line per registration, in registration order:

```json
{"id":"POST /api/stock-items/import#1","guards":"requireAuth > requireNonPOS > multerMiddleware > <anonymous>","auth":"session","companyScope":"active-company","roles":{"session":{"deny":["POS"]},"company":{"deny":["POS","View Only","Create Only"],"reason":"operational-task"}},"permission":["mod_inventory","act_import_data"]}
```

| Field | Meaning |
|---|---|
| `id` | `METHOD /express/path#n`. `n` numbers registrations of the same method and path in order. |
| `guards` | The registered handler chain. A changed chain fails the gate until the rule is reviewed. |
| `auth` | `session`, `public`, `service-token`, `signed-token`, or `inherited` (a prerequisite that always continues to a later, authenticated registration of the same route). |
| `companyScope` | `active-company`, `pinned-company` (Factory/Properties), `request-resolved` (decided from the URL: ERP container aliases under `/api/factory`, Factory training media), `context-optional` (sign-in, company picker, health), `none` (never reaches the session boundary). |
| `crossCompany` | Optional reviewed allowances: `authorized-companies`, `reference-read`, `developer-role-administration`, `developer-user-location`, `account-migration-source`. Without one, a company ID in the query, body or URL must equal the bound company. |
| `roles` | `"any"`, or `session` and/or `company` rules. `session` is enforced by the route's own `requireRole`/`requireNonPOS` guards against the session role; the gate proves the declaration equals the chain. `company` is enforced by the boundary against the caller's database role in the bound company. |
| `permission` | `"none"`, or permission keys from `shared/permissionConfig.ts`. `{ "key": …, "bypassRoles": [...] }` lets the listed roles pass that one key. |
| `policies` | Optional named resolvers, listed in evaluation order. |

`roles.session` allow-lists are literal: `requireRole` always admits Developer
and admits ERP Tester wherever Manager is admitted, and the declaration writes
both out.

### Named policies

A policy is a reviewed domain authorization function for a decision that needs
more than the route: the owning company of the record in the URL, request-body
values, Factory page/tab assignments. `accessPolicies.ts` maps each name to
its resolver. A route runs a policy only if its rule lists it.

| Policy | Resolver | Decides |
|---|---|---|
| `permissions-v2` | `middleware/permissionsV2Enforcement.ts` | Deny-only V2 matrix for companies that activated it (off unless `PERMISSIONS_V2_ENFORCEMENT=enabled`). |
| `privileged-maintenance` | `middleware/privilegedMaintenanceScope.ts` | `administration.repair` named permission plus the privileged mutation rate limit. |
| `shared-factory-access` | `middleware/sharedFactoryAccessBoundary.ts` | Factory page ownership of shared accounting surfaces for Factory-mode and Factory-only callers. |
| `cost-center-page-access` | `middleware/costCenterErpPageAccess.ts` | ERP Accounts page assignment. |
| `factory-company-pin` | `security/access/factoryCompanyPin.ts` | Chooses the pinned Factory company from the caller's memberships, or refuses. |
| `global-maintenance` | `middleware/globalMaintenanceScope.ts` | Developer-only (Admin for account migration) global maintenance. |
| `intercompany-configuration` | `middleware/intercompanyConfigurationScope.ts` | Membership of both companies of an intercompany link. |
| `user-location-configuration` | `middleware/userLocationConfigurationScope.ts` | Target user and locations belong to the company in the URL. |
| `company-user-administration` | `middleware/companyUserRoleScope.ts` | Which users, sessions and role assignments an administrator may see or change. |
| `company-resource` | `middleware/companyResourceScope.ts` | The record named in the URL belongs to the bound company. |
| `deleted-item` | `middleware/deletedItemCompanyScope.ts` | A deleted record being restored or purged belongs to the bound company. |
| `global-transaction` | `middleware/globalTransactionCompanyScope.ts` | The voucher belongs to a company the caller can access. |
| `factory-page-access` | `middleware/factoryBackendAccessBoundary.ts` | Factory page/tab permission, including rules that depend on request data. |
| `admin-company-scope` | `middleware/adminCompanyScopeGuard.ts` | A company ID on an admin surface equals the bound company. |

## Adding or changing a route

1. Register the route.
2. Run
   `UPDATE_ROUTE_ACCESS_MANIFEST=1 npm run test:backend -- tests/route-access-manifest.test.ts`.
   It keeps every existing declaration, re-reads what the chain decides
   (`guards`, session authentication, `roles.session`, chain permission keys)
   and writes a rule for the new route from the conventions for its URL.
3. Read the new rule in `config/route-access-manifest.json` and declare what
   the conventions cannot know: a cross-company allowance, an import/export
   permission, a company-role restriction, a policy. A route with no
   `requireAuth`/`requireLogin` is written with `"auth": "UNDECLARED"`, which
   is invalid until you choose `public`, `service-token`, `signed-token` or
   `inherited`.
4. `npm run verify:route-access-coverage` must pass.

Do not mount a scope or permission middleware with `app.use()`. The gate fails
on a `requirePermission` mount and on any retired middleware being mounted
again.

### What the gate fails on

- a registered route with no rule; a rule with no route; a duplicate rule;
- rules out of registration order;
- a handler chain, session authentication or role guard that no longer matches
  its rule;
- an unknown scope, role, permission key or policy; an invalid combination
  (a permission on a route with no company scope);
- a rule weaker than the conventions for its URL: the module permission of its
  prefix, the pinned company and both Factory policies under `/api/factory`,
  `cost-center-page-access`, `privileged-maintenance` on maintenance mutations,
  `company-resource` on company-owned records, `permissions-v2` where a V2
  business action exists;
- an import/export/print/repair-looking route with no operational permission
  and no recorded exemption (`tests/operational-permission-declarations.test.ts`);
- the boundary missing, mounted twice or mounted with a prefix; a retired
  middleware or a permission mounted with `app.use()`;
- a `delegated` / `UNDECLARED` placeholder.

Reviewed exceptions are listed with their reason in `CONVENTION_EXEMPTIONS`
(`tests/helpers/routeAccessVerification.ts`) and `REVIEWED_UNGUARDED_ROUTES`
(`tests/operational-permission-declarations.test.ts`).

## What it replaced

| Former mechanism | Now | Code |
|---|---|---|
| 38 `requireModuleAccess` prefix mounts | `permission: ["mod_…"]` on each route | mounts and file removed |
| 14 action prerequisite routes, 1 action mount, 4 export mounts | `act_…` / `exp_…` keys on each route | removed |
| `operationalPermissionScope` + `operationalPermissionRoutePolicy` table | `permission` keys, `bypassRoles`, `roles.company` | both files removed |
| `tenantIsolationBoundary` and its 5 path exception lists | `companyScope` / `crossCompany` + `companyScopeStage.ts` | file removed |
| `app.param("companyId", tenantCompanyParamBoundary)` | boundary authorizes the matched `:companyId` | removed |
| `permissionsV2Enforcement`, `enforcePrivilegedMaintenanceScope` mounts | policies | no longer mounted |
| `enforceSharedFactoryAccess`, cost-center mount, Factory pin, `enforceFactoryBackendAccess` mounts | policies | no longer mounted |
| Composite mount (company user role → global maintenance / intercompany / user location, company resource, deleted item, global transaction) | seven separate policies | mount removed; the chained calls inside `companyUserRoleScope` removed |
| 5 `enforceAdminCompanyScope` mounts | policy | no longer mounted |

`config/route-manifest.json` went from 142 middleware mounts to 85 and from
2,439 routes to 2,425 (the 14 prerequisite routes).

### Kept as independent controls

These are not access rules and stay where they are:

| Control | Why it stays |
|---|---|
| `requireAuth`, `requireLogin`, `requireRole`, `requireNonPOS`, `requirePasswordConfirmation`, passkeys | Authentication and session validity. Run once, in the route chain; the manifest records and the gate verifies them. |
| Webhook bearer token (`POST /api/stock-transfer-order/wa-approval/webhook`) | Machine authentication, registered ahead of the boundary; declared `service-token`, `companyScope: none`. |
| `browserMutationFailClosedBoundary`, CSRF, origin guard, API rate limits | Request security. |
| `blockViewOnlyWrites`, `blockUnverifiedCreateOnlyWrites`, `blockErpTesterSettings` | Global session-role write guards mounted in `server/index.ts`. |
| Row-level security, `runWithDatabaseScopeRuntimeContext`, `assertTransactionCompanyScope`, `poImportDatabaseScopeContinuityBoundary` | Database isolation. The boundary opens the scope; the database enforces it. |
| `enforcePosOperationalPermissionScope`, `enforcePosCapabilityScope`, `checkPOSLocation`, `enforcePosInventoryCostBoundary` | POS location/cash-account/capability checks. They rewrite `req.user` from live data and must run after `requireAuth`, so they cannot move in front of it. |
| SP access control (`/api/sp`), SP migration guards | Supplier-Partner module lifecycle and cutover state. |
| `enforceUnifiedAccountingRollout`, `retailManualVoucherBoundary`, protected-correction boundary, `enforceOfflineOperationScope`, historical-currency and FX guards | Business invariants and rollout gates. |
| Handler-level role checks | Remain in the handlers. Not lifted into the manifest. |

## Behaviour differences from the former middlewares

Decisions are the same. These are the differences, all in the stricter
direction:

- **Order of refusals.** All checks now run before the business boundaries and
  responder middleware that used to sit between the mounts. A request that two
  checks would refuse may receive the other refusal's code.
- **Role refusal before action key.** For an import or bulk-maintenance route
  that also had an action prerequisite, a denied role now gets
  `OPERATIONAL_ROLE_DENIED` rather than the permission-key refusal.
- **`:companyId` on lazily loaded routers.** In production the Git,
  container-tracking and other lazy modules are mounted on private routers
  that the Express parameter hook never covered. The boundary authorizes
  `:companyId` from the manifest, so `/api/git/agent-*/:companyId/...` now
  requires the parameter to equal the bound company in production as it
  already did in development and tests.
- **Non-numeric IDs on two purchase-order routes**
  (`PATCH /api/purchase-orders/:id`, `/api/purchase-orders/:id/sync-parent-voucher`).
  The authorized-companies database scope applies to the route, where it used
  to require a numeric ID. Handlers reject non-numeric IDs.
- **Fast responders.** A cached Factory read that answered ahead of the Factory
  page boundary is now checked first.
- **Undeclared URLs** get 404 at the boundary instead of at the API fallback.
  A signed-in request still passes the company and role checks first, so a
  role refused a whole URL family (settings for ERP Tester, writes for View
  Only) keeps that refusal.
- **Chain permission guards** (`requirePageAccess` and friends on a route) are
  also enforced by the boundary, so both must pass.
- **Path-word matches from parameter values** (a parameter whose value is
  `repair`) no longer trigger the maintenance check; the route's own words do.

## Findings recorded during the migration

Kept as they behaved and listed for the owner to decide:

- `POST /api/factory/accounts/:accountId/send-statement-whatsapp` was
  registered ahead of the Factory page boundary and has no Factory page owner.
- The fast POS WhatsApp senders (`/api/pos/send-stock-pdf*`,
  `/api/pos/send-invoice-pdf-backend`, `/api/pos/send-whatsapp-pdf-upload`)
  were listed for an export permission that was never enforced, because they
  were registered ahead of the operational middleware.
- Five import-template downloads and `POST /api/user-presence/leave` have no
  session guard. They are declared `public`, as they behave.
- `GET /api/locations` and `GET /api/ledger-accounts` declare the
  `reference-read` allowance, and the boundary honours it, but the route's own
  `requireAuth` explicit-company check still refuses an Admin reading another
  member company. That was already the case before this change.
- `/api/git/agent-*/:companyId/...` handlers read `companyId` from the URL
  without their own check. The boundary now covers them; the handlers should
  also resolve the company from the session.

Earlier phase documents (`permissions-control-center-phase1.md`,
`permissions-control-center-phase3-route-review.md`, the Factory dispatch and
cost-center phase notes) describe the middleware as it was when they were
written and still name the files this layer replaced.

## Current numbers

2,425 rules, none delegated: 2,407 `session`, 12 `public`, 3 `inherited`,
2 `signed-token`, 1 `service-token`. 1,412 `active-company`, 988
`pinned-company`, 9 `request-resolved`, 14 `context-optional`, 2 `none`.
1,629 rules declare a permission key, 751 a session-role rule, 165 a
company-role rule, 1,359 at least one policy, 25 a cross-company allowance.

## Tests

| Suite | Covers |
|---|---|
| `tests/route-access-manifest.test.ts` | Coverage, order, chain drift, schema, conventions, boundary mount, and rejection of deliberately broken manifests. |
| `tests/operational-permission-declarations.test.ts` | Import/export/maintenance declarations and the reviewed exemptions. |
| `tests/access-boundary-company-scope.test.ts` | Company binding, caller-supplied IDs, each cross-company allowance, `:companyId`, context errors. |
| `tests/access-boundary-http.test.ts` | End to end against the real route stack and database: 401/404, company isolation, record ownership, module and operational permissions, role rules, Factory company, privileged maintenance. |
| `tests/manifest-access-boundary.test.ts` | Resolution (duplicates, specificity, HEAD, undeclared), role and permission stages, policy order, fail-closed behaviour. |
| `tests/operational-permission-scope-http.test.ts`, `tests/access-control-v2-effective-permissions.test.ts`, `tests/privileged-maintenance-route-policy.test.ts` and the module suites | End-to-end behaviour against the database. |
