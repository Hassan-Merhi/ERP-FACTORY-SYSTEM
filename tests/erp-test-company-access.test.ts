import { describe, expect, it } from "vitest";
import { FEATURE_KEYS } from "../shared/schema";
import { ERP_TESTER_PAGE_KEYS, ERP_TESTER_ROLE_PERMISSIONS } from "../shared/erpTestCompanyAccess";

describe("ERP test company access policy", () => {
  it("grants all operational ERP pages but never administrative settings or Factory production", () => {
    expect(ERP_TESTER_PAGE_KEYS).toContain("dashboard");
    expect(ERP_TESTER_PAGE_KEYS).toContain("vouchers");
    expect(ERP_TESTER_PAGE_KEYS).toContain("create");
    expect(ERP_TESTER_PAGE_KEYS).toContain("stock_items");
    expect(ERP_TESTER_PAGE_KEYS).not.toContain("settings");
    expect(ERP_TESTER_PAGE_KEYS).not.toContain("factory_production");
    expect(new Set(ERP_TESTER_PAGE_KEYS).size).toBe(ERP_TESTER_PAGE_KEYS.length);
    expect([...FEATURE_KEYS].filter((key) => key !== "settings" && key !== "factory_production")).toEqual(
      ERP_TESTER_PAGE_KEYS
    );
  });

  it("explicitly denies administrative Settings and non-ERP modules", () => {
    const permissions = new Map(ERP_TESTER_ROLE_PERMISSIONS.map(({ featureKey, enabled }) => [featureKey, enabled]));
    expect(permissions.get("mod_erp")).toBe(true);
    expect(permissions.get("mod_settings")).toBe(false);
    expect(permissions.get("page_settings")).toBe(false);
    expect(permissions.get("mod_factory")).toBe(false);
    expect(permissions.get("mod_properties")).toBe(false);
  });
});
