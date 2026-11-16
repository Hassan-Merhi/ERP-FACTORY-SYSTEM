/**
 * Behaviour of the access boundary itself: how a request resolves to its
 * declared rule, how roles and permission keys are decided for every role,
 * the order policies run in, and that nothing reaches a handler when a check
 * refuses, throws or is missing.
 *
 * Company binding and cross-company allowances are covered in
 * tests/access-boundary-company-scope.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  getActiveCompanyPermissionContext: vi.fn(),
  storage: {
    getUserCompaniesWithRoles: vi.fn(),
    getUser: vi.fn(),
    getAllCompanies: vi.fn(),
    getRoleFeaturePermissions: vi.fn(),
  },
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  db: { select: vi.fn() },
}));

vi.mock("../server/storage", () => ({ storage: harness.storage }));
vi.mock("../server/db", () => ({ db: harness.db }));
vi.mock("../server/lib/logger", () => ({ logger: harness.logger }));
vi.mock("../server/services/security/activeCompanyPermissionContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/services/security/activeCompanyPermissionContext")>();
  return { ...actual, getActiveCompanyPermissionContext: harness.getActiveCompanyPermissionContext };
});

import routeAccessManifestJson from "../config/route-access-manifest.json";
import { createManifestAccessBoundary } from "../server/security/access/manifestAccessBoundary";
import { runGuard, type AccessPolicy } from "../server/security/access/accessPolicies";
import {
  ACCESS_POLICY_NAMES,
  ROUTE_ACCESS_MANIFEST_FORMAT_VERSION,
  RouteAccessManifestError,
  RouteAccessResolver,
  type AccessPolicyName,
  type RouteAccessManifest,
  type RouteAccessRule,
} from "../server/security/access/routeAccessManifest";
import {
  ActiveCompanyPermissionContextError,
  type ActiveCompanyPermissionContext,
} from "../server/services/security/activeCompanyPermissionContext";

const committed = routeAccessManifestJson as unknown as RouteAccessManifest;

const ROLES = [
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

function contextFor(role: string, companyId = 10): ActiveCompanyPermissionContext {
  return {
    userId: "user-1",
    companyId,
    role,
    developerBypass: role === "Developer",
    assignedLocationId: null,
    cashAccountId: null,
    posStation: null,
    canSellNegativeStock: false,
    posViewOnly: false,
    daybookEditDays: 0,
    canAccessCustomers: false,
    canDeleteRecords: false,
  };
}

function manifestOf(rules: RouteAccessRule[]): RouteAccessManifest {
  return {
    formatVersion: ROUTE_ACCESS_MANIFEST_FORMAT_VERSION,
    description: "test",
    routeCount: rules.length,
    routes: rules,
  };
}

function rule(id: string, overrides: Partial<RouteAccessRule> = {}): RouteAccessRule {
  return {
    id,
    guards: "requireAuth > <anonymous>",
    auth: "session",
    companyScope: "active-company",
    roles: "any",
    permission: "none",
    ...overrides,
  };
}

interface Outcome {
  status: number;
  body: any;
  nextCalled: boolean;
  nextError: unknown;
  policyCalls: string[];
}

function recordingPolicies(
  calls: string[],
  overrides: Partial<Record<AccessPolicyName, AccessPolicy>> = {}
): Record<AccessPolicyName, AccessPolicy> {
  return Object.fromEntries(
    ACCESS_POLICY_NAMES.map((name) => [
      name,
      overrides[name] ??
        (async () => {
          calls.push(name);
          return true;
        }),
    ])
  ) as Record<AccessPolicyName, AccessPolicy>;
}

async function send(
  manifest: RouteAccessManifest,
  input: {
    method?: string;
    path: string;
    role?: string | null;
    sessionRole?: string;
    query?: Record<string, unknown>;
    body?: Record<string, unknown>;
    factoryCompanyId?: number;
    /** A signed-in session that has not selected a company yet. */
    signedInWithoutCompany?: boolean;
    policies?: Partial<Record<AccessPolicyName, AccessPolicy>>;
  }
): Promise<Outcome> {
  const role = input.role === undefined ? "Manager" : input.role;
  if (role) harness.getActiveCompanyPermissionContext.mockResolvedValue(contextFor(role));
  const policyCalls: string[] = [];
  const boundary = createManifestAccessBoundary({
    manifest,
    policies: recordingPolicies(policyCalls, input.policies),
  });
  const outcome: Outcome = { status: 200, body: undefined, nextCalled: false, nextError: undefined, policyCalls };
  await new Promise<void>((resolve) => {
    const res: any = {
      status(code: number) {
        outcome.status = code;
        return res;
      },
      json(body: unknown) {
        outcome.body = body;
        resolve();
        return res;
      },
    };
    const req: any = {
      method: input.method ?? "GET",
      path: input.path,
      originalUrl: input.path,
      url: input.path,
      baseUrl: "",
      query: input.query ?? {},
      body: input.body ?? {},
      params: {},
      session: role
        ? {
            userId: "user-1",
            currentCompanyId: 10,
            currentRole: input.sessionRole ?? role,
            factoryCompanyId: input.factoryCompanyId,
          }
        : input.signedInWithoutCompany
          ? { userId: "user-1" }
          : {},
    };
    boundary(req, res, (error?: unknown) => {
      outcome.nextCalled = true;
      outcome.nextError = error;
      resolve();
    });
  });
  return outcome;
}

