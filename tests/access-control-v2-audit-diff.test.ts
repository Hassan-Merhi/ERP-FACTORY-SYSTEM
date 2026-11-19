import { describe, expect, it } from "vitest";
import { permissionAuditDiff } from "../client/src/pages/settings/permissionAuditDiff";

describe("Phase 8 read-only audit diff", () => {
  it("presents exact changed decisions and resets to role inheritance", () => {
    expect(
      permissionAuditDiff(
        [{ resource_key: "erp.vouchers", action_key: "edit", decision: "deny" }],
        [{ resource_key: "erp.vouchers", action_key: "edit", decision: "inherit" }]
      )
    ).toEqual([{ key: "erp.vouchers:edit", before: "deny", after: "inherit" }]);
  });
  it("compares created and removed rule rows, including phase 4/5 JSON naming", () => {
    expect(
      permissionAuditDiff(
        [{ resource: "factory.containers", action: "view", decision: "allow" }],
        [{ resource_key: "erp.suppliers", action_key: "create", decision: "deny" }]
      )
    ).toEqual([
      { key: "erp.suppliers:create", before: "inherit", after: "deny" },
      { key: "factory.containers:view", before: "allow", after: "inherit" },
    ]);
  });
  it("does not fabricate changes when a rule is unchanged or payload is empty", () => {
    expect(permissionAuditDiff(null, undefined)).toEqual([]);
    expect(
      permissionAuditDiff(
        [{ resource: "erp.vouchers", action: "view", decision: "allow" }],
        [{ resource: "erp.vouchers", action: "view", decision: "allow" }]
      )
    ).toEqual([]);
  });
});
