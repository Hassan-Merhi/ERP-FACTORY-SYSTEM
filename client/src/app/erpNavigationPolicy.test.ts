import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";

import {
  ERP_ADMIN_ONLY_ROUTES,
  canEnterErpGuardedRoute,
  isErpDeclaredRoleRoute,
  ERP_RETAIL_HIDDEN_ROUTES,
  effectiveErpRole,
  isErpNavigationItemVisible,
  isErpRouteRoleAllowed,
} from "@shared/erpNavigationPolicy";
import {
  ERP_MOBILE_PRIMARY_PATHS,
  ERP_NAV_SECTIONS,
  ERP_PINNED_ITEMS,
  ERP_UTILITY_ITEMS,
  erpPrimaryGroupDestinations,
  erpRegisteredNavigationUrls,
} from "./erpPageRegistry";
import { erpPageAccessQueryOptions } from "./erpAccessQuery";

const ordinary = { role: "Normal User", access: { fullAccess: true, pageKeys: ["accounts", "pos"] } };

describe("ERP role and navigation policy", () => {
  it("fails closed for an unregistered privileged route and keeps known grants", () => {
    expect(isErpDeclaredRoleRoute("/maintenance/new-tool")).toBe(false);
    expect(canEnterErpGuardedRoute("/maintenance/new-tool", "Admin")).toBe(false);
    expect(canEnterErpGuardedRoute("/accounting/toolbox", "Normal User")).toBe(false);
    expect(canEnterErpGuardedRoute("/accounting/toolbox", "Developer")).toBe(true);
    expect(canEnterErpGuardedRoute("/settings", "Admin")).toBe(true);
    expect(canEnterErpGuardedRoute("/convergence-reconciliation", "Owner")).toBe(true);
    expect(canEnterErpGuardedRoute("/financial-overview", "View Only")).toBe(false);
    expect(canEnterErpGuardedRoute("/transaction-journal", "ERP Tester")).toBe(false);
    expect(canEnterErpGuardedRoute("/my-settings", "Normal User")).toBe(true);
  });

  it("always enforces developer and admin route restrictions before full-access grants", () => {
    expect(ERP_ADMIN_ONLY_ROUTES.has("/settings")).toBe(true);
    expect(isErpRouteRoleAllowed("/settings", "Normal User")).toBe(false);
    expect(isErpNavigationItemVisible({ ...ordinary, path: "/settings" })).toBe(false);
    expect(isErpNavigationItemVisible({ ...ordinary, path: "/cost-centers" })).toBe(false);
    expect(isErpNavigationItemVisible({ ...ordinary, path: "/accounting/toolbox" })).toBe(false);
    expect(isErpNavigationItemVisible({ ...ordinary, path: "/ai-validation" })).toBe(false);
    expect(isErpRouteRoleAllowed("/settings", "Admin")).toBe(true);
    expect(isErpRouteRoleAllowed("/cost-centers", "Developer")).toBe(true);
    expect(isErpRouteRoleAllowed("/convergence-reconciliation", "Owner")).toBe(true);
    expect(isErpRouteRoleAllowed("/convergence-reconciliation", "Normal User")).toBe(false);
  });

  it("preserves read-only, tester and POS role boundaries across URL query strings", () => {
    expect(effectiveErpRole({ role: "Normal User", currentRole: "View Only" })).toBe("View Only");
    expect(isErpNavigationItemVisible({ role: "View Only", path: "/financial-overview?tab=summary" })).toBe(false);
    expect(isErpNavigationItemVisible({ role: "Create Only", path: "/financial-overview" })).toBe(false);
    expect(isErpRouteRoleAllowed("/transaction-journal", "ERP Tester")).toBe(false);
    expect(isErpRouteRoleAllowed("/my-settings", "ERP Tester")).toBe(false);
    expect(isErpNavigationItemVisible({ role: "POS", path: "/pos-item-replacement", access: ordinary.access })).toBe(false);
    expect(isErpNavigationItemVisible({ role: "POS", path: "/pos" })).toBe(true);
    expect(isErpNavigationItemVisible({ role: "POS", path: "/pos-import" })).toBe(false);
    expect(isErpNavigationItemVisible({ role: "POS", path: "/pos-import", posExcelImportEnabled: true })).toBe(true);
  });

  it("keeps retail menu exclusions and company feature grants", () => {
    expect(ERP_RETAIL_HIDDEN_ROUTES.has("/stock")).toBe(true);
    expect(isErpNavigationItemVisible({ role: "Admin", companyType: "retail", path: "/stock" })).toBe(false);
    expect(isErpNavigationItemVisible({ role: "Normal User", companyType: "erp", path: "/item-market-analysis", access: { fullAccess: false, pageKeys: ["sales_report"] } })).toBe(true);
    expect(isErpNavigationItemVisible({ role: "Normal User", companyType: "factory", path: "/item-market-analysis", access: { fullAccess: false, pageKeys: ["sales_report"] } })).toBe(false);
    expect(isErpNavigationItemVisible({ role: "Normal User", path: "/inventory", access: { fullAccess: false, pageKeys: ["containers"] } })).toBe(true);
    expect(isErpNavigationItemVisible({ role: "Normal User", path: "/inventory", access: { fullAccess: false, pageKeys: [] } })).toBe(false);
  });

  it("builds mobile destinations only from registered desktop ERP navigation metadata", () => {
    const registered = new Set(erpRegisteredNavigationUrls());
    expect(registered.size).toBeGreaterThan(10);
    for (const group of Object.keys(ERP_MOBILE_PRIMARY_PATHS) as Array<keyof typeof ERP_MOBILE_PRIMARY_PATHS>) {
      const destinations = erpPrimaryGroupDestinations(group);
      expect(destinations.map((item) => item.href)).toEqual(ERP_MOBILE_PRIMARY_PATHS[group]);
      for (const item of destinations) expect(registered.has(item.href)).toBe(true);
    }
    expect(ERP_NAV_SECTIONS.some((section) => section.label === "Others")).toBe(true);
    expect(ERP_PINNED_ITEMS.some((item) => item.url === "/vouchers")).toBe(true);
    expect(ERP_UTILITY_ITEMS.some((item) => item.url === "/create")).toBe(true);
  });

  it("uses company-specific ERP access query keys across shell and routes", () => {
    expect(erpPageAccessQueryOptions(12, true).queryKey).toEqual(["/api/my-erp-pages", 12]);
    expect(erpPageAccessQueryOptions(13, true).queryKey).toEqual(["/api/my-erp-pages", 13]);
    expect(erpPageAccessQueryOptions(12, true).enabled).toBe(true);
    expect(erpPageAccessQueryOptions(undefined, true).enabled).toBe(false);
    expect(erpPageAccessQueryOptions(12, false).enabled).toBe(false);
  });
  it("isolates page grants and hidden-cost settings between companies", () => {
    const client = new QueryClient();
    const alphaKey = erpPageAccessQueryOptions(12, true).queryKey;
    const betaKey = erpPageAccessQueryOptions(13, true).queryKey;
    const alpha = { fullAccess: false, pageKeys: ["accounts"], hiddenErpCostFields: ["daybook_amounts"] };
    const beta = { fullAccess: false, pageKeys: ["stock_items"], hiddenErpCostFields: ["stock_rates"] };
    client.setQueryData(alphaKey, alpha);
    client.setQueryData(betaKey, beta);
    expect(client.getQueryData(alphaKey)).toEqual(alpha);
    expect(client.getQueryData(betaKey)).toEqual(beta);
    expect(client.getQueryData(["/api/my-erp-pages"])).toBeUndefined();
    client.clear();
  });

});