beforeEach(() => {
  vi.clearAllMocks();
  harness.storage.getRoleFeaturePermissions.mockResolvedValue([]);
  harness.storage.getUserCompaniesWithRoles.mockResolvedValue([{ companyId: 10, role: "Manager" }]);
  harness.storage.getUser.mockResolvedValue({ id: "user-1", role: "Manager" });
  harness.storage.getAllCompanies.mockResolvedValue([]);
});

describe("rule resolution", () => {
  const manifest = manifestOf([
    rule("GET /api/things/current#1"),
    rule("GET /api/things/:id#1", { permission: ["pos_perm_view_shift_summary"] }),
    rule("GET /api/widgets/:id#1"),
    rule("GET /api/widgets/export-all#1", { permission: ["exp_excel"] }),
    rule("POST /api/widgets#1", { auth: "inherited" }),
    rule("POST /api/widgets#2", { permission: ["mod_inventory", "act_bulk_operations"] }),
    rule("POST /api/reference#1", { crossCompany: ["reference-read"] }),
    rule("POST /api/reference#2"),
  ]);
  const resolver = new RouteAccessResolver(manifest);

  it("refuses an undeclared API route before any handler, signed in or not", async () => {
    for (const role of ["Admin", null]) {
      const outcome = await send(manifest, { path: "/api/not-declared", role });
      expect(outcome.status).toBe(404);
      expect(outcome.body).toEqual({ code: "API_ROUTE_NOT_FOUND", message: "API endpoint not found" });
      expect(outcome.nextCalled).toBe(false);
    }
    expect(harness.logger.warn).toHaveBeenCalled();
  });

  it("keeps a role's refusal ahead of the 404 for an unknown URL, and never reaches a handler", async () => {
    // The session still says Owner; the membership is now ERP Tester, which is refused every settings URL.
    const tester = await send(manifest, { path: "/api/role-settings", role: "ERP Tester", sessionRole: "Owner" });
    expect(tester.status).toBe(403);
    expect(tester.body.code).toBe("ERP_TESTER_SETTINGS_DENIED");
    expect(tester.nextCalled).toBe(false);

    const viewOnly = await send(manifest, {
      method: "POST",
      path: "/api/not-declared",
      role: "View Only",
      sessionRole: "Manager",
    });
    expect(viewOnly.status).toBe(403);
    expect(viewOnly.body.code).toBe("VIEW_ONLY_WRITE_DENIED");
    expect(viewOnly.nextCalled).toBe(false);
  });

  it("answers 404, not a session error, when an unknown URL is requested before a company is selected", async () => {
    harness.getActiveCompanyPermissionContext.mockRejectedValue(
      new ActiveCompanyPermissionContextError(
        "An active company session is required.",
        401,
        "ACTIVE_COMPANY_CONTEXT_REQUIRED"
      )
    );
    const outcome = await send(manifest, { path: "/api/auth/not-declared", role: null, signedInWithoutCompany: true });
    expect(outcome.status).toBe(404);
    expect(outcome.body.code).toBe("API_ROUTE_NOT_FOUND");
    expect(outcome.nextCalled).toBe(false);
  });

  it("does not treat a differently-cased or over-long URL as a declared route", async () => {
    expect(resolver.resolve("GET", "/api/THINGS/current")).toBeNull();
    expect(resolver.resolve("GET", "/api/things/1/2")).toBeNull();
    // A differently-cased /API prefix must not skip the boundary either.
    const outcome = await send(manifest, { path: "/API/things/current", role: "Admin" });
    expect(outcome.status).toBe(404);
    expect(outcome.nextCalled).toBe(false);
  });

  it("ignores non-API paths", async () => {
    const outcome = await send(manifest, { path: "/assets/app.js" });
    expect(outcome.nextCalled).toBe(true);
    expect(harness.getActiveCompanyPermissionContext).not.toHaveBeenCalled();
  });

  it("lets the literal route govern over a parameter route, whichever is registered first", () => {
    expect(resolver.resolve("GET", "/api/things/current")?.permissions).toEqual([]);
    expect(resolver.resolve("GET", "/api/things/7")?.permissions.map((p) => p.key)).toEqual([
      "pos_perm_view_shift_summary",
    ]);
    expect(resolver.resolve("GET", "/api/widgets/export-all")?.permissions.map((p) => p.key)).toEqual(["exp_excel"]);
    expect(resolver.resolve("GET", "/api/widgets/7")?.permissions).toEqual([]);
  });

  it("merges duplicate registrations so a prerequisite cannot shed the real route's rule", () => {
    const access = resolver.resolve("POST", "/api/widgets");
    expect(access?.ruleIds).toEqual(["POST /api/widgets#1", "POST /api/widgets#2"]);
    expect(access?.permissions.map((p) => p.key)).toEqual(["mod_inventory", "act_bulk_operations"]);
  });

  it("keeps a cross-company allowance only when every reachable registration declares it", () => {
    expect([...(resolver.resolve("POST", "/api/reference")?.crossCompany ?? [])]).toEqual([]);
  });

  it("answers HEAD with the GET rule and an unlisted method with the path's rule", () => {
    expect(resolver.resolve("HEAD", "/api/widgets/export-all")?.permissions.map((p) => p.key)).toEqual(["exp_excel"]);
    const options = resolver.resolve("OPTIONS", "/api/widgets/export-all");
    expect(options?.methodFallback).toBe(true);
    expect(resolver.resolve("GET", "/api/widgets/export-all/")?.ruleIds).toEqual(["GET /api/widgets/export-all#1"]);
  });

  it("refuses to compile an invalid manifest", () => {
    expect(() => new RouteAccessResolver(manifestOf([rule("GET /api/x#1", { permission: ["mod_unknown"] })]))).toThrow(
      RouteAccessManifestError
    );
    expect(
      () => new RouteAccessResolver(manifestOf([rule("GET /api/x#1", { companyScope: "delegated" as never })]))
    ).toThrow(RouteAccessManifestError);
    expect(() => new RouteAccessResolver(manifestOf([rule("GET /api/x#1", { policies: ["nope" as never] })]))).toThrow(
      RouteAccessManifestError
    );
    expect(() => createManifestAccessBoundary({ manifest: manifestOf([rule("GET /api/x#2")]) })).toThrow(
      RouteAccessManifestError
    );
  });
});

