import { describe, expect, it } from "vitest";
import {
  CREATE_ONLY_ROLE,
  ACCESS_CONTROL_ACTIONS,
  evaluateAccessControl,
  type AccessControlAction,
  type AccessControlEvaluationInput,
} from "../shared/accessControlV2";

const base = (overrides: Partial<AccessControlEvaluationInput> = {}): AccessControlEvaluationInput => ({
  role: CREATE_ONLY_ROLE,
  companyId: 10,
  isAssignedToCompany: true,
  resource: "erp.vouchers",
  action: "view",
  ...overrides,
});

describe("Permissions Control Center V2 phase 1 policy (not yet wired)", () => {
  it("grants Create Only viewing and new business-record creation by default", () => {
    expect(evaluateAccessControl(base()).allowed).toBe(true);
    expect(evaluateAccessControl(base({ action: "create" })).allowed).toBe(true);
    expect(evaluateAccessControl(base({ action: "export" })).allowed).toBe(true);
    expect(evaluateAccessControl(base({ resource: "factory.mix_batches", action: "create" })).allowed).toBe(true);
    expect(evaluateAccessControl(base({ resource: "erp.analytics", action: "create" })).allowed).toBe(false);
  });

  it("denies immutable business actions despite role and user 'allow' overrides", () => {
    const denied: AccessControlAction[] = [
      "edit", "delete", "approve", "finalize", "void", "reverse",
      "import", "manage_settings", "manage_users", "repair",
    ];
    for (const action of denied) {
      expect(
        evaluateAccessControl(base({ action, roleDecision: "allow", userDecision: "allow" }))
      ).toEqual({ allowed: false, reason: "create_only_protected_action" });
    }
    expect(ACCESS_CONTROL_ACTIONS).toContain("create");
  });

  it("treats create-looking POSTs that change existing records as immutable", () => {
    expect(
      evaluateAccessControl(base({
        action: "create",
        touchesExistingRecord: true,
        roleDecision: "allow",
        userDecision: "allow",
      }))
    ).toEqual({ allowed: false, reason: "immutable_existing_record" });
  });

  it("never permits Create Only system settings, users or maintenance", () => {
    for (const resource of ["system.users", "system.settings", "system.maintenance"] as const) {
      for (const action of ["view", "create", "export"] as const) {
        expect(
          evaluateAccessControl(base({ resource, action, userDecision: "allow" })).allowed
        ).toBe(false);
      }
    }
  });

  it("denies requests for an invalid, unassigned or missing company", () => {
    for (const input of [
      { companyId: null }, { companyId: 0 }, { companyId: -3 },
      { companyId: 2.4 }, { isAssignedToCompany: false },
    ] as const) {
      expect(evaluateAccessControl(base(input)).reason).toBe("invalid_company_scope");
    }
  });

  it("preserves hard denials even with all user/role grants", () => {
    expect(evaluateAccessControl(base({
      hardDenied: true,
      action: "create",
      roleDecision: "allow",
      userDecision: "allow",
    }))).toEqual({ allowed: false, reason: "hard_denial" });
  });

  it("applies denied user overrides ahead of role grants; inherit uses role value", () => {
    expect(evaluateAccessControl(base({
      action: "view",
      userDecision: "deny",
      roleDecision: "allow",
    }))).toEqual({ allowed: false, reason: "user_override" });
    expect(evaluateAccessControl(base({
      action: "view",
      userDecision: "inherit",
      roleDecision: "deny",
    }))).toEqual({ allowed: false, reason: "role_override" });
  });

  it("does not alter existing role semantics in shadow mode", () => {
    expect(evaluateAccessControl(base({
      role: "Manager", action: "edit", legacyAllowed: true,
    }))).toEqual({ allowed: true, reason: "legacy_policy" });
    expect(evaluateAccessControl(base({
      role: "Normal User", action: "create", legacyAllowed: false,
    }))).toEqual({ allowed: false, reason: "legacy_policy" });
    expect(evaluateAccessControl(base({
      role: "Owner", action: "view",
    }))).toEqual({ allowed: false, reason: "unconfigured" });
  });
});
