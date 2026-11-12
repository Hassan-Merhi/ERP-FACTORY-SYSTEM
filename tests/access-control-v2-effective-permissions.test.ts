import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  ACCESS_CONTROL_ACTIONS,
  ACCESS_CONTROL_RESOURCES,
  type AccessControlAction,
  type AccessControlResource,
} from "@shared/accessControlV2";
import {
  CREATE_ONLY_VERIFIED_CREATE_RESOURCES,
  LEGACY_MODULE_KEYS,
  computeEffectivePermissions,
  effectiveDecisionFor,
  isHardRestricted,
  type EffectivePermissionInput,
  type V2RuleRow,
} from "@shared/effectivePermissions";
import { CREATE_ONLY_VERIFIED_CREATE_SIGNATURES } from "@shared/createOnlyRolePolicy";
import { matchCandidateAccessControlRoute } from "@shared/accessControlV2RouteReview";
import {
  isV2CompanyActivationEnabled,
  isV2EnforcementEnabled,
  refuseV2ModeTransition,
} from "../server/services/security/permissionsV2Activation";
import {
  refuseSelfRoleChange,
  wouldRemoveLastAdministrator,
} from "../server/services/security/companyAdministratorGuard";

const ROLES = [
  "Developer",
  "Admin",
  "Owner",
  "Manager",
  "POS",
  "Normal User",
  "View Only",
  "ERP Tester",
  "Create Only",
] as const;
const ALL_MODULES = Object.fromEntries(LEGACY_MODULE_KEYS.map((key) => [key, true]));

function input(overrides: Partial<EffectivePermissionInput> & { role: string | null }): EffectivePermissionInput {
  return {
    companyId: 7,
    userId: "user-1",
    legacyModules: ALL_MODULES,
    v2: { available: true, mode: "shadow", revision: 3, roleRules: [], userRules: [] },
    enforcementEnabled: false,
    ...overrides,
  };
}

function every(
  role: string,
  check: (resource: AccessControlResource, action: AccessControlAction, allowed: boolean) => void,
  extra: Partial<EffectivePermissionInput> = {}
) {
  const matrix = computeEffectivePermissions(input({ role, ...extra }));
  for (const resource of ACCESS_CONTROL_RESOURCES) {
    for (const action of ACCESS_CONTROL_ACTIONS) check(resource, action, matrix.decisions[resource][action].allowed);
  }
  return matrix;
}

