import { describe, expect, it } from "vitest";
import { evaluateAccessControl } from "../shared/accessControlV2";

describe("Phase 3 business action safety contract", () => {
  const evaluate = (overrides: Record<string, unknown> = {}) =>
    evaluateAccessControl({
      role: "Create Only",
      companyId: 1,
      isAssignedToCompany: true,
      resource: "factory.containers",
      action: "create",
      routeVerified: true,
      ...overrides,
    });

  it("allows only handler-verified new operational records", () => {
    expect(evaluate().allowed).toBe(true);
    expect(evaluate({ routeVerified: false }).allowed).toBe(false);
    expect(evaluate({ routeVerified: undefined }).reason).toBe("route_not_verified");
    expect(evaluate({ isExistingRecordEdit: true }).allowed).toBe(false);
  });

  it("blocks all existing-record mutations regardless of POST route shape", () => {
    for (const action of ["edit", "delete", "approve", "finalize", "void", "reverse", "import", "repair"] as const) {
      expect(evaluate({ action, userDecision: "allow", roleDecision: "allow" }).allowed).toBe(false);
    }
  });

  it("cannot override a protected rule or cross-company boundary", () => {
    expect(evaluate({ hardDenied: true, userDecision: "allow" }).reason).toBe("hard_denial");
    expect(evaluate({ isAssignedToCompany: false }).reason).toBe("invalid_company_scope");
  });

  it("does not change legacy-role decisions", () => {
    expect(evaluate({ role: "Owner", action: "edit", legacyAllowed: true })).toEqual({
      allowed: true,
      reason: "legacy_policy",
    });
  });
});
