/**
 * Verification of config/route-access-manifest.json against the live Express
 * stack. Pure functions over data so the same checks can be run against
 * deliberately broken copies of the manifest (see the mutation tests in
 * tests/route-access-manifest.test.ts).
 */
import {
  KNOWN_ROLES,
  parseRuleId,
  permissionKeyOf,
  validateRouteAccessManifest,
  type AccessPolicyName,
  type RoleRule,
  type RouteAccessManifest,
  type RouteAccessRule,
} from "../../server/security/access/routeAccessManifest";
import { classifyCompanyOwnedRoute } from "../../server/services/security/companyResourceRoutePolicy";
import { classifyPrivilegedMaintenanceRoute } from "../../server/services/security/privilegedMaintenanceRoutePolicy";
import { isPinnedCompanyRoute } from "../../server/services/security/activeCompanyPermissionPolicy";
import { matchCandidateAccessControlRoute } from "../../shared/accessControlV2RouteReview";
import { mountCovers, samplePath, type LiveMount, type LiveRoute, type LiveStackEntry } from "./routeAccessStack";

export const ACCESS_BOUNDARY_MOUNT = "manifestAccessBoundary";

/** Guards that authenticate a browser session. */
const SESSION_GUARDS = new Set(["requireAuth", "requireLogin"]);

/**
 * Scope and permission middleware that the access boundary replaced. None of
 * them may be mounted again: a route that needs one of these checks declares
 * the matching policy in the manifest instead.
 */
export const RETIRED_MOUNTS = [
  "tenantIsolationBoundary",
  "permissionsV2Enforcement",
  "enforcePrivilegedMaintenanceScope",
  "enforceOperationalPermissionScope",
  "enforceSharedFactoryAccess",
  "enforceCostCenterErpPageAccess",
  "enforceFactoryBackendAccess",
  "enforceAdminCompanyScope",
  "pinFactoryCompany",
] as const;

/** URL prefix -> module permission every route under it must declare. */
export const MODULE_PERMISSION_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ["/api/factory", "mod_factory"],
  ["/api/pos", "mod_pos"],
  ["/api/properties", "mod_properties"],
  ...["/api/customers", "/api/suppliers", "/api/employees", "/api/purchase-orders", "/api/erp"].map(
    (prefix) => [prefix, "mod_erp"] as const
  ),
  ...[
    "/api/vouchers",
    "/api/voucher-entries",
    "/api/voucher-detail",
    "/api/accounts",
    "/api/ledger-accounts",
    "/api/bank-accounts",
    "/api/fixed-assets",
    "/api/fiscal-period",
    "/api/financial",
    "/api/credit-notes",
    "/api/golden-coast/accounting",
  ].map((prefix) => [prefix, "mod_accounting"] as const),
  ...[
    "/api/inventory",
    "/api/stock-items",
    "/api/stock-groups",
    "/api/bales",
    "/api/containers",
    "/api/locations",
    "/api/pending-barcodes",
    "/api/stock-transfers",
    "/api/stock-transfer-orders",
    "/api/stock-transfer-order/wa-approval",
    "/api/stock-transfer-revisions",
    "/api/stock-summary",
    "/api/offload-item-search",
    "/api/location-price-groups",
  ].map((prefix) => [prefix, "mod_inventory"] as const),
  ...["/api/reports", "/api/stats", "/api/dashboard", "/api/sales-report", "/api/supplier-profit-reconciliation"].map(
    (prefix) => [prefix, "mod_analytics"] as const
  ),
];

