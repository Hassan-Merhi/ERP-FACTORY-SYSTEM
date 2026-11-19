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
import { ROUTE_ACCESS_MANIFEST_FORMAT_VERSION, parseRuleId, validateRouteAccessRule } from "./validateRouteAccessRule";
import {
  SPECIFICITY,
  EXPRESS_TRAILING_SLASH,
  mergeRules,
  type RouteAccessManifest,
  type EffectiveRouteAccess,
  type Segment,
  type CompiledRule,
  type TrieNode,
} from "./routeAccessManifestHelpers";
export {
  POLICIES_AFTER_PERMISSIONS,
  permissionKeyOf,
  type CrossCompanyScope,
  type PermissionRequirement,
  type RouteAccessRule,
  type RouteAccessManifest,
  type EffectiveRouteAccess,
} from "./routeAccessManifestHelpers";
export {
  ACCESS_POLICY_NAMES,
  COMPANY_ROLE_REASONS,
  COMPANY_SCOPES,
  CROSS_COMPANY_SCOPES,
  KNOWN_ROLES,
  POLICIES_BEFORE_MODULE_PERMISSIONS,
  ROUTE_ACCESS_MANIFEST_FORMAT_VERSION,
  ROUTE_AUTH_MODES,
  parseRuleId,
  validateRouteAccessRule,
} from "./validateRouteAccessRule";
export type {
  AccessPolicyName,
  CompanyRoleReason,
  CompanyScope,
  RoleRule,
  RouteAuth,
  RouteRoles,
} from "./validateRouteAccessRule";

export class RouteAccessManifestError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid route access manifest:\n${problems.slice(0, 40).join("\n")}`);
    this.name = "RouteAccessManifestError";
  }
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

function compareSpecificity(left: readonly number[], right: readonly number[]): number {
  const length = Math.max(left.length, right.length);
  for (let position = 0; position < length; position += 1) {
    const difference = (left[position] ?? 4) - (right[position] ?? 4);
    if (difference !== 0) return difference;
  }
  return 0;
}

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
