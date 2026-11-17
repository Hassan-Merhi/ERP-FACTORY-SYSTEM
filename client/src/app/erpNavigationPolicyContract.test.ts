import { describe, expect, it } from "vitest";
import { ERP_ADMIN_ONLY_ROUTES, isErpRouteRoleAllowed } from "@shared/erpNavigationPolicy";
import { getErpRouteFeatureKeys, isErpDeveloperOnlyRoute } from "@shared/erpRouteAccess";

describe("ERP access catalog compatibility", () => {
  it("keeps the existing dashboard, stock and supplier feature relationships", () => {
    expect(getErpRouteFeatureKeys("/financial-overview")).toContain("dashboard");
    expect(getErpRouteFeatureKeys("/stock")).toEqual(["stock_items", "stock_query", "stock_otw"]);
    expect(getErpRouteFeatureKeys("/parties")).toEqual(["suppliers", "customers"]);
  });

  it("recognizes route-role restrictions independent of feature-page grants", () => {
    expect(isErpDeveloperOnlyRoute("/accounting/toolbox")).toBe(true);
    expect(isErpDeveloperOnlyRoute("/cost-centers")).toBe(true);
    expect(ERP_ADMIN_ONLY_ROUTES.has("/account-groups")).toBe(true);
    expect(isErpRouteRoleAllowed("/account-groups", "Owner")).toBe(false);
    expect(isErpRouteRoleAllowed("/account-groups", "Admin")).toBe(true);
    expect(isErpRouteRoleAllowed("/supplier-profit-reconciliation", "Normal User")).toBe(true);
  });
});
