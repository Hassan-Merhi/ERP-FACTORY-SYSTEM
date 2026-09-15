import { describe, expect, it } from "vitest";
import {
  canAccessTargetUser,
  canAssignCompany,
  canAssignExistingTargetUser,
  canAssignRole,
  canMutateGlobalUserAccount,
  filterRolesForCompany,
  type CompanyUserRoleRow,
} from "../server/services/security/companyUserAdminScopePolicy";
import { classifyUserLocationConfigurationRoute } from "../server/services/security/userLocationConfigurationPolicy";

const roleRows: CompanyUserRoleRow[] = [
  { userId: "target-user", companyId: 1, role: "Admin" },
  { userId: "target-user", companyId: 2, role: "POS" },
];

describe("Developer cross-company role administration regression", () => {
  it("allows Developer to administer a target company while tenant admins stay scoped", () => {
    expect(canAssignCompany("Developer", 2, 1)).toBe(true);
    expect(canAssignCompany("Admin", 2, 1)).toBe(false);
    expect(canAssignCompany("Admin", 1, 1)).toBe(true);

    expect(canAssignExistingTargetUser(roleRows, "target-user", "Developer")).toBe(true);
    expect(canMutateGlobalUserAccount(roleRows, "target-user", 1, "Developer")).toBe(true);
    expect(canAssignRole("Developer", "Developer")).toBe(true);
    expect(canAssignRole("Admin", "Developer")).toBe(false);
  });

  it("keeps tenant role visibility restricted to the active company", () => {
    expect(filterRolesForCompany(roleRows, 1)).toEqual([
      { userId: "target-user", companyId: 1, role: "Admin" },
    ]);
    expect(canAccessTargetUser(roleRows, "target-user", 1, "Admin")).toBe(true);
    expect(canAccessTargetUser(roleRows, "target-user", 3, "Admin")).toBe(false);
  });

  it("classifies location and cash mappings with their explicit target company", () => {
    expect(classifyUserLocationConfigurationRoute("/api/user-locations/target-user/2")).toEqual({
      kind: "locations",
      userId: "target-user",
      companyId: 2,
    });
    expect(
      classifyUserLocationConfigurationRoute("/api/user-location-cash-accounts/target-user/2")
    ).toEqual({
      kind: "cash-accounts",
      userId: "target-user",
      companyId: 2,
    });
  });
});