describe("authentication stays with the route", () => {
  const manifest = manifestOf([
    rule("GET /api/private#1", { permission: ["mod_inventory"], policies: ["company-resource"] }),
    rule("GET /api/health#1", { auth: "public", companyScope: "context-optional", guards: "<anonymous>" }),
    rule("POST /api/hook#1", { auth: "service-token", companyScope: "none", guards: "hookHandler" }),
  ]);

  it("passes a signed-out request to the route's own guard without resolving a company", async () => {
    const outcome = await send(manifest, { path: "/api/private", role: null });
    expect(outcome.nextCalled).toBe(true);
    expect(outcome.policyCalls).toEqual([]);
    expect(harness.getActiveCompanyPermissionContext).not.toHaveBeenCalled();
  });

  it("does not bind a company for context-optional and service routes", async () => {
    for (const [method, path] of [
      ["GET", "/api/health"],
      ["POST", "/api/hook"],
    ]) {
      const outcome = await send(manifest, { method, path, role: "Manager" });
      expect(outcome.nextCalled).toBe(true);
    }
    expect(harness.getActiveCompanyPermissionContext).not.toHaveBeenCalled();
  });
});

/**
 * A Create Only write that is not a verified create is refused by the
 * company-scope stage before the route's role rule is reached.
 */
