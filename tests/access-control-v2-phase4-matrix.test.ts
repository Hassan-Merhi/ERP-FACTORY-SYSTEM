import { describe, expect, it } from "vitest";
import { ACCESS_CONTROL_ACTIONS, ACCESS_CONTROL_RESOURCES } from "../shared/accessControlV2";
import {
  canStageRoleDecision,
  matrixActions,
  matrixResources,
  pendingRoleChanges,
  roleRulesFor,
  ruleKey,
} from "../client/src/pages/settings/rolePermissionMatrixModel";

describe("Phase 4 role templates UI policy model", () => {
  it("uses the exact shared resources/actions from the backend", () => {
    expect(matrixActions).toEqual(ACCESS_CONTROL_ACTIONS);
    expect(matrixResources).toEqual(ACCESS_CONTROL_RESOURCES);
  });

  it("computes minimal versioned edits and explicit resets to inherit", () => {
    const saved = roleRulesFor(
      [
        { roleKey: "Manager", resource: "erp.vouchers", action: "edit", decision: "deny" },
        { roleKey: "Owner", resource: "erp.vouchers", action: "edit", decision: "allow" },
      ],
      "Manager"
    );
    const edited = new Map(saved);
    edited.set(ruleKey("erp.vouchers", "edit"), "inherit");
    edited.set(ruleKey("factory.containers", "view"), "allow");
    expect(pendingRoleChanges(saved, edited)).toEqual([
      { resource: "erp.vouchers", action: "edit", decision: "inherit" },
      { resource: "factory.containers", action: "view", decision: "allow" },
    ]);
    expect(saved.get(ruleKey("erp.vouchers", "edit"))).toBe("deny");
  });

  it("never stages elevation for protected roles or Create Only forbidden actions", () => {
    expect(canStageRoleDecision("Create Only", "factory.containers", "edit", "allow")).toBe(false);
    expect(canStageRoleDecision("Create Only", "erp.vouchers", "reverse", "allow")).toBe(false);
    expect(canStageRoleDecision("Create Only", "factory.containers", "create", "allow")).toBe(true);
    expect(canStageRoleDecision("Manager", "system.users", "view", "allow")).toBe(false);
    expect(canStageRoleDecision("Owner", "erp.vouchers", "repair", "allow")).toBe(false);
    expect(canStageRoleDecision("Create Only", "erp.vouchers", "edit", "inherit")).toBe(true);
    expect(canStageRoleDecision("Create Only", "erp.vouchers", "edit", "deny")).toBe(true);
  });
});
