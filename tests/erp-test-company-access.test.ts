import { describe, expect, it } from "vitest";
import { FEATURE_KEYS, insertRoleFeaturePermissionSchema, insertUserCompanyRoleSchema } from "../shared/schema";
import { canAccessModule, canAccessPage } from "../server/lib/permissionHelpers";
import {
  ERP_TESTER_PAGE_KEYS,
  ERP_TESTER_ROLE,
  ERP_TESTER_ROLE_PERMISSIONS,
  isErpTestCompanyCode,
  isErpTesterForbiddenApiPath,
} from "../shared/erpTestCompanyAccess";

describe("ERP test company access policy", () => {
  it("stores ERP Tester as an independent user role", () => {
    expect(ERP_TESTER_ROLE).toBe("ERP Tester");
    expect(insertUserCompanyRoleSchema.shape.role.safeParse(ERP_TESTER_ROLE).success).toBe(true);
    expect(insertRoleFeaturePermissionSchema.shape.role.safeParse(ERP_TESTER_ROLE).success).toBe(true);
  });

  it("recognizes only generated ERP test company codes", () => {
    expect(isErpTestCompanyCode("ERPTEST-ABCDEF1234")).toBe(true);
    expect(isErpTestCompanyCode("ERP")).toBe(false);
    expect(isErpTestCompanyCode("ERPTEST-anything")).toBe(false);
  });

  it("blocks all system settings but permits normal company operational APIs", () => {
    const denied = [
      "/api/settings",
      "/api/settings/role-permissions",
      "/api/pos/settings",
      "/api/pos/retail-settings",
      "/api/company-settings",
      "/api/factory/notification-settings",
      "/api/my-settings",
      "/api/admin/reset-company-data",
      "/api/users",
      "/api/user-company-roles",
      "/api/companies/erp-test",
    ];
    for (const path of denied) expect(isErpTesterForbiddenApiPath(path)).toBe(true);

    const allowed = [
      "/api/vouchers",
      "/api/stock-items",
      "/api/companies",
      "/api/user/change-password",
      "/api/factory/stock",
      "/api/properties/units",
      "/api/sp/reports",
    ];
    for (const path of allowed) expect(isErpTesterForbiddenApiPath(path)).toBe(false);
  });

  it("never grants Settings, even with a configured allow, while permitting normal modules", () => {
    const forceEnabled = new Map([
      ["page_settings", true],
      ["mod_settings", true],
      ["settings", true],
      ["mod_erp", true],
      ["mod_factory", true],
      ["mod_properties", true],
    ]);
    expect(canAccessPage(ERP_TESTER_ROLE, "settings", forceEnabled)).toBe(false);
    expect(canAccessPage(ERP_TESTER_ROLE, "page_settings", forceEnabled)).toBe(false);
    expect(canAccessModule(ERP_TESTER_ROLE, "mod_settings", forceEnabled)).toBe(false);
    expect(canAccessModule(ERP_TESTER_ROLE, "mod_erp", forceEnabled)).toBe(true);
    expect(canAccessModule(ERP_TESTER_ROLE, "mod_factory", forceEnabled)).toBe(true);
    expect(canAccessModule(ERP_TESTER_ROLE, "mod_properties", forceEnabled)).toBe(true);
  });

  it("grants ERP pages in any assigned company but never administrative settings", () => {
    expect(ERP_TESTER_PAGE_KEYS).toContain("dashboard");
    expect(ERP_TESTER_PAGE_KEYS).toContain("vouchers");
    expect(ERP_TESTER_PAGE_KEYS).toContain("create");
    expect(ERP_TESTER_PAGE_KEYS).toContain("stock_items");
    expect(ERP_TESTER_PAGE_KEYS).not.toContain("settings");
    expect(new Set(ERP_TESTER_PAGE_KEYS).size).toBe(ERP_TESTER_PAGE_KEYS.length);
    expect([...FEATURE_KEYS].filter((key) => key !== "settings")).toEqual(ERP_TESTER_PAGE_KEYS);
  });

  it("retains the extra restrictions of the optional standalone test-company creator", () => {
    const permissions = new Map(ERP_TESTER_ROLE_PERMISSIONS.map(({ featureKey, enabled }) => [featureKey, enabled]));
    expect(permissions.get("mod_erp")).toBe(true);
    expect(permissions.get("mod_settings")).toBe(false);
    expect(permissions.get("page_settings")).toBe(false);
    expect(permissions.get("mod_factory")).toBe(false);
    expect(permissions.get("mod_properties")).toBe(false);
  });
});
