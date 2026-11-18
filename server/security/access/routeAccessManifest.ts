/**
 * Route access manifest: the single place where every registered API route
 * declares who may call it.
 *
 * config/route-access-manifest.json holds one rule per Express registration,
 * in registration order. A rule says how the caller is authenticated, which
 * company the request is scoped to, which roles are allowed, which permission
 * keys are required and which named policy resolvers must approve the request.
 * server/security/access/manifestAccessBoundary.ts is the one middleware that
 * enforces these rules; tests/route-access-manifest.test.ts fails when a
 * registered route has no rule, when a rule has no route, or when a rule no
 * longer matches the route's handler chain.
 *
 * This module only parses, validates and matches. It performs no I/O beyond
 * what the caller hands it and has no Express dependency, so the same code
 * validates the manifest in tests and resolves requests at runtime.
 */
import { match as compilePathMatcher } from "path-to-regexp";
import { PERMISSION_BY_KEY, type PermissionType } from "@shared/permissionConfig";

export const ROUTE_ACCESS_MANIFEST_FORMAT_VERSION = 2;

/**
 * How the caller proves who they are.
 *
 * - `session`: a signed-in ERP session, checked by the route's own
 *   requireAuth/requireLogin guard (or an authenticating mount in front of it).
 * - `public`: no credentials. Sign-in, health and static sample downloads.
 * - `service-token`: a machine credential checked by the handler (webhooks).
 * - `signed-token`: an unguessable, expiring token in the URL.
 * - `inherited`: a prerequisite registration that always continues to a later
 *   registration of the same method and path, which authenticates.
 */
export const ROUTE_AUTH_MODES = ["session", "public", "service-token", "signed-token", "inherited"] as const;
export type RouteAuth = (typeof ROUTE_AUTH_MODES)[number];

/**
 * Which company a signed-in request is bound to.
 *
 * - `active-company`: the company selected in the session.
 * - `pinned-company`: the server-pinned Factory/Properties company.
 * - `request-resolved`: active or pinned, decided from the concrete URL by
 *   resolvePermissionCompanyId (ERP container aliases under /api/factory and
 *   Factory training media).
 * - `context-optional`: reachable before a company is selected (sign-in,
 *   company picker, health). No tenant context is established.
 * - `none`: never reaches the session boundary (service webhooks, static
 *   non-API files).
 */
export const COMPANY_SCOPES = [
  "active-company",
  "pinned-company",
  "request-resolved",
  "context-optional",
  "none",
] as const;
export type CompanyScope = (typeof COMPANY_SCOPES)[number];

/**
 * Explicit, reviewed ways a request may reach beyond its bound company.
 * Without one of these a caller-supplied company ID must equal the bound
 * company.
 *
 * - `authorized-companies`: the database scope covers every company the user
 *   is a member of (global transactions, consolidated reports, parent PO sync).
 * - `developer-role-administration`: a Developer may create or change a
 *   company-role assignment in another company they can access.
 * - `developer-user-location`: a Developer may configure user locations of the
 *   company named in the URL.
 * - `account-migration-source`: Admin/Developer may read the accounts of
 *   another member company named in the `:companyId` URL parameter.
 */
export const CROSS_COMPANY_SCOPES = [
  "authorized-companies",
  "developer-role-administration",
  "developer-user-location",
  "account-migration-source",
] as const;
export type CrossCompanyScope = (typeof CROSS_COMPANY_SCOPES)[number];

/**
 * Named policy resolvers, in the order the boundary runs them. A resolver is a
 * reviewed domain authorization function for decisions that depend on more
 * than the route: the record's owning company, request body values, Factory
 * page/tab assignments. server/security/access/accessPolicies.ts maps each
 * name to its implementation.
 */
export const ACCESS_POLICY_NAMES = [
  "permissions-v2",
  "privileged-maintenance",
  "shared-factory-access",
  "cost-center-page-access",
  "factory-company-pin",
  "global-maintenance",
  "intercompany-configuration",
  "user-location-configuration",
  "company-user-administration",
  "company-resource",
  "deleted-item",
  "global-transaction",
  "factory-page-access",
  "admin-company-scope",
] as const;
export type AccessPolicyName = (typeof ACCESS_POLICY_NAMES)[number];

