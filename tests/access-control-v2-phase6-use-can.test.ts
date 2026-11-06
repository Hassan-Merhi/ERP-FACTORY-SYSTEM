import { describe, expect, it } from "vitest";
import { decideLegacyCan, canDenialMessage } from "../client/src/hooks/useCan";

const base = {
  role: "Manager",
  companyId: 8,
  resource: "erp.suppliers" as const,
  action: "export" as const,
  legacyAllowed: true,
  featureKey: "exp_excel",
  permissionsReady: true,
  permissions: [{ featureKey: "exp_excel", enabled: true }],
};
describe("Phase 6 frontend permission adapter", () => {
  it("does not turn shadow grants into live access", () => {
    expect(decideLegacyCan({ ...base, legacyAllowed: false }).allowed).toBe(false);
    expect(decideLegacyCan({ ...base, permissions: [{ featureKey: "exp_excel", enabled: false }] }).allowed).toBe(
      false
    );
  });
  it("fails closed when legacy permissions are still loading or failed", () => {
    expect(decideLegacyCan({ ...base, permissionsReady: false }).reason).toBe("loading");
    expect(decideLegacyCan({ ...base, permissionsReady: false }).allowed).toBe(false);
    expect(decideLegacyCan({ ...base, permissionsError: true }).reason).toBe("permission_unavailable");
    expect(decideLegacyCan({ ...base, companyId: null }).reason).toBe("missing_company");
  });
  it("retains legacy role semantics", () => {
    expect(decideLegacyCan({ ...base, permissions: [] }).allowed).toBe(true);
    expect(decideLegacyCan({ ...base, role: "Normal User", permissions: [] }).allowed).toBe(false);
    expect(decideLegacyCan({ ...base, role: "Normal User" }).allowed).toBe(true);
    expect(decideLegacyCan({ ...base, role: "Admin", permissions: undefined, permissionsReady: false }).allowed).toBe(
      true
    );
  });
  it("never permits View Only business writes or Create Only unverified writes", () => {
    expect(decideLegacyCan({ ...base, role: "View Only", action: "delete" }).reason).toBe("view_only");
    expect(decideLegacyCan({ ...base, role: "Create Only", action: "create" }).allowed).toBe(false);
    expect(
      decideLegacyCan({
        ...base,
        role: "Create Only",
        action: "create",
        verifiedCreateOnly: true,
      }).allowed
    ).toBe(true);
    expect(
      decideLegacyCan({
        ...base,
        role: "Create Only",
        action: "reverse",
        verifiedCreateOnly: true,
      }).allowed
    ).toBe(false);
  });
  it("blocks system actions for ERP Tester and offers readable feedback", () => {
    expect(decideLegacyCan({ ...base, role: "ERP Tester", resource: "system.settings", action: "view" }).reason).toBe(
      "tester_settings"
    );
    expect(canDenialMessage("permission_unavailable")).toMatch(/Permissions could not be verified/);
  });
});