function under(prefix: string, path: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function sortRoles(roles: Iterable<string>): string[] {
  const set = new Set(roles);
  return (KNOWN_ROLES as readonly string[]).filter((role) => set.has(role));
}

export function liveRoutes(stack: readonly LiveStackEntry[]): LiveRoute[] {
  return stack.filter((entry): entry is LiveRoute => entry.kind === "route");
}

export function liveMounts(stack: readonly LiveStackEntry[]): LiveMount[] {
  return stack.filter((entry): entry is LiveMount => entry.kind === "mount");
}

function mountsBefore(route: LiveRoute, stack: readonly LiveStackEntry[], name: string): boolean {
  const path = samplePath(route.path);
  return liveMounts(stack).some(
    (mount) => mount.index < route.index && mount.name === name && mountCovers(mount, path)
  );
}

/** True when the route's chain, or a mount in front of it, authenticates a session. */
export function chainAuthenticatesSession(route: LiveRoute, stack: readonly LiveStackEntry[]): boolean {
  return (
    route.guards.some((guard) => SESSION_GUARDS.has(guard)) ||
    [...SESSION_GUARDS].some((guard) => mountsBefore(route, stack, guard))
  );
}

/** The session-role rule the registered chain enforces, or undefined when it enforces none. */
export function chainSessionRoles(route: LiveRoute, stack: readonly LiveStackEntry[]): RoleRule | undefined {
  let allow: string[] | null = null;
  for (const roles of route.requiredRoles) {
    // requireRole always admits Developer, and admits ERP Tester wherever Manager is admitted.
    const admitted = new Set([...roles, "Developer"]);
    if (roles.includes("Manager")) admitted.add("ERP Tester");
    allow = allow ? allow.filter((role) => admitted.has(role)) : [...admitted];
  }
  const deny = route.guards.includes("requireNonPOS") || mountsBefore(route, stack, "requireNonPOS") ? ["POS"] : [];
  if (!allow && deny.length === 0) return undefined;
  return { ...(allow ? { allow: sortRoles(allow) } : {}), ...(deny.length ? { deny } : {}) };
}

function sameRoleRule(left: RoleRule | undefined, right: RoleRule | undefined): boolean {
  const normalize = (rule: RoleRule | undefined) =>
    JSON.stringify({
      allow: rule?.allow ? sortRoles(rule.allow) : null,
      deny: rule?.deny ? sortRoles(rule.deny) : null,
    });
  return normalize(left) === normalize(right);
}

function declaredPermissionKeys(rule: RouteAccessRule): string[] {
  return rule.permission === "none" ? [] : rule.permission.map(permissionKeyOf);
}

/**
 * The declarations a route must carry because of where it lives and what it
 * does. These are minimums: a rule may declare more, never less. They exist so
 * a new route under an existing module cannot be declared with weaker access
 * than its neighbours.
 */
export function conventionProblems(rule: RouteAccessRule): string[] {
  const parsed = parseRuleId(rule.id);
  if (!parsed) return [];
  const problems: string[] = [];
  const path = samplePath(parsed.path);
  const keys = declaredPermissionKeys(rule);
  const policies = new Set<AccessPolicyName>(rule.policies ?? []);
  const companyBound = rule.companyScope !== "none" && rule.companyScope !== "context-optional";
  if (!companyBound || !path.startsWith("/api/")) return problems;
  const exempt = CONVENTION_EXEMPTIONS[rule.id] ?? [];
  const require = (ok: boolean, what: string) => {
    if (!ok && !exempt.includes(what)) problems.push(`${rule.id}: must declare ${what}`);
  };

  for (const [prefix, key] of MODULE_PERMISSION_PREFIXES) {
    if (under(prefix, path)) require(keys.includes(key), `permission ${key} (route is under ${prefix})`);
  }

  const pinned = [path, samplePath(parsed.path, "abc")].map((variant) => isPinnedCompanyRoute(variant));
  if (pinned[0] !== pinned[1]) {
    require(rule.companyScope === "request-resolved", "companyScope request-resolved");
  } else if (rule.companyScope !== "request-resolved") {
    require(rule.companyScope ===
      (pinned[0]
        ? "pinned-company"
        : "active-company"), `companyScope ${pinned[0] ? "pinned-company" : "active-company"}`);
  }

  if (under("/api/factory", path)) {
    require(policies.has("factory-company-pin"), "policy factory-company-pin");
    require(policies.has("factory-page-access"), "policy factory-page-access");
  }
  if (under("/api/cost-centers", path))
    require(policies.has("cost-center-page-access"), "policy cost-center-page-access");
  if (classifyPrivilegedMaintenanceRoute(parsed.method, path)) {
    require(policies.has("privileged-maintenance"), "policy privileged-maintenance (maintenance mutation)");
  }
  if (classifyCompanyOwnedRoute(path)) {
    require(policies.has("company-resource"), "policy company-resource (record owned by a company)");
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(parsed.method) && matchCandidateAccessControlRoute(parsed.method, path)) {
    require(policies.has("permissions-v2"), "policy permissions-v2 (route has a V2 business action)");
  }
  return problems;
}

/**
 * Routes that do not carry a convention's declaration, each for a recorded
 * reason. An entry here is a reviewed exception, not a way to silence the
 * check: adding one needs the same review as changing the rule itself.
 */
export const CONVENTION_EXEMPTIONS: Readonly<Record<string, readonly string[]>> = {
  // The fast WhatsApp statement sender was registered ahead of the Factory
  // page/tab boundary and has never been subject to it; the Factory page
  // registry has no owner for this URL, so declaring the policy would refuse
  // every caller. It stays bound to the pinned company and to mod_factory.
  "POST /api/factory/accounts/:accountId/send-statement-whatsapp#1": [
    "policy factory-company-pin",
    "policy factory-page-access",
  ],
};

export interface ManifestVerification {
  problems: string[];
}

/**
 * Every way the manifest disagrees with the registered routes. An empty list
 * means: each registration has exactly one rule, in registration order, whose
 * recorded handler chain, authentication and session-role rule match what is
 * registered, and the access boundary is mounted in front of all of it.
 */
export function verifyManifestAgainstStack(manifest: RouteAccessManifest, stack: readonly LiveStackEntry[]): string[] {
  const problems = [...validateRouteAccessManifest(manifest)];
  if (problems.length) return problems;

  const routes = liveRoutes(stack);
  const mounts = liveMounts(stack);
  const rulesById = new Map(manifest.routes.map((rule) => [rule.id, rule]));
  const liveIds = new Set(routes.map((route) => route.id));

  for (const route of routes) {
    if (!rulesById.has(route.id)) problems.push(`${route.id}: registered route has no access rule`);
  }
  for (const rule of manifest.routes) {
    if (!liveIds.has(rule.id)) problems.push(`${rule.id}: access rule has no registered route (stale)`);
  }
  if (problems.length === 0) {
    const firstOutOfOrder = routes.findIndex((route, position) => manifest.routes[position]?.id !== route.id);
    if (firstOutOfOrder !== -1) {
      problems.push(
        `rules are not in registration order: position ${firstOutOfOrder + 1} is ${manifest.routes[firstOutOfOrder]?.id}, registered route is ${routes[firstOutOfOrder].id}`
      );
    }
  }

  const boundaryMounts = mounts.filter((mount) => mount.name === ACCESS_BOUNDARY_MOUNT);
  if (boundaryMounts.length !== 1) {
    problems.push(`expected exactly one ${ACCESS_BOUNDARY_MOUNT} mount, found ${boundaryMounts.length}`);
  } else if (boundaryMounts[0].path !== "/") {
    problems.push(`${ACCESS_BOUNDARY_MOUNT} must be mounted without a path prefix`);
  }
  const boundaryIndex = boundaryMounts[0]?.index ?? -1;
  for (const mount of mounts) {
    if ((RETIRED_MOUNTS as readonly string[]).includes(mount.name)) {
      problems.push(
        `USE ${mount.path} [${mount.name}]: retired scope middleware is mounted again; declare the policy in the manifest instead`
      );
    }
    if (mount.requiredPermission) {
      problems.push(
        `USE ${mount.path}: permission "${mount.requiredPermission}" is mounted with app.use(); declare it on the routes in the manifest instead`
      );
    }
  }

  for (const route of routes) {
    const rule = rulesById.get(route.id);
    if (!rule) continue;
    const chain = route.guards.join(" > ");
    if (rule.guards !== chain) {
      problems.push(`${route.id}: handler chain changed (declared "${rule.guards}", registered "${chain}")`);
    }

    const beforeBoundary = route.index < boundaryIndex;
    const companyBound = rule.companyScope !== "none";
    const apiRoute = route.path.toLowerCase().startsWith("/api");
    if (beforeBoundary && companyBound) {
      problems.push(
        `${route.id}: registered before the access boundary but declares companyScope ${rule.companyScope}`
      );
    }
    if (!beforeBoundary && apiRoute && rule.companyScope === "none") {
      problems.push(`${route.id}: registered behind the access boundary but declares companyScope none`);
    }

    const authenticates = chainAuthenticatesSession(route, stack);
    if (authenticates && rule.auth !== "session") {
      problems.push(`${route.id}: chain authenticates a session but auth is declared "${rule.auth}"`);
    }
    if (!authenticates && rule.auth === "session") {
      problems.push(`${route.id}: auth is declared "session" but no requireAuth/requireLogin guards the route`);
    }
    if (rule.auth === "inherited") {
      const position = routes.indexOf(route);
      const successor = routes
        .slice(position + 1)
        .find((later) => later.method === route.method && later.path === route.path);
      const successorRule = successor ? rulesById.get(successor.id) : undefined;
      if (!successorRule || (successorRule.auth !== "session" && successorRule.auth !== "inherited")) {
        problems.push(
          `${route.id}: auth "inherited" needs a later session-authenticated registration of the same route`
        );
      }
    }

    const declaredSession = rule.roles === "any" ? undefined : rule.roles.session;
    const registeredSession = chainSessionRoles(route, stack);
    if (!sameRoleRule(declaredSession, registeredSession)) {
      problems.push(
        `${route.id}: roles.session ${JSON.stringify(declaredSession ?? null)} does not match the registered guards ${JSON.stringify(registeredSession ?? null)}`
      );
    }

    const keys = declaredPermissionKeys(rule);
    for (const key of route.requiredPermissions) {
      if (!keys.includes(key))
        problems.push(`${route.id}: chain requires permission "${key}" but the rule does not declare it`);
    }

    problems.push(...conventionProblems(rule));
  }
  return problems;
}

/**
 * Refresh the manifest from the live stack: keep every existing declaration,
 * re-read the facts the registered chain decides (handler chain, session
 * authentication, session roles, chain permission keys), drop rules whose
 * route is gone, and add a rule for each new route.
 *
 * A new route's rule is filled from the conventions for its URL so that it is
 * never weaker than its neighbours. It still has to be read: anything the
 * conventions cannot know (a cross-company allowance, an import/export
 * permission, a company-role restriction) must be declared by hand.
 */
export function refreshManifest(
  manifest: RouteAccessManifest,
  stack: readonly LiveStackEntry[]
): { manifest: RouteAccessManifest; added: string[]; removed: string[] } {
  const existing = new Map(manifest.routes.map((rule) => [rule.id, rule]));
  const routes = liveRoutes(stack);
  const liveIds = new Set(routes.map((route) => route.id));
  const added: string[] = [];

  const rules = routes.map((route): RouteAccessRule => {
    const previous = existing.get(route.id);
    const session = chainSessionRoles(route, stack);
    const authenticates = chainAuthenticatesSession(route, stack);
    if (previous) {
      const company = previous.roles === "any" ? undefined : previous.roles.company;
      const roles = session || company ? { ...(session ? { session } : {}), ...(company ? { company } : {}) } : "any";
      const keys = declaredPermissionKeys(previous);
      const missing = route.requiredPermissions.filter((key) => !keys.includes(key));
      const permission =
        missing.length === 0
          ? previous.permission
          : [...(previous.permission === "none" ? [] : previous.permission), ...missing];
      const auth = authenticates ? "session" : previous.auth === "session" ? ("UNDECLARED" as never) : previous.auth;
      return orderRule({ ...previous, guards: route.guards.join(" > "), auth, roles, permission });
    }

    added.push(route.id);
    const path = samplePath(route.path);
    const api = path.startsWith("/api/");
    const pinnedVariants = [path, samplePath(route.path, "abc")].map((variant) => isPinnedCompanyRoute(variant));
    const companyScope = !api
      ? "none"
      : pinnedVariants[0] !== pinnedVariants[1]
        ? "request-resolved"
        : pinnedVariants[0]
          ? "pinned-company"
          : "active-company";
    const permission = [
      ...MODULE_PERMISSION_PREFIXES.filter(([prefix]) => under(prefix, path)).map(([, key]) => key),
      ...route.requiredPermissions,
    ].filter((key, position, all) => all.indexOf(key) === position);
    const policies: AccessPolicyName[] = [];
    if (api) {
      if (!["GET", "HEAD", "OPTIONS"].includes(route.method) && matchCandidateAccessControlRoute(route.method, path)) {
        policies.push("permissions-v2");
      }
      if (classifyPrivilegedMaintenanceRoute(route.method, path)) policies.push("privileged-maintenance");
      if (under("/api/cost-centers", path)) policies.push("cost-center-page-access");
      if (under("/api/factory", path)) policies.push("factory-company-pin");
      if (classifyCompanyOwnedRoute(path)) policies.push("company-resource");
      if (under("/api/factory", path)) policies.push("factory-page-access");
    }
    return orderRule({
      id: route.id,
      guards: route.guards.join(" > "),
      // A route without a session guard must have its authentication declared by hand.
      auth: authenticates ? "session" : ("UNDECLARED" as never),
      companyScope,
      roles: session ? { session } : "any",
      permission: permission.length ? permission : "none",
      ...(policies.length ? { policies } : {}),
    });
  });

  return {
    manifest: { ...manifest, routeCount: rules.length, routes: rules },
    added,
    removed: manifest.routes.filter((rule) => !liveIds.has(rule.id)).map((rule) => rule.id),
  };
}

function orderRule(rule: RouteAccessRule): RouteAccessRule {
  const { id, guards, auth, companyScope, crossCompany, roles, permission, policies } = rule;
  return {
    id,
    guards,
    auth,
    companyScope,
    ...(crossCompany ? { crossCompany } : {}),
    roles,
    permission,
    ...(policies ? { policies } : {}),
  };
}

/** One rule per line, so a route's access change is a one-line diff. */
export function serializeManifest(manifest: RouteAccessManifest): string {
  const lines = manifest.routes.map((rule) => `    ${JSON.stringify(orderRule(rule))}`);
  return `{
  "formatVersion": ${manifest.formatVersion},
  "description": ${JSON.stringify(manifest.description)},
  "routeCount": ${manifest.routes.length},
  "routes": [
${lines.join(",\n")}
  ]
}
`;
}