/** Policies that run before the route's module permission keys. */
export const POLICIES_BEFORE_MODULE_PERMISSIONS: ReadonlySet<AccessPolicyName> = new Set([
  "permissions-v2",
  "privileged-maintenance",
]);

/**
 * Policies that run after the route's permission keys and company-role rule.
 * Everything else runs before them. The split keeps the order the separate
 * middlewares used to run in.
 */
export const POLICIES_AFTER_PERMISSIONS: ReadonlySet<AccessPolicyName> = new Set([
  "factory-page-access",
  "admin-company-scope",
]);

export const KNOWN_ROLES = [
  "Developer",
  "Admin",
  "Owner",
  "Manager",
  "Normal User",
  "POS",
  "View Only",
  "Create Only",
  "ERP Tester",
] as const;

export interface RoleRule {
  /** Only these roles pass. */
  allow?: readonly string[];
  /** These roles are refused. */
  deny?: readonly string[];
}

/** Why the boundary refuses a company role; selects the response code. */
export const COMPANY_ROLE_REASONS = ["operational-task", "global-export-center"] as const;
export type CompanyRoleReason = (typeof COMPANY_ROLE_REASONS)[number];

export interface RouteRoles {
  /**
   * Checked against the signed-in session role by the route's own guard chain
   * (requireRole / requireNonPOS). The coverage test proves the
   * declaration equals the registered chain.
   */
  session?: RoleRule;
  /**
   * Checked by the access boundary against the caller's role in the bound
   * company, read from the database on every request.
   */
  company?: RoleRule & { reason: CompanyRoleReason };
}

export interface PermissionRequirement {
  key: string;
  /** Roles that pass without this permission key (never without the others). */
  bypassRoles?: readonly string[];
}

export interface RouteAccessRule {
  /** `METHOD /express/path#n`; n counts registrations of the same method and path. */
  id: string;
  /** The registered handler chain, exactly as config/route-manifest.json records it. */
  guards: string;
  auth: RouteAuth;
  companyScope: CompanyScope;
  crossCompany?: readonly CrossCompanyScope[];
  roles: "any" | RouteRoles;
  permission: "none" | ReadonlyArray<string | PermissionRequirement>;
  policies?: readonly AccessPolicyName[];
}

export interface RouteAccessManifest {
  formatVersion: number;
  description: string;
  routeCount: number;
  routes: RouteAccessRule[];
}

