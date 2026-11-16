/**
 * Route access declaration gate.
 *
 * Every registered Express route must have exactly one rule in
 * config/route-access-manifest.json, and that rule must still describe the
 * route as registered. This suite fails when
 *   - a route is registered without a rule, or a rule outlives its route,
 *   - a route's handler chain, authentication or role guards change without the
 *     rule changing with them,
 *   - registration order changes,
 *   - a rule is structurally invalid (unknown scope, permission key, role or
 *     policy) or weaker than the conventions for its URL,
 *   - the access boundary is not mounted exactly once in front of the routes,
 *     or a retired scope/permission middleware is mounted again.
 *
 * To add or change a route: run
 *   UPDATE_ROUTE_ACCESS_MANIFEST=1 npm run test:backend -- tests/route-access-manifest.test.ts
 * then review the rule it wrote in config/route-access-manifest.json.
 * See docs/manifest-driven-access-consolidation.md.
 */
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import {
  parseRuleId,
  RouteAccessResolver,
  validateRouteAccessManifest,
  type RouteAccessManifest,
  type RouteAccessRule,
} from "../server/security/access/routeAccessManifest";
import { ACCESS_POLICIES } from "../server/security/access/accessPolicies";
import { ACCESS_POLICY_NAMES } from "../server/security/access/routeAccessManifest";
import { buildLiveRouteStack, samplePath, type LiveStackEntry } from "./helpers/routeAccessStack";
import {
  liveRoutes,
  refreshManifest,
  serializeManifest,
  verifyManifestAgainstStack,
} from "./helpers/routeAccessVerification";

const MANIFEST_PATH = path.join(process.cwd(), "config/route-access-manifest.json");
const shouldUpdate = process.env.UPDATE_ROUTE_ACCESS_MANIFEST === "1";

function readManifest(): RouteAccessManifest {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")) as RouteAccessManifest;
}

function clone(manifest: RouteAccessManifest): RouteAccessManifest {
  return JSON.parse(JSON.stringify(manifest)) as RouteAccessManifest;
}

let stack: LiveStackEntry[];
let manifest: RouteAccessManifest;

beforeAll(async () => {
  stack = await buildLiveRouteStack();
  if (shouldUpdate) {
    const refreshed = refreshManifest(readManifest(), stack);
    fs.writeFileSync(MANIFEST_PATH, serializeManifest(refreshed.manifest));
    console.log(
      `route access manifest refreshed: ${refreshed.added.length} added, ${refreshed.removed.length} removed.` +
        (refreshed.added.length ? `\nReview the new rules:\n  ${refreshed.added.join("\n  ")}` : "")
    );
  }
  manifest = readManifest();
}, 120000);

describe("route access manifest", () => {
  it("declares a valid rule for every registered route", () => {
    const problems = verifyManifestAgainstStack(manifest, stack);
    expect(
      problems,
      `${problems.length} route access problem(s). Fix the rule in config/route-access-manifest.json ` +
        `(UPDATE_ROUTE_ACCESS_MANIFEST=1 refreshes chain facts and adds new routes).\n${problems.slice(0, 60).join("\n")}`
    ).toEqual([]);
    expect(manifest.routes).toHaveLength(liveRoutes(stack).length);
  });

  it("is committed in its canonical one-rule-per-line form", () => {
    expect(fs.readFileSync(MANIFEST_PATH, "utf8")).toBe(serializeManifest(manifest));
  });

  it("has a resolver for every named policy and uses no unknown policy", () => {
    expect(Object.keys(ACCESS_POLICIES).sort()).toEqual([...ACCESS_POLICY_NAMES].sort());
    for (const name of ACCESS_POLICY_NAMES) expect(typeof ACCESS_POLICIES[name]).toBe("function");
  });

  it("resolves every declared route back to its own rule", () => {
    const resolver = new RouteAccessResolver(manifest);
    const unreachable: string[] = [];
    for (const rule of manifest.routes) {
      const parsed = parseRuleId(rule.id)!;
      const access = resolver.resolve(parsed.method, samplePath(parsed.path));
      if (!access || !access.ruleIds.includes(rule.id)) unreachable.push(rule.id);
    }
    expect(unreachable).toEqual([]);
  });

  it("keeps registrations that share a URL bound to the same company", () => {
    const resolver = new RouteAccessResolver(manifest);
    const byId = new Map(manifest.routes.map((rule) => [rule.id, rule]));
    const disagreements: string[] = [];
    for (const rule of manifest.routes) {
      const parsed = parseRuleId(rule.id)!;
      const access = resolver.resolve(parsed.method, samplePath(parsed.path));
      for (const id of access?.ruleIds ?? []) {
        const other = byId.get(id)!;
        if (other.companyScope !== rule.companyScope) {
          disagreements.push(`${rule.id} (${rule.companyScope}) vs ${id} (${other.companyScope})`);
        }
      }
    }
    expect(disagreements).toEqual([]);
  });

  it("leaves no placeholder or delegated rule behind", () => {
    const raw = fs.readFileSync(MANIFEST_PATH, "utf8");
    expect(raw).not.toMatch(/delegated|UNDECLARED|unreviewed/i);
  });
});