describe("effective permission evaluator", () => {
  it("covers every resource and action for every role", () => {
    for (const role of ROLES) {
      const matrix = computeEffectivePermissions(input({ role }));
      expect(Object.keys(matrix.decisions)).toHaveLength(ACCESS_CONTROL_RESOURCES.length);
      expect(matrix.summary.allowed + matrix.summary.denied).toBe(
        ACCESS_CONTROL_RESOURCES.length * ACCESS_CONTROL_ACTIONS.length
      );
      expect(matrix.legacyBasis).toBe("module");
    }
  });

  it("denies everything to a person who is not a company member", () => {
    every(null, (_r, _a, allowed) => expect(allowed).toBe(false));
  });

  it("never evaluates Admin and Developer through V2", () => {
    const deny: V2RuleRow[] = ACCESS_CONTROL_RESOURCES.map((resource) => ({
      resource,
      action: "view",
      decision: "deny",
    }));
    for (const role of ["Admin", "Developer"]) {
      const matrix = every(role, (_r, _a, allowed) => expect(allowed).toBe(true), {
        v2: { available: true, mode: "active", revision: 1, roleRules: deny, userRules: deny },
        enforcementEnabled: true,
      });
      expect(matrix.enforced).toBe(false);
    }
  });

  it("keeps View Only to reads and Create Only to reads plus verified creates", () => {
    every("View Only", (resource, action, allowed) => {
      const expected = !resource.startsWith("system.") && (action === "view" || action === "export");
      expect(allowed, `${resource}:${action}`).toBe(expected);
    });
    const creatable = new Set(Object.values(CREATE_ONLY_VERIFIED_CREATE_RESOURCES));
    every("Create Only", (resource, action, allowed) => {
      const expected =
        !resource.startsWith("system.") &&
        (action === "view" || action === "export" || (action === "create" && creatable.has(resource)));
      expect(allowed, `${resource}:${action}`).toBe(expected);
    });
  });

  it("maps every verified Create Only create to a creatable resource", () => {
    expect(Object.keys(CREATE_ONLY_VERIFIED_CREATE_RESOURCES).sort()).toEqual(
      Object.keys(CREATE_ONLY_VERIFIED_CREATE_SIGNATURES).sort()
    );
  });

  it("keeps system resources, user management and repair away from operational roles", () => {
    for (const role of ["Manager", "POS", "Normal User", "ERP Tester", "View Only", "Create Only"]) {
      for (const resource of ["system.users", "system.settings", "system.maintenance"] as const) {
        for (const action of ACCESS_CONTROL_ACTIONS) expect(isHardRestricted(role, resource, action)).toBe(true);
      }
      expect(isHardRestricted(role, "erp.vouchers", "manage_users")).toBe(true);
      expect(isHardRestricted(role, "factory.raw_stock", "repair")).toBe(true);
    }
    // Owners keep company settings but never user management or maintenance.
    expect(isHardRestricted("Owner", "system.settings", "manage_settings")).toBe(false);
    expect(isHardRestricted("Owner", "system.users", "view")).toBe(true);
    expect(isHardRestricted("Owner", "system.maintenance", "repair")).toBe(true);
    expect(isHardRestricted("ERP Tester", "erp.vouchers", "manage_settings")).toBe(true);
  });

  it("follows legacy module semantics: Normal User denied by default, Manager allowed unless restricted", () => {
    const noFactory = { ...ALL_MODULES, mod_factory: false };
    const manager = computeEffectivePermissions(input({ role: "Manager", legacyModules: noFactory }));
    expect(manager.decisions["factory.containers"].create.allowed).toBe(false);
    expect(manager.decisions["erp.vouchers"].edit.allowed).toBe(true);
    const normal = computeEffectivePermissions(
      input({ role: "Normal User", legacyModules: Object.fromEntries(LEGACY_MODULE_KEYS.map((k) => [k, false])) })
    );
    expect(normal.summary.allowed).toBe(0);
  });

  it("is exactly the legacy decision in shadow mode, whatever the rules say", () => {
    const deny: V2RuleRow[] = [{ resource: "erp.suppliers", action: "create", decision: "deny" }];
    const shadow = computeEffectivePermissions(
      input({
        role: "Manager",
        v2: { available: true, mode: "shadow", revision: 4, roleRules: deny, userRules: [] },
        enforcementEnabled: true,
      })
    );
    const decision = shadow.decisions["erp.suppliers"].create;
    expect(shadow.enforced).toBe(false);
    expect(decision).toMatchObject({
      allowed: true,
      source: "legacy",
      legacyAllowed: true,
      proposedAllowed: false,
      ruleSource: "role_rule",
    });
    expect(shadow.summary.divergent).toBe(1);
  });

  it("enforces only when the company is active AND the operator switch is on", () => {
    const deny: V2RuleRow[] = [{ resource: "erp.suppliers", action: "create", decision: "deny" }];
    const active = { available: true, mode: "active" as const, revision: 5, roleRules: deny, userRules: [] };
    const switchOff = computeEffectivePermissions(input({ role: "Manager", v2: active, enforcementEnabled: false }));
    expect(switchOff.enforced).toBe(false);
    expect(switchOff.decisions["erp.suppliers"].create.allowed).toBe(true);
    const on = computeEffectivePermissions(input({ role: "Manager", v2: active, enforcementEnabled: true }));
    expect(on.enforced).toBe(true);
    expect(on.decisions["erp.suppliers"].create).toMatchObject({ allowed: false, source: "v2_active" });
    expect(on.decisions["erp.customers"].create).toMatchObject({ allowed: true, source: "v2_active" });
    const rolledBack = computeEffectivePermissions(
      input({ role: "Manager", v2: { ...active, mode: "rolled_back" }, enforcementEnabled: true })
    );
    expect(rolledBack.decisions["erp.suppliers"].create.allowed).toBe(true);
  });

  it("applies a user override over the role rule", () => {
    const active = {
      available: true,
      mode: "active" as const,
      revision: 6,
      roleRules: [{ resource: "erp.suppliers", action: "create", decision: "deny" } as V2RuleRow],
      userRules: [{ resource: "erp.suppliers", action: "create", decision: "allow" } as V2RuleRow],
    };
    const matrix = computeEffectivePermissions(input({ role: "Manager", v2: active, enforcementEnabled: true }));
    expect(matrix.decisions["erp.suppliers"].create).toMatchObject({ allowed: true, ruleSource: "user_override" });
  });

  it("is restrict-only: an allow never widens legacy or hard restrictions", () => {
    const allowAll: V2RuleRow[] = ACCESS_CONTROL_RESOURCES.flatMap((resource) =>
      ACCESS_CONTROL_ACTIONS.map((action) => ({ resource, action, decision: "allow" as const }))
    );
    for (const role of ["Manager", "POS", "Normal User", "View Only", "ERP Tester", "Create Only", "Owner"]) {
      const legacyModules = { ...ALL_MODULES, mod_factory: false };
      const legacy = computeEffectivePermissions(input({ role, legacyModules }));
      const active = computeEffectivePermissions(
        input({
          role,
          legacyModules,
          v2: { available: true, mode: "active", revision: 1, roleRules: allowAll, userRules: allowAll },
          enforcementEnabled: true,
        })
      );
      for (const resource of ACCESS_CONTROL_RESOURCES) {
        for (const action of ACCESS_CONTROL_ACTIONS) {
          if (active.decisions[resource][action].allowed) {
            expect(legacy.decisions[resource][action].allowed, `${role} ${resource}:${action}`).toBe(true);
          }
        }
      }
    }
  });

  it("falls back to legacy when the V2 schema is unavailable", () => {
    const matrix = computeEffectivePermissions(
      input({
        role: "Manager",
        v2: { available: false, mode: "active", revision: 0, roleRules: [], userRules: [] },
        enforcementEnabled: true,
      })
    );
    expect(matrix.enforced).toBe(false);
    expect(matrix.decisions["erp.vouchers"].create).toMatchObject({ allowed: true, proposedReason: "v2_unavailable" });
  });

  it("ignores malformed decisions and treats unknown pairs as no decision", () => {
    const junk = [{ resource: "erp.suppliers", action: "create", decision: "grant" }] as unknown as V2RuleRow[];
    const matrix = computeEffectivePermissions(
      input({
        role: "Manager",
        v2: { available: true, mode: "active", revision: 1, roleRules: junk, userRules: [] },
        enforcementEnabled: true,
      })
    );
    expect(matrix.decisions["erp.suppliers"].create.ruleSource).toBeNull();
    expect(effectiveDecisionFor(matrix, "erp.suppliers", "teleport")).toBeNull();
    expect(effectiveDecisionFor(matrix, "made.up", "view")).toBeNull();
  });
});