export class RouteAccessManifestError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid route access manifest:\n${problems.slice(0, 40).join("\n")}`);
    this.name = "RouteAccessManifestError";
  }
}

const RULE_ID = /^([A-Z-]+) (\/\S*)#([1-9]\d*)$/;
const RULE_KEYS = new Set(["id", "guards", "auth", "companyScope", "crossCompany", "roles", "permission", "policies"]);

export function parseRuleId(id: string): { method: string; path: string; occurrence: number } | null {
  const parsed = RULE_ID.exec(id);
  return parsed ? { method: parsed[1], path: parsed[2], occurrence: Number(parsed[3]) } : null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function checkRoleRule(rule: unknown, where: string, problems: string[]): void {
  if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
    problems.push(`${where}: role rule must be an object`);
    return;
  }
  const { allow, deny, ...rest } = rule as Record<string, unknown>;
  const extra = Object.keys(rest).filter((key) => key !== "reason");
  if (extra.length) problems.push(`${where}: unknown role rule field ${extra.join(", ")}`);
  if (allow === undefined && deny === undefined) problems.push(`${where}: role rule needs allow or deny`);
  for (const [label, list] of [
    ["allow", allow],
    ["deny", deny],
  ] as const) {
    if (list === undefined) continue;
    if (!isStringArray(list) || list.length === 0) {
      problems.push(`${where}: ${label} must be a non-empty list of roles`);
      continue;
    }
    for (const role of list) {
      if (!(KNOWN_ROLES as readonly string[]).includes(role)) problems.push(`${where}: unknown role "${role}"`);
    }
  }
}

/** Every structural problem in one rule. An empty list means the rule is valid. */
export function validateRouteAccessRule(rule: unknown): string[] {
  const problems: string[] = [];
  if (!rule || typeof rule !== "object" || Array.isArray(rule)) return ["rule must be an object"];
  const record = rule as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : "<missing id>";
  const where = id;

  if (typeof record.id !== "string" || !parseRuleId(record.id)) problems.push(`${where}: id must be "METHOD /path#n"`);
  if (typeof record.guards !== "string" || record.guards.length === 0) problems.push(`${where}: guards is required`);
  for (const key of Object.keys(record)) {
    if (!RULE_KEYS.has(key)) problems.push(`${where}: unknown field "${key}"`);
  }

  if (!(ROUTE_AUTH_MODES as readonly unknown[]).includes(record.auth)) {
    problems.push(`${where}: auth must be one of ${ROUTE_AUTH_MODES.join(", ")}`);
  }
  if (!(COMPANY_SCOPES as readonly unknown[]).includes(record.companyScope)) {
    problems.push(`${where}: companyScope must be one of ${COMPANY_SCOPES.join(", ")}`);
  }

  if (record.crossCompany !== undefined) {
    if (!isStringArray(record.crossCompany) || record.crossCompany.length === 0) {
      problems.push(`${where}: crossCompany must be a non-empty list`);
    } else {
      for (const scope of record.crossCompany) {
        if (!(CROSS_COMPANY_SCOPES as readonly string[]).includes(scope)) {
          problems.push(`${where}: unknown crossCompany scope "${scope}"`);
        }
      }
      if (record.companyScope === "none" || record.companyScope === "context-optional") {
        problems.push(`${where}: crossCompany needs a company-bound companyScope`);
      }
    }
  }

  if (record.roles !== "any") {
    if (!record.roles || typeof record.roles !== "object" || Array.isArray(record.roles)) {
      problems.push(`${where}: roles must be "any" or a role declaration`);
    } else {
      const { session, company, ...rest } = record.roles as Record<string, unknown>;
      if (Object.keys(rest).length) problems.push(`${where}: unknown roles field ${Object.keys(rest).join(", ")}`);
      if (session === undefined && company === undefined) problems.push(`${where}: roles needs session or company`);
      if (session !== undefined) checkRoleRule(session, `${where} roles.session`, problems);
      if (company !== undefined) {
        checkRoleRule(company, `${where} roles.company`, problems);
        const reason = (company as Record<string, unknown> | null)?.reason;
        if (!(COMPANY_ROLE_REASONS as readonly unknown[]).includes(reason)) {
          problems.push(`${where}: roles.company.reason must be one of ${COMPANY_ROLE_REASONS.join(", ")}`);
        }
      }
    }
  }

  if (record.permission !== "none") {
    if (!Array.isArray(record.permission) || record.permission.length === 0) {
      problems.push(`${where}: permission must be "none" or a non-empty list`);
    } else {
      const seen = new Set<string>();
      for (const entry of record.permission as unknown[]) {
        const key =
          typeof entry === "string"
            ? entry
            : entry && typeof entry === "object"
              ? (entry as { key?: unknown }).key
              : null;
        if (typeof key !== "string") {
          problems.push(`${where}: permission entries must be a key or { key, bypassRoles }`);
          continue;
        }
        if (!PERMISSION_BY_KEY[key]) problems.push(`${where}: unknown permission key "${key}"`);
        if (seen.has(key)) problems.push(`${where}: permission key "${key}" listed twice`);
        seen.add(key);
        if (typeof entry === "object") {
          const { bypassRoles, ...rest } = entry as Record<string, unknown>;
          const extra = Object.keys(rest).filter((field) => field !== "key");
          if (extra.length) problems.push(`${where}: unknown permission field ${extra.join(", ")}`);
          if (!isStringArray(bypassRoles) || bypassRoles.length === 0) {
            problems.push(`${where}: bypassRoles must be a non-empty list of roles`);
          } else {
            for (const role of bypassRoles) {
              if (!(KNOWN_ROLES as readonly string[]).includes(role)) problems.push(`${where}: unknown role "${role}"`);
            }
          }
        }
      }
    }
  }

  if (record.policies !== undefined) {
    if (!isStringArray(record.policies) || record.policies.length === 0) {
      problems.push(`${where}: policies must be a non-empty list`);
    } else {
      let previous = -1;
      for (const policy of record.policies) {
        const index = (ACCESS_POLICY_NAMES as readonly string[]).indexOf(policy);
        if (index === -1) problems.push(`${where}: unknown policy "${policy}"`);
        else if (index <= previous) problems.push(`${where}: policies must be unique and in evaluation order`);
        previous = Math.max(previous, index);
      }
    }
  }

  const companyBound = record.companyScope !== "none" && record.companyScope !== "context-optional";
  if (!companyBound) {
    if (record.permission !== "none") problems.push(`${where}: permission needs a company-bound companyScope`);
    if (record.policies !== undefined) problems.push(`${where}: policies need a company-bound companyScope`);
    if (record.roles !== "any" && (record.roles as RouteRoles | undefined)?.company) {
      problems.push(`${where}: roles.company needs a company-bound companyScope`);
    }
  }
  if (record.auth === "service-token" && record.companyScope !== "none") {
    problems.push(`${where}: a service-token route must not use a session company scope`);
  }

  return problems;
}

/** Every structural problem in the manifest. An empty list means it is valid. */
export function validateRouteAccessManifest(manifest: unknown): string[] {
  if (!manifest || typeof manifest !== "object") return ["manifest must be an object"];
  const record = manifest as Partial<RouteAccessManifest>;
  const problems: string[] = [];
  if (record.formatVersion !== ROUTE_ACCESS_MANIFEST_FORMAT_VERSION) {
    problems.push(`formatVersion must be ${ROUTE_ACCESS_MANIFEST_FORMAT_VERSION}`);
  }
  if (!Array.isArray(record.routes)) return [...problems, "routes must be a list"];
  if (record.routeCount !== record.routes.length) problems.push("routeCount does not match the number of rules");

  const occurrences = new Map<string, number>();
  const seenIds = new Set<string>();
  for (const rule of record.routes) {
    problems.push(...validateRouteAccessRule(rule));
    const id = (rule as { id?: unknown } | null)?.id;
    if (typeof id !== "string") continue;
    if (seenIds.has(id)) problems.push(`${id}: declared twice`);
    seenIds.add(id);
    const parsed = parseRuleId(id);
    if (!parsed) continue;
    const key = `${parsed.method} ${parsed.path}`;
    const expected = (occurrences.get(key) ?? 0) + 1;
    if (parsed.occurrence !== expected) {
      problems.push(`${id}: occurrence must be #${expected} (registrations are numbered in order)`);
    }
    occurrences.set(key, expected);
  }
  return problems;
}