describe("route access gate rejects broken manifests", () => {
  const problemsAfter = (mutate: (copy: RouteAccessManifest) => void): string[] => {
    const copy = clone(manifest);
    mutate(copy);
    copy.routeCount = copy.routes.length;
    return verifyManifestAgainstStack(copy, stack);
  };
  const ruleWhere = (copy: RouteAccessManifest, predicate: (rule: RouteAccessRule) => boolean): RouteAccessRule => {
    const rule = copy.routes.find(predicate);
    if (!rule) throw new Error("fixture rule not found");
    return rule;
  };

  it("fails when a route has no declaration", () => {
    const removed = manifest.routes[100].id;
    const problems = problemsAfter((copy) => copy.routes.splice(100, 1));
    expect(problems.join("\n")).toContain(`${removed}: registered route has no access rule`);
  });

  it("fails when a declaration is stale", () => {
    const problems = problemsAfter((copy) =>
      copy.routes.push({
        id: "GET /api/never-registered#1",
        guards: "requireAuth > <anonymous>",
        auth: "session",
        companyScope: "active-company",
        roles: "any",
        permission: "none",
      })
    );
    expect(problems.join("\n")).toContain("GET /api/never-registered#1: access rule has no registered route (stale)");
  });

  it("fails when two declarations collide", () => {
    const problems = problemsAfter((copy) => copy.routes.splice(51, 0, { ...copy.routes[50] }));
    expect(problems.join("\n")).toMatch(/declared twice/);
  });

  it("fails when a route's handler chain changes", () => {
    const problems = problemsAfter((copy) => {
      const rule = ruleWhere(copy, (candidate) => candidate.guards === "requireAuth > requireNonPOS > <anonymous>");
      rule.guards = "requireAuth > <anonymous>";
    });
    expect(problems.join("\n")).toMatch(/handler chain changed/);
  });

  it("fails when registration order changes", () => {
    const problems = problemsAfter((copy) => {
      const first = copy.routes.findIndex((rule) => rule.id === "GET /api/pos/shifts/current#1");
      const second = copy.routes.findIndex((rule) => rule.id === "GET /api/pos/shifts/:id#1");
      [copy.routes[first], copy.routes[second]] = [copy.routes[second], copy.routes[first]];
    });
    expect(problems.join("\n")).toMatch(/not in registration order/);
  });

  it("fails when the access boundary mount is missing or a retired middleware returns", () => {
    const withoutBoundary = stack.filter(
      (entry) => !(entry.kind === "mount" && entry.name === "manifestAccessBoundary")
    );
    expect(verifyManifestAgainstStack(manifest, withoutBoundary).join("\n")).toMatch(
      /expected exactly one manifestAccessBoundary mount, found 0/
    );
    const withRetired: LiveStackEntry[] = [
      ...stack,
      { kind: "mount", index: stack.length, path: "/api/admin", name: "enforceAdminCompanyScope" },
    ];
    expect(verifyManifestAgainstStack(manifest, withRetired).join("\n")).toMatch(
      /retired scope middleware is mounted again/
    );
    const withPermissionMount: LiveStackEntry[] = [
      ...stack,
      {
        kind: "mount",
        index: stack.length,
        path: "/api/new-module",
        name: "<anonymous>",
        requiredPermission: "mod_erp",
      },
    ];
    expect(verifyManifestAgainstStack(manifest, withPermissionMount).join("\n")).toMatch(
      /is mounted with app\.use\(\)/
    );
  });

  it("fails when a required permission is missing or unknown", () => {
    const missing = problemsAfter((copy) => {
      ruleWhere(copy, (rule) => rule.id === "GET /api/stock-items#1").permission = "none";
    });
    expect(missing.join("\n")).toMatch(/GET \/api\/stock-items#1: must declare permission mod_inventory/);
    const unknown = problemsAfter((copy) => {
      ruleWhere(copy, (rule) => rule.id === "GET /api/stock-items#1").permission = ["mod_does_not_exist"];
    });
    expect(unknown.join("\n")).toMatch(/unknown permission key "mod_does_not_exist"/);
  });

  it("fails when a role rule is missing, wrong or names an unknown role", () => {
    const missing = problemsAfter((copy) => {
      ruleWhere(copy, (rule) => rule.roles !== "any" && !!rule.roles.session && !rule.roles.company).roles = "any";
    });
    expect(missing.join("\n")).toMatch(/roles\.session null does not match the registered guards/);
    const unknown = problemsAfter((copy) => {
      const rule = ruleWhere(copy, (candidate) => candidate.roles !== "any" && !!candidate.roles.company);
      (rule.roles as { company: { deny?: string[]; allow?: string[] } }).company = {
        deny: ["Superuser"],
        reason: "operational-task",
      } as never;
    });
    expect(unknown.join("\n")).toMatch(/unknown role "Superuser"/);
  });

  it("fails when a company scope is invalid or weaker than the route requires", () => {
    const invalid = problemsAfter((copy) => {
      (copy.routes[200] as { companyScope: string }).companyScope = "every-company";
    });
    expect(invalid.join("\n")).toMatch(/companyScope must be one of/);
    const weaker = problemsAfter((copy) => {
      ruleWhere(
        copy,
        (rule) => rule.id.startsWith("GET /api/factory/") && rule.companyScope === "pinned-company"
      ).companyScope = "active-company";
    });
    expect(weaker.join("\n")).toMatch(/must declare companyScope pinned-company/);
    const unbound = problemsAfter((copy) => {
      ruleWhere(copy, (rule) => rule.id === "GET /api/stock-items#1").companyScope = "none";
    });
    expect(unbound.join("\n")).toMatch(/permission needs a company-bound companyScope/);
  });

  it("fails when a conditional policy is missing or unknown", () => {
    const missing = problemsAfter((copy) => {
      const rule = ruleWhere(copy, (candidate) => !!candidate.policies?.includes("privileged-maintenance"));
      rule.policies = rule.policies!.filter((policy) => policy !== "privileged-maintenance");
      if (rule.policies.length === 0) delete rule.policies;
    });
    expect(missing.join("\n")).toMatch(/must declare policy privileged-maintenance/);
    const unknown = problemsAfter((copy) => {
      copy.routes[300].policies = ["trust-me" as never];
    });
    expect(unknown.join("\n")).toMatch(/unknown policy "trust-me"/);
  });

  it("fails when a session-authenticated route is declared public", () => {
    const problems = problemsAfter((copy) => {
      ruleWhere(copy, (rule) => rule.id === "GET /api/stock-items#1").auth = "public";
    });
    expect(problems.join("\n")).toMatch(/chain authenticates a session but auth is declared "public"/);
  });

  it("fails on delegated or undeclared placeholders", () => {
    for (const placeholder of ["delegated", "UNDECLARED"]) {
      const copy = clone(manifest);
      (copy.routes[10] as { auth: string }).auth = placeholder;
      expect(validateRouteAccessManifest(copy).join("\n")).toMatch(/auth must be one of/);
      const scoped = clone(manifest);
      (scoped.routes[10] as { companyScope: string }).companyScope = placeholder;
      expect(validateRouteAccessManifest(scoped).join("\n")).toMatch(/companyScope must be one of/);
      const permitted = clone(manifest);
      (permitted.routes[10] as { permission: unknown }).permission = placeholder;
      expect(validateRouteAccessManifest(permitted).join("\n")).toMatch(
        /permission must be "none" or a non-empty list/
      );
    }
  });
});