describe("V2 operator switches", () => {
  it("are off unless set to exactly 'enabled'", () => {
    expect(isV2CompanyActivationEnabled({})).toBe(false);
    expect(isV2CompanyActivationEnabled({ PERMISSIONS_V2_COMPANY_ACTIVATION: "true" })).toBe(false);
    expect(isV2CompanyActivationEnabled({ PERMISSIONS_V2_COMPANY_ACTIVATION: "enabled" })).toBe(true);
    expect(isV2EnforcementEnabled({})).toBe(false);
    expect(isV2EnforcementEnabled({ PERMISSIONS_V2_ENFORCEMENT: "1" })).toBe(false);
    expect(isV2EnforcementEnabled({ PERMISSIONS_V2_ENFORCEMENT: "enabled" })).toBe(true);
  });

  it("refuses activation without approval but always allows rollback", () => {
    expect(refuseV2ModeTransition("shadow", "active", {})).toMatchObject({
      code: "PERMISSIONS_V2_ACTIVATION_NOT_AUTHORIZED",
    });
    expect(refuseV2ModeTransition("rolled_back", "active", {})).toMatchObject({ status: 409 });
    expect(refuseV2ModeTransition("shadow", "active", { PERMISSIONS_V2_COMPANY_ACTIVATION: "enabled" })).toBeNull();
    expect(refuseV2ModeTransition("active", "shadow", {})).toBeNull();
    expect(refuseV2ModeTransition("active", "rolled_back", {})).toBeNull();
    expect(refuseV2ModeTransition("shadow", "shadow", {})).toMatchObject({ code: "POLICY_MODE_UNCHANGED" });
  });
});