export function permissionKeyOf(entry: string | PermissionRequirement): string {
  return typeof entry === "string" ? entry : entry.key;
}

/** The rule a request must satisfy after merging every registration it can reach. */
export interface EffectiveRouteAccess {
  /** Rule ids that contributed, in registration order. */
  ruleIds: readonly string[];
  companyScope: CompanyScope;
  crossCompany: ReadonlySet<CrossCompanyScope>;
  companyRoles: ReadonlyArray<RoleRule & { reason: CompanyRoleReason }>;
  permissions: ReadonlyArray<{ key: string; type: PermissionType; bypassRoles: readonly string[] }>;
  policies: readonly AccessPolicyName[];
  /** Values of a `:companyId` URL parameter, when the matched route declares one. */
  pathCompanyIds: readonly string[];
  /** True when the method had no rule of its own and the path was matched on any method. */
  methodFallback: boolean;
}

type Segment = { kind: "literal"; text: string } | { kind: "partial" } | { kind: "param" } | { kind: "wildcard" };

interface CompiledRule {
  index: number;
  rule: RouteAccessRule;
  method: string;
  path: string;
  /** Lower is more specific; compared segment by segment. */
  specificity: readonly number[];
  match: (path: string) => false | { params: Partial<Record<string, string | string[]>> };
}