const roleRefusalCode = (role: string) =>
  role === "Create Only" ? "BUSINESS_ACTION_NOT_VERIFIED" : "OPERATIONAL_ROLE_DENIED";

describe("role and permission decisions on the committed manifest", () => {
  const disable = (role: string, featureKey: string) =>
    harness.storage.getRoleFeaturePermissions.mockResolvedValue([{ role, featureKey, enabled: false }]);
  const enable = (role: string, featureKey: string) =>
    harness.storage.getRoleFeaturePermissions.mockResolvedValue([{ role, featureKey, enabled: true }]);

  it("decides a company import for every role", async () => {
    const expected: Record<(typeof ROLES)[number], "allowed" | "role" | "key"> = {
      Developer: "allowed",
      Admin: "allowed",
      Owner: "allowed",
      Manager: "allowed",
      "ERP Tester": "allowed",
      // Deny-by-default role: needs the key enabled explicitly.
      "Normal User": "key",
      POS: "role",
      "View Only": "role",
      "Create Only": "role",
    };
    for (const role of ROLES) {
      const outcome = await send(committed, { method: "POST", path: "/api/po-import/import", role });
      if (expected[role] === "allowed") {
        expect(outcome.nextCalled, role).toBe(true);
        expect(outcome.nextError, role).toBeUndefined();
      } else if (expected[role] === "role") {
        expect(outcome.status, role).toBe(403);
        expect(outcome.body.code, role).toBe(roleRefusalCode(role));
        expect(outcome.nextCalled, role).toBe(false);
      } else {
        expect(outcome.status, role).toBe(403);
        expect(outcome.body, role).toMatchObject({ key: "act_import_data", permType: "action" });
        expect(outcome.nextCalled, role).toBe(false);
      }
    }
  });

  it("lets a Normal User import only once the key is enabled, and refuses a Manager whose key is disabled", async () => {
    enable("Normal User", "act_import_data");
    expect(
      (await send(committed, { method: "POST", path: "/api/po-import/import", role: "Normal User" })).nextCalled
    ).toBe(true);
    disable("Manager", "act_import_data");
    const refused = await send(committed, { method: "POST", path: "/api/po-import/import", role: "Manager" });
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ key: "act_import_data" });
  });

  it("keeps the POS sales-import exception: POS passes without the key, View Only stays blocked", async () => {
    disable("POS", "act_import_data");
    expect((await send(committed, { method: "POST", path: "/api/pos-import/import", role: "POS" })).nextCalled).toBe(
      true
    );

    disable("Manager", "act_import_data");
    const manager = await send(committed, { method: "POST", path: "/api/pos-import/import", role: "Manager" });
    expect(manager.status).toBe(403);
    expect(manager.body).toMatchObject({ key: "act_import_data" });

    for (const role of ["View Only", "Create Only"]) {
      const outcome = await send(committed, { method: "POST", path: "/api/pos-import/import", role });
      expect(outcome.status, role).toBe(403);
      expect(outcome.body.code, role).toBe(roleRefusalCode(role));
    }
  });

  it("does not extend the POS exception to ordinary imports or to other keys", async () => {
    const outcome = await send(committed, { method: "POST", path: "/api/stock-items/import", role: "POS" });
    expect(outcome.status).toBe(403);
    expect(outcome.nextCalled).toBe(false);
  });

  it("opens the all-company export center to Developer only", async () => {
    for (const role of ROLES) {
      const outcome = await send(committed, { method: "POST", path: "/api/export/start", role });
      if (role === "Developer") {
        expect(outcome.nextCalled, role).toBe(true);
      } else {
        expect(outcome.status, role).toBe(403);
        expect(outcome.body.code, role).toBe(
          role === "Create Only" ? "BUSINESS_ACTION_NOT_VERIFIED" : "GLOBAL_EXPORT_DEVELOPER_REQUIRED"
        );
        expect(outcome.nextCalled, role).toBe(false);
      }
    }
  });

  it("refuses bulk maintenance and repair to POS, View Only and Create Only", async () => {
    for (const role of ["POS", "View Only", "Create Only"]) {
      const outcome = await send(committed, { method: "POST", path: "/api/admin/fix-sales-inventory", role });
      expect(outcome.status, role).toBe(403);
      expect(outcome.nextCalled, role).toBe(false);
    }
    const admin = await send(committed, { method: "POST", path: "/api/admin/fix-sales-inventory", role: "Admin" });
    expect(admin.nextCalled).toBe(true);
    expect(admin.policyCalls).toContain("privileged-maintenance");
  });

  it("enforces the module permission of each surface", async () => {
    for (const [path, key, factoryCompanyId] of [
      ["/api/stock-items", "mod_inventory", undefined],
      ["/api/vouchers", "mod_accounting", undefined],
      ["/api/customers", "mod_erp", undefined],
      ["/api/reports/sales", "mod_analytics", undefined],
      ["/api/factory/bales", "mod_factory", 10],
    ] as const) {
      disable("Manager", key);
      const refused = await send(committed, { path, role: "Manager", factoryCompanyId });
      expect(refused.status, path).toBe(403);
      expect(refused.body, path).toMatchObject({ key, permType: "module" });
      expect(refused.nextCalled, path).toBe(false);

      harness.storage.getRoleFeaturePermissions.mockResolvedValue([]);
      const allowed = await send(committed, { path, role: "Manager", factoryCompanyId });
      expect(allowed.nextCalled, path).toBe(true);
      // Admin and Developer cannot be restricted through role-feature rows.
      disable("Admin", key);
      expect((await send(committed, { path, role: "Admin", factoryCompanyId })).nextCalled, path).toBe(true);
    }
  });

  it("fails closed with 503 when permissions cannot be read", async () => {
    harness.storage.getRoleFeaturePermissions.mockRejectedValue(new Error("database unavailable"));
    const outcome = await send(committed, { path: "/api/stock-items", role: "Manager" });
    expect(outcome.status).toBe(503);
    expect(outcome.body.code).toBe("PERMISSION_LOOKUP_UNAVAILABLE");
    expect(outcome.nextCalled).toBe(false);
  });

  it("checks the database role, not the session's copy of it", async () => {
    // The session still says Manager; the company membership is now POS.
    const outcome = await send(committed, {
      method: "POST",
      path: "/api/po-import/import",
      role: "POS",
      sessionRole: "Manager",
    });
    expect(outcome.status).toBe(403);
    expect(outcome.body.code).toBe("OPERATIONAL_ROLE_DENIED");
  });
});

