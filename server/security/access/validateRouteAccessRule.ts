// Extracted from ./routeAccessManifest.ts to keep that module under the source-size cap.
import { PERMISSION_BY_KEY } from "@shared/permissionConfig";

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
