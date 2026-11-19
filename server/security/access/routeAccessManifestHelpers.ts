// Extracted from ./routeAccessManifest.ts
import { PERMISSION_BY_KEY, type PermissionType } from "@shared/permissionConfig";
import {
  ACCESS_POLICY_NAMES,
  CROSS_COMPANY_SCOPES,
  type AccessPolicyName,
  type CompanyRoleReason,
  type CompanyScope,
  type RoleRule,
  type RouteAuth,
  type RouteRoles,
} from "./validateRouteAccessRule";

export type CrossCompanyScope = (typeof CROSS_COMPANY_SCOPES)[number];

/**
 * Policies that run after the route's permission keys and company-role rule.
 * Everything else runs before them. The split keeps the order the separate
 * middlewares used to run in.
 */
export const POLICIES_AFTER_PERMISSIONS: ReadonlySet<AccessPolicyName> = new Set([
  "factory-page-access",
  "admin-company-scope",
]);

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

export type Segment =
  { kind: "literal"; text: string } | { kind: "partial" } | { kind: "param" } | { kind: "wildcard" };

export interface CompiledRule {
  index: number;
  rule: RouteAccessRule;
  method: string;
  path: string;
  /** Lower is more specific; compared segment by segment. */
  specificity: readonly number[];
  match: (path: string) => false | { params: Partial<Record<string, string | string[]>> };
}

export interface TrieNode {
  children: Map<string, TrieNode>;
  rules: CompiledRule[];
}

export const SPECIFICITY = { literal: 0, partial: 1, param: 2, wildcard: 3 } as const;

export const EXPRESS_TRAILING_SLASH = /\/+$/;

const SCOPE_STRICTNESS: Record<CompanyScope, number> = {
  none: 0,
  "context-optional": 1,
  "request-resolved": 2,
  "active-company": 3,
  "pinned-company": 3,
};

export function mergeRules(
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