describe("named policies", () => {
  const manifest = manifestOf([
    rule("POST /api/factory/things/:id#1", {
      companyScope: "pinned-company",
      roles: { company: { deny: ["POS"], reason: "operational-task" } },
      permission: ["mod_factory", "act_bulk_operations"],
      policies: [
        "permissions-v2",
        "privileged-maintenance",
        "shared-factory-access",
        "factory-company-pin",
        "company-resource",
        "factory-page-access",
        "admin-company-scope",
      ],
    }),
    rule("GET /api/plain#1"),
  ]);

  it("runs exactly the declared policies, in order, around the permission keys", async () => {
    const order: string[] = [];
    harness.storage.getRoleFeaturePermissions.mockImplementation(async () => {
      order.push("permission-lookup");
      return [];
    });
    const track =
      (name: string): AccessPolicy =>
      async () => {
        order.push(name);
        return true;
      };
    const outcome = await send(manifest, {
      method: "POST",
      path: "/api/factory/things/5",
      role: "Manager",
      factoryCompanyId: 10,
      policies: Object.fromEntries(ACCESS_POLICY_NAMES.map((name) => [name, track(name)])),
    });
    expect(outcome.nextCalled).toBe(true);
    expect(order).toEqual([
      "permissions-v2",
      "privileged-maintenance",
      "permission-lookup",
      "shared-factory-access",
      "factory-company-pin",
      "company-resource",
      "factory-page-access",
      "admin-company-scope",
    ]);
  });

  it("runs no policy for a route that declares none", async () => {
    const outcome = await send(manifest, { path: "/api/plain" });
    expect(outcome.nextCalled).toBe(true);
    expect(outcome.policyCalls).toEqual([]);
  });

  it("stops at the first policy that refuses and never reaches the handler", async () => {
    const refuse: AccessPolicy = async (_req, res) => {
      res.status(404).json({ message: "Voucher not found" });
      return false;
    };
    const outcome = await send(manifest, {
      method: "POST",
      path: "/api/factory/things/5",
      factoryCompanyId: 10,
      policies: { "company-resource": refuse },
    });
    expect(outcome.status).toBe(404);
    expect(outcome.nextCalled).toBe(false);
    expect(outcome.policyCalls).not.toContain("factory-page-access");
  });

  it("forwards a throwing policy as an error instead of continuing", async () => {
    const failure = new Error("resolver exploded");
    const outcome = await send(manifest, {
      method: "POST",
      path: "/api/factory/things/5",
      factoryCompanyId: 10,
      policies: {
        "shared-factory-access": async () => {
          throw failure;
        },
      },
    });
    expect(outcome.nextCalled).toBe(true);
    expect(outcome.nextError).toBe(failure);
    expect(outcome.policyCalls).not.toContain("factory-page-access");
  });

  it("refuses rather than skips when a declared policy has no resolver", async () => {
    const boundary = createManifestAccessBoundary({
      manifest,
      policies: {} as Record<AccessPolicyName, AccessPolicy>,
    });
    harness.getActiveCompanyPermissionContext.mockResolvedValue(contextFor("Admin"));
    const error = await new Promise<unknown>((resolve) => {
      const req: any = {
        method: "POST",
        path: "/api/factory/things/5",
        originalUrl: "/api/factory/things/5",
        query: {},
        body: {},
        session: { userId: "user-1", currentCompanyId: 10, currentRole: "Admin", factoryCompanyId: 10 },
      };
      boundary(req, {} as never, resolve);
    });
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toMatch(/has no resolver/);
  });

  it("refuses a request whose URL contradicts its declared company scope", async () => {
    const mismatched = manifestOf([rule("GET /api/factory/elsewhere#1", { companyScope: "active-company" })]);
    const outcome = await send(mismatched, { path: "/api/factory/elsewhere", factoryCompanyId: 10 });
    expect(outcome.status).toBe(403);
    expect(outcome.body.code).toBe("ROUTE_ACCESS_SCOPE_MISMATCH");
    expect(outcome.nextCalled).toBe(false);
  });
});

describe("runGuard", () => {
  const response = () => {
    const listeners = new Map<string, () => void>();
    return {
      once: (event: string, listener: () => void) => listeners.set(event, listener),
      off: (event: string) => listeners.delete(event),
      emit: (event: string) => listeners.get(event)?.(),
    };
  };

  it("continues when the guard calls next, even after it has returned", async () => {
    const res = response();
    const allowed = runGuard((_req, _res, next) => void setTimeout(next, 5), {} as never, res as never);
    await expect(allowed).resolves.toBe(true);
  });

  it("reports a refusal when the guard ends the response without calling next", async () => {
    const res = response();
    const refused = runGuard(() => void setTimeout(() => res.emit("finish"), 5), {} as never, res as never);
    await expect(refused).resolves.toBe(false);
  });

  it("rejects when the guard passes an error or throws", async () => {
    const failure = new Error("guard failed");
    await expect(runGuard((_req, _res, next) => next(failure), {} as never, response() as never)).rejects.toBe(failure);
    await expect(
      runGuard(
        () => {
          throw failure;
        },
        {} as never,
        response() as never
      )
    ).rejects.toBe(failure);
  });
});
