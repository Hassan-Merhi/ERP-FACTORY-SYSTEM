/**
 * ERP navigation policy: role resolution, declared role routes, each role
 * restriction rule and each visibility rule (retail hiding, company-type pages,
 * the POS subset, full access and feature-grant filtering).
 */
import { describe, expect, it } from "vitest";

import {
  canEnterErpGuardedRoute,
  effectiveErpRole,
  isErpDeclaredRoleRoute,
  isErpNavigationItemVisible,
  isErpRetailHiddenPath,
  isErpRouteRoleAllowed,
} from "../shared/erpNavigationPolicy";

describe("effectiveErpRole", () => {
  it("prefers the current role, then the stored role, then empty", () => {
    expect(effectiveErpRole({ currentRole: "Owner", role: "Admin" })).toBe("Owner");
    expect(effectiveErpRole({ currentRole: null, role: "Admin" })).toBe("Admin");
    expect(effectiveErpRole({})).toBe("");
    expect(effectiveErpRole(undefined)).toBe("");
  });
});

describe("declared role routes", () => {
  it("recognises every catalog and strips query strings and hashes", () => {
    expect(isErpDeclaredRoleRoute("/accounting/anything?x=1")).toBe(true);
    expect(isErpDeclaredRoleRoute("/ai-validation#top")).toBe(true);
    expect(isErpDeclaredRoleRoute("/settings")).toBe(true);
    expect(isErpDeclaredRoleRoute("/convergence-reconciliation")).toBe(true);
    expect(isErpDeclaredRoleRoute("/my-settings")).toBe(true);
    expect(isErpDeclaredRoleRoute("/vouchers")).toBe(false);
    expect(isErpDeclaredRoleRoute("")).toBe(true);
  });

  it("only lets declared routes through the guarded entry and fails closed for unknown ones", () => {
    expect(canEnterErpGuardedRoute("/vouchers", "Developer")).toBe(false);
    expect(canEnterErpGuardedRoute("/settings", "Admin")).toBe(true);
    expect(canEnterErpGuardedRoute("/settings", "Owner")).toBe(false);
  });

  it("detects retail hidden paths", () => {
    expect(isErpRetailHiddenPath("/stock?tab=1")).toBe(true);
    expect(isErpRetailHiddenPath("/vouchers")).toBe(false);
  });
});

describe("isErpRouteRoleAllowed", () => {
  it.each([
    ["/cost-centers", "Developer", true],
    ["/cost-centers", "Admin", false],
    ["/ai-command-center", "Developer", true],
    ["/ai-command-center", "Owner", false],
    ["/settings", "Developer", true],
    ["/settings", "Admin", true],
    ["/settings", "Owner", false],
    ["/accounts/historical-openings", "Developer", true],
    ["/accounts/historical-openings", "Admin", true],
    ["/accounts/historical-openings", "Owner", true],
    ["/accounts/historical-openings", "Accountant", false],
    ["/financial-overview", "View Only", false],
    ["/financial-overview", "Create Only", false],
    ["/financial-overview", "Accountant", true],
    ["/transaction-journal", "ERP Tester", false],
    ["/transaction-journal", "Accountant", true],
    ["/my-settings", "ERP Tester", false],
    ["/my-settings", "Accountant", true],
    ["/pos-item-replacement", "POS", false],
    ["/pos-item-replacement", "Accountant", true],
    ["/vouchers", null, true],
  ])("%s for %s -> %s", (path, role, allowed) => {
    expect(isErpRouteRoleAllowed(path, role)).toBe(allowed);
  });
});

describe("isErpNavigationItemVisible", () => {
  const grants = (...pageKeys: string[]) => ({ fullAccess: false, pageKeys });

  it("hides role-refused and retail-hidden pages", () => {
    expect(isErpNavigationItemVisible({ role: "Owner", path: "/settings" })).toBe(false);
    expect(isErpNavigationItemVisible({ role: "Developer", path: "/stock", companyType: "retail" })).toBe(false);
    expect(isErpNavigationItemVisible({ role: "Developer", path: "/stock", companyType: "erp" })).toBe(true);
  });

  it("hides tracking from POS users only", () => {
    expect(isErpNavigationItemVisible({ role: "POS", path: "/tracking" })).toBe(false);
    expect(isErpNavigationItemVisible({ role: "Accountant", path: "/tracking" })).toBe(true);
  });

  it("limits company-type pages", () => {
    for (const companyType of ["factory", "factory_v2"]) {
      expect(isErpNavigationItemVisible({ role: "Admin", path: "/factory/raw-stock", companyType })).toBe(true);
    }
    expect(isErpNavigationItemVisible({ role: "Admin", path: "/factory/raw-stock", companyType: "erp" })).toBe(false);
    expect(isErpNavigationItemVisible({ role: "Admin", path: "/item-market-analysis", companyType: "erp" })).toBe(true);
    expect(isErpNavigationItemVisible({ role: "Admin", path: "/item-market-analysis", companyType: "retail" })).toBe(
      false
    );
  });

  it("shows POS users only their curated pages and import when enabled", () => {
    expect(isErpNavigationItemVisible({ role: "POS", path: "/pos" })).toBe(true);
    expect(isErpNavigationItemVisible({ role: "POS", path: "/vouchers" })).toBe(false);
    expect(isErpNavigationItemVisible({ role: "POS", path: "/pos-import" })).toBe(false);
    expect(isErpNavigationItemVisible({ role: "POS", path: "/pos-import", posExcelImportEnabled: true })).toBe(true);
  });

  it("shows everything to developers, admins and full-access users", () => {
    expect(isErpNavigationItemVisible({ role: "Developer", path: "/stock", access: grants() })).toBe(true);
    expect(isErpNavigationItemVisible({ role: "Admin", path: "/stock", access: grants() })).toBe(true);
    expect(
      isErpNavigationItemVisible({ role: "Accountant", path: "/stock", access: { fullAccess: true, pageKeys: [] } })
    ).toBe(true);
  });

  it("filters other roles by feature grants", () => {
    expect(isErpNavigationItemVisible({ role: "Accountant", path: "/stock", access: grants("stock_query") })).toBe(
      true
    );
    expect(isErpNavigationItemVisible({ role: "Accountant", path: "/stock", access: grants("customers") })).toBe(false);
    // A route without feature keys is hidden when the user has no grants at all...
    expect(isErpNavigationItemVisible({ role: "Accountant", path: "/no-feature-page", access: grants() })).toBe(false);
    // ...but shown when the user has some grants, or when no access record is supplied.
    expect(
      isErpNavigationItemVisible({ role: "Accountant", path: "/no-feature-page", access: grants("customers") })
    ).toBe(true);
    expect(isErpNavigationItemVisible({ role: "Accountant", path: "/stock" })).toBe(true);
  });
});