describe("company administrator guard", () => {
  it("refuses removing or demoting only the last Admin row", () => {
    expect(
      wouldRemoveLastAdministrator({ adminRowIds: [4], targetRowId: 4, targetRole: "Admin", nextRole: "Manager" })
    ).toBe(true);
    expect(
      wouldRemoveLastAdministrator({ adminRowIds: [4], targetRowId: 4, targetRole: "Admin", nextRole: null })
    ).toBe(true);
    expect(
      wouldRemoveLastAdministrator({ adminRowIds: [4, 9], targetRowId: 4, targetRole: "Admin", nextRole: null })
    ).toBe(false);
    expect(
      wouldRemoveLastAdministrator({ adminRowIds: [4], targetRowId: 4, targetRole: "Admin", nextRole: "Admin" })
    ).toBe(false);
    expect(
      wouldRemoveLastAdministrator({ adminRowIds: [4], targetRowId: 5, targetRole: "Manager", nextRole: null })
    ).toBe(false);
    expect(wouldRemoveLastAdministrator({ adminRowIds: [], targetRowId: 5, targetRole: "Admin", nextRole: null })).toBe(
      false
    );
  });

  it("refuses a non-Developer changing or removing their own role", () => {
    const base = { actorUserId: "u1", targetUserId: "u1", previousRole: "Admin" };
    expect(refuseSelfRoleChange({ ...base, actorRole: "Admin", nextRole: "Developer", removing: false })).toMatchObject(
      {
        code: "SELF_ROLE_CHANGE_FORBIDDEN",
        status: 403,
      }
    );
    expect(refuseSelfRoleChange({ ...base, actorRole: "Admin", nextRole: null, removing: true })).not.toBeNull();
    expect(refuseSelfRoleChange({ ...base, actorRole: "Admin", nextRole: undefined, removing: false })).toBeNull();
    expect(refuseSelfRoleChange({ ...base, actorRole: "Admin", nextRole: "Admin", removing: false })).toBeNull();
    expect(refuseSelfRoleChange({ ...base, actorRole: "Developer", nextRole: "Manager", removing: false })).toBeNull();
    expect(
      refuseSelfRoleChange({ ...base, targetUserId: "u2", actorRole: "Admin", nextRole: "Manager", removing: false })
    ).toBeNull();
  });
});

describe("candidate route matching for deny-only enforcement", () => {
  it("matches concrete URLs to reviewed signatures, literal segments first", () => {
    expect(matchCandidateAccessControlRoute("post", "/api/suppliers")).toMatchObject({
      resource: "erp.suppliers",
      action: "create",
      signature: "POST /api/suppliers",
    });
    expect(matchCandidateAccessControlRoute("GET", "/api/suppliers")).toBeNull();
    expect(matchCandidateAccessControlRoute("POST", "/api/suppliers/extra/segments/here")).toBeNull();
    expect(matchCandidateAccessControlRoute("POST", "/api/not-reviewed")).toBeNull();
  });
});

