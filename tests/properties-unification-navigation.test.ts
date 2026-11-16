import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PROPERTIES_NAVIGATION,
  PROPERTIES_LEGACY_RENTAL_REDIRECTS,
  PROPERTIES_RENTAL_TABS,
  canNavigateProperties,
  findPropertiesNavigationEntry,
} from "../client/src/properties/config/propertiesNavigation";

const property = { companyType: "properties" as const, role: "User" };
const admin = { companyType: "properties" as const, role: "Admin" };
const developer = { companyType: "properties" as const, role: "Developer" };
const source = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

describe("Phase 10 Properties navigation and legacy compatibility", () => {
  it("keeps exactly six visible pinned workspace roots without the compatibility dashboard", () => {
    const pinned = PROPERTIES_NAVIGATION.filter((entry) => entry.navigation === "pinned");
    expect(pinned.map((entry) => entry.path)).toEqual([
      "/properties/daybook", "/properties/agents", "/properties/rentals",
      "/properties/accounts", "/properties/vouchers", "/properties/analytics",
    ]);
    expect(findPropertiesNavigationEntry("/properties/dashboard")?.navigation).toBe("hidden");
    expect(canNavigateProperties("/properties/dashboard", { role: "User" }, property)).toBe(true);
    expect(pinned.some((entry) => entry.path === "/properties/dashboard")).toBe(false);
  });

  it("preserves all three rental tabs and every legacy replacement target", () => {
    expect(PROPERTIES_RENTAL_TABS.map((tab) => tab.value)).toEqual(["warehouses", "shops", "payments"]);
    expect(PROPERTIES_LEGACY_RENTAL_REDIRECTS).toEqual({
      "/properties/rental/warehouses": "/properties/rentals",
      "/properties/rental/shops": "/properties/rentals?tab=shops",
      "/properties/rental/payments": "/properties/rentals?tab=payments",
    });
    for (const path of Object.values(PROPERTIES_LEGACY_RENTAL_REDIRECTS)) {
      expect(findPropertiesNavigationEntry(path)).toBeDefined();
    }
  });

  it("recognizes concrete voucher and ledger URLs and does not match arbitrary prefixes", () => {
    for (const path of [
      "/properties/vouchers/123/edit",
      "/properties/voucher-detail/456",
      "/properties/ledger-monthly/12",
      "/properties/ledger-vouchers/12/2026/11",
    ]) {
      expect(canNavigateProperties(path, { currentRole: "User" }, property)).toBe(true);
    }
    for (const path of [
      "/properties/vouchers/123/edit/extra",
      "/properties/vouchers//edit",
      "/properties/ledger-monthly",
      "/properties/unknown",
      "/properties/dashboard-malicious",
      "/properties/rentals/not-a-tab",
    ]) {
      expect(findPropertiesNavigationEntry(path)).toBeUndefined();
    }
  });

  it("resolves recognized tab query URLs and tolerates benign query parameters", () => {
    expect(findPropertiesNavigationEntry("/properties/rentals?tab=shops")?.label).toBe("Shops");
    expect(findPropertiesNavigationEntry("/properties/rentals?tab=payments&from=bookmark")?.label).toBe("Payments");
    expect(findPropertiesNavigationEntry("/properties/rentals?tab=invalid")?.label).toBe("Rentals");
    expect(canNavigateProperties("/properties/rentals?tab=shops", { role: "User" }, property)).toBe(true);
    expect(canNavigateProperties("/properties/rentals?tab=shops", { role: "User" }, { companyType: "erp", role: "User" })).toBe(false);
  });

  it("uses selected-company role for developer and admin direct links, including query URLs", () => {
    expect(canNavigateProperties("/properties/settings", { role: "Developer" }, property)).toBe(false);
    expect(canNavigateProperties("/properties/settings", { role: "User" }, admin)).toBe(true);
    expect(canNavigateProperties("/properties/accounting/toolbox", { role: "Admin" }, admin)).toBe(false);
    expect(canNavigateProperties("/properties/accounting/toolbox", { role: "User" }, developer)).toBe(true);
    expect(canNavigateProperties("/properties/transfer", { role: "User" }, developer)).toBe(true);
    expect(canNavigateProperties("/properties/my-settings", { role: "ERP Tester" }, { ...property, role: "ERP Tester" })).toBe(false);
  });

  it("keeps registered dashboard actions and a directly routed compatibility page", () => {
    const routeSource = source("../client/src/app/PropertiesRoutes.tsx");
    const pageSource = source("../client/src/pages/properties/PropertiesDashboard.tsx");
    expect(routeSource).toContain('<Route path="/properties/dashboard" component={PropertiesDashboard} />');
    expect(pageSource).toContain("apiRequest");
    expect(pageSource).toContain("dashboard-cash-accounts");
    expect(pageSource).toContain("dashboard-payable-accounts");
    expect(routeSource).toContain('Object.entries(PROPERTIES_LEGACY_RENTAL_REDIRECTS).map');
    expect(routeSource).toContain("<Redirect replace to={to} />");
    expect(routeSource).toContain('<Redirect replace to="/properties/daybook" />');
  });

  it("pins sidebar icons by pathname, so manifest ordering cannot change visual meaning", () => {
    const sidebar = source("../client/src/components/PropertiesSidebar.tsx");
    expect(sidebar).toContain("pinnedIconsByPath");
    expect(sidebar).not.toContain("pinnedIcons[index]");
  });
});