interface TrieNode {
  children: Map<string, TrieNode>;
  rules: CompiledRule[];
}

function segmentsOf(path: string): Segment[] {
  return path
    .split("/")
    .filter(Boolean)
    .map((text): Segment => {
      if (text.includes("*")) return { kind: "wildcard" };
      if (/^:[A-Za-z0-9_]+$/.test(text)) return { kind: "param" };
      if (/[:{}()]/.test(text)) return { kind: "partial" };
      return { kind: "literal", text };
    });
}

const SPECIFICITY = { literal: 0, partial: 1, param: 2, wildcard: 3 } as const;

function compareSpecificity(left: readonly number[], right: readonly number[]): number {
  const length = Math.max(left.length, right.length);
  for (let position = 0; position < length; position += 1) {
    const difference = (left[position] ?? 4) - (right[position] ?? 4);
    if (difference !== 0) return difference;
  }
  return 0;
}

const EXPRESS_TRAILING_SLASH = /\/+$/;

/**
 * Compiled, immutable view of the manifest that answers "which rule governs
 * this request?" with the same path semantics as the application router
 * (case-sensitive, optional trailing slash).
 */
export class RouteAccessResolver {
  private readonly byMethod = new Map<string, TrieNode>();
  private readonly anyMethod: TrieNode = { children: new Map(), rules: [] };
  private readonly merged = new Map<string, Omit<EffectiveRouteAccess, "pathCompanyIds" | "methodFallback">>();
  readonly ruleCount: number;

  constructor(manifest: RouteAccessManifest) {
    const problems = validateRouteAccessManifest(manifest);
    if (problems.length) throw new RouteAccessManifestError(problems);
    this.ruleCount = manifest.routes.length;

    manifest.routes.forEach((rule, index) => {
      const parsed = parseRuleId(rule.id);
      if (!parsed) throw new RouteAccessManifestError([`${rule.id}: unparseable id`]);
      const segments = segmentsOf(parsed.path);
      const loosened = parsed.path === "/" ? parsed.path : parsed.path.replace(EXPRESS_TRAILING_SLASH, "");
      const compiled: CompiledRule = {
        index,
        rule,
        method: parsed.method,
        path: parsed.path,
        specificity: segments.map((segment) => SPECIFICITY[segment.kind]),
        match: compilePathMatcher(loosened, { sensitive: true, end: true, trailing: true }),
      };
      const literalPrefix: string[] = [];
      for (const segment of segments) {
        if (segment.kind !== "literal") break;
        literalPrefix.push(segment.text);
      }
      for (const root of [this.methodRoot(parsed.method), this.anyMethod]) {
        let node = root;
        for (const text of literalPrefix) {
          let child = node.children.get(text);
          if (!child) {
            child = { children: new Map(), rules: [] };
            node.children.set(text, child);
          }
          node = child;
        }
        node.rules.push(compiled);
      }
    });
  }

  private methodRoot(method: string): TrieNode {
    let root = this.byMethod.get(method);
    if (!root) {
      root = { children: new Map(), rules: [] };
      this.byMethod.set(method, root);
    }
    return root;
  }

  private matches(
    root: TrieNode | undefined,
    path: string
  ): Array<{ compiled: CompiledRule; params: Partial<Record<string, string | string[]>> }> {
    if (!root) return [];
    const candidates: CompiledRule[] = [...root.rules];
    let node: TrieNode | undefined = root;
    for (const text of path.split("/").filter(Boolean)) {
      node = node.children.get(text);
      if (!node) break;
      candidates.push(...node.rules);
    }
    const found: Array<{ compiled: CompiledRule; params: Partial<Record<string, string | string[]>> }> = [];
    for (const compiled of candidates) {
      let result: ReturnType<CompiledRule["match"]>;
      try {
        result = compiled.match(path);
      } catch {
        // A malformed percent-encoding cannot name a declared route.
        continue;
      }
      if (result) found.push({ compiled, params: result.params });
    }
    return found.sort((left, right) => left.compiled.index - right.compiled.index);
  }