describe("permissionsV2Enforcement middleware", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("does nothing, and reads nothing, while the enforcement switch is off", async () => {
    const readEffectivePermissions = vi.fn();
    const getActiveCompanyPermissionContext = vi.fn();
    vi.doMock("../server/services/security/effectivePermissionStore", () => ({ readEffectivePermissions }));
    vi.doMock("../server/services/security/activeCompanyPermissionContext", async (importOriginal) => ({
      ...(await importOriginal<object>()),
      getActiveCompanyPermissionContext,
    }));
    const { createPermissionsV2Enforcement } = await import("../server/middleware/permissionsV2Enforcement");
    const next = vi.fn();
    const req = { method: "POST", path: "/api/suppliers", session: { userId: "u" } };
    await createPermissionsV2Enforcement({})(req as never, {} as never, next);
    expect(next).toHaveBeenCalledOnce();
    expect(readEffectivePermissions).not.toHaveBeenCalled();
    expect(getActiveCompanyPermissionContext).not.toHaveBeenCalled();
  });

  async function runEnforced(options: { allowed?: boolean; enforced?: boolean; fail?: boolean; role?: string }) {
    const matrix = {
      enforced: options.enforced ?? true,
      revision: 9,
      decisions: { "erp.suppliers": { create: { allowed: options.allowed ?? false } } },
    };
    vi.doMock("../server/services/security/effectivePermissionStore", () => ({
      readEffectivePermissions: options.fail
        ? vi.fn().mockRejectedValue(new Error("db down"))
        : vi.fn().mockResolvedValue(matrix),
    }));
    vi.doMock("../server/services/security/activeCompanyPermissionContext", async (importOriginal) => ({
      ...(await importOriginal<object>()),
      getActiveCompanyPermissionContext: vi
        .fn()
        .mockResolvedValue({ companyId: 3, userId: "u", role: options.role ?? "Manager" }),
    }));
    const { createPermissionsV2Enforcement } = await import("../server/middleware/permissionsV2Enforcement");
    const next = vi.fn();
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
    const req = { method: "POST", path: "/api/suppliers", session: { userId: "u", currentCompanyId: 3 } };
    await createPermissionsV2Enforcement({ PERMISSIONS_V2_ENFORCEMENT: "enabled" })(req as never, res as never, next);
    return { next, res };
  }

  it("refuses a write the active matrix denies", async () => {
    const { next, res } = await runEnforced({ allowed: false });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: "PERMISSION_V2_DENIED" }));
  });

  it("lets allowed writes, non-enforced companies and system roles through", async () => {
    expect((await runEnforced({ allowed: true })).next).toHaveBeenCalledOnce();
    vi.resetModules();
    expect((await runEnforced({ allowed: false, enforced: false })).next).toHaveBeenCalledOnce();
    vi.resetModules();
    expect((await runEnforced({ allowed: false, role: "Admin" })).next).toHaveBeenCalledOnce();
  });

  it("fails closed with 503 when the policy cannot be read", async () => {
    const { next, res } = await runEnforced({ fail: true });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: "PERMISSION_SERVICE_UNAVAILABLE" }));
  });
});

describe("V2 policy snapshot failure handling", () => {
  beforeEach(() => {
    // The middleware tests above replace these modules; use the real store here.
    vi.doUnmock("../server/services/security/effectivePermissionStore");
    vi.doUnmock("../server/services/security/activeCompanyPermissionContext");
    vi.resetModules();
  });

  const schemaMissing = Object.assign(new Error("relation does not exist"), { code: "42P01" });

  function fakeDb(mode: string | null, rulesError?: unknown, versionsError?: unknown) {
    return {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("access_policy_versions")) {
          if (versionsError) throw versionsError;
          return { rows: mode ? [{ revision: "4", mode }] : [] };
        }
        if (rulesError) throw rulesError;
        return { rows: [] };
      }),
    };
  }

  it("treats a missing policy-version table as V2 not installed", async () => {
    const { loadV2PolicySnapshot } = await import("../server/services/security/effectivePermissionStore");
    await expect(
      loadV2PolicySnapshot(1, "Manager", "u", fakeDb(null, undefined, schemaMissing) as never)
    ).resolves.toMatchObject({
      available: false,
      mode: "shadow",
    });
  });

  it("fails closed when an active company's rules cannot be read", async () => {
    const { loadV2PolicySnapshot } = await import("../server/services/security/effectivePermissionStore");
    await expect(loadV2PolicySnapshot(1, "Manager", "u", fakeDb("active", schemaMissing) as never)).rejects.toBe(
      schemaMissing
    );
    const dbDown = new Error("connection reset");
    await expect(loadV2PolicySnapshot(1, "Manager", "u", fakeDb("active", dbDown) as never)).rejects.toBe(dbDown);
  });

  it("keeps a shadow or rolled-back company on legacy decisions when rules are missing", async () => {
    const { loadV2PolicySnapshot } = await import("../server/services/security/effectivePermissionStore");
    for (const mode of ["shadow", "rolled_back"]) {
      await expect(
        loadV2PolicySnapshot(1, "Manager", "u", fakeDb(mode, schemaMissing) as never)
      ).resolves.toMatchObject({
        available: false,
        mode,
      });
    }
  });

  it("reads mode, revision and rules when everything is present", async () => {
    const { loadV2PolicySnapshot } = await import("../server/services/security/effectivePermissionStore");
    await expect(loadV2PolicySnapshot(1, "Manager", "u", fakeDb("active") as never)).resolves.toMatchObject({
      available: true,
      mode: "active",
      revision: 4,
    });
  });
});