  /**
   * The effective rule for a request, or null when no registered route is
   * declared for it. A request can reach several registrations: duplicates of
   * the same path run as prerequisites of one another, so their rules are
   * merged. When a literal route and a parameter route both match, the literal
   * one governs, exactly as the path-based checks this replaced decided.
   */
  resolve(method: string, path: string): EffectiveRouteAccess | null {
    const upper = method.toUpperCase();
    let methodFallback = false;
    let found = this.matches(this.byMethod.get(upper), path);
    // Express answers HEAD with the GET handler when no HEAD route exists.
    if (found.length === 0 && upper === "HEAD") found = this.matches(this.byMethod.get("GET"), path);
    if (found.length === 0) {
      found = this.matches(this.anyMethod, path);
      methodFallback = found.length > 0;
    }
    if (found.length === 0) return null;

    let best = found[0].compiled.specificity;
    for (const entry of found) {
      if (compareSpecificity(entry.compiled.specificity, best) < 0) best = entry.compiled.specificity;
    }
    const governing = found.filter((entry) => compareSpecificity(entry.compiled.specificity, best) === 0);

    const cacheKey = governing.map((entry) => entry.compiled.index).join(",");
    let merged = this.merged.get(cacheKey);
    if (!merged) {
      merged = mergeRules(governing.map((entry) => entry.compiled.rule));
      this.merged.set(cacheKey, merged);
    }

    const pathCompanyIds: string[] = [];
    for (const entry of governing) {
      const value = entry.params.companyId;
      if (typeof value === "string" && !pathCompanyIds.includes(value)) pathCompanyIds.push(value);
    }
    return { ...merged, pathCompanyIds, methodFallback };
  }
}

const SCOPE_STRICTNESS: Record<CompanyScope, number> = {
  none: 0,
  "context-optional": 1,
  "request-resolved": 2,
  "active-company": 3,
  "pinned-company": 3,
};

function mergeRules(
  rules: readonly RouteAccessRule[]
): Omit<EffectiveRouteAccess, "pathCompanyIds" | "methodFallback"> {
  // Overlapping registrations must agree on the bound company (the coverage
  // test enforces it); if they ever do not, the strictest scope wins.
  let companyScope = rules[0].companyScope;
  for (const rule of rules) {
    if (SCOPE_STRICTNESS[rule.companyScope] > SCOPE_STRICTNESS[companyScope]) companyScope = rule.companyScope;
  }

  // A cross-company allowance must be declared by every registration the
  // request can reach; otherwise the narrower registration governs.
  const crossCompany = new Set<CrossCompanyScope>(rules[0].crossCompany ?? []);
  for (const rule of rules.slice(1)) {
    for (const scope of [...crossCompany]) {
      if (!rule.crossCompany?.includes(scope)) crossCompany.delete(scope);
    }
  }

  const companyRoles: Array<RoleRule & { reason: CompanyRoleReason }> = [];
  const permissions: Array<{ key: string; type: PermissionType; bypassRoles: readonly string[] }> = [];
  const policySet = new Set<AccessPolicyName>();
  for (const rule of rules) {
    if (rule.roles !== "any" && rule.roles.company) {
      const serialized = JSON.stringify(rule.roles.company);
      if (!companyRoles.some((existing) => JSON.stringify(existing) === serialized)) {
        companyRoles.push(rule.roles.company);
      }
    }
    if (rule.permission !== "none") {
      for (const entry of rule.permission) {
        const key = permissionKeyOf(entry);
        const bypassRoles = typeof entry === "string" ? [] : (entry.bypassRoles ?? []);
        const existing = permissions.find((permission) => permission.key === key);
        if (!existing) {
          permissions.push({ key, type: PERMISSION_BY_KEY[key].type, bypassRoles });
        } else {
          // A bypass only holds when every registration grants it.
          existing.bypassRoles = existing.bypassRoles.filter((role) => bypassRoles.includes(role));
        }
      }
    }
    for (const policy of rule.policies ?? []) policySet.add(policy);
  }

  return {
    ruleIds: rules.map((rule) => rule.id),
    companyScope,
    crossCompany,
    companyRoles,
    permissions,
    policies: ACCESS_POLICY_NAMES.filter((name) => policySet.has(name)),
  };
}
