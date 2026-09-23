import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  computeFactoryDefaultPage,
  computeFactoryGuardRedirect,
  resolvePageKey,
  type MyAccess,
} from "@/app/factoryAccessGuard";

const restrictedAccountsOnly: MyAccess = {
  fullAccess: false,
  pageKeys: ["factory/accounts"],
  hasErpAccess: true,
  hasFactoryAccess: true,
  hiddenCostFields: [],
};

describe("Factory per-user page restrictions", () => {
  it("resolves pinned and inherited Factory routes to managed page keys", () => {
    expect(resolvePageKey("/factory/accounts")).toBe("factory/accounts");
    expect(resolvePageKey("/factory/vouchers/123/edit")).toBe("factory/vouchers");
    expect(resolvePageKey("/factory/raw-stock/recalculate")).toBe("factory/raw-materials");
    expect(resolvePageKey("/factory/sales/loading/new")).toBe("factory/invoicing");
    expect(resolvePageKey("/factory/insurance")).toBe("factory/payroll-hub");
  });

  it("uses an allowed pinned page as the restricted user's landing page", () => {
    expect(computeFactoryDefaultPage(restrictedAccountsOnly)).toBe("/factory/accounts");
  });

  it("allows an assigned page and redirects an unassigned page", () => {
    expect(
      computeFactoryGuardRedirect({
        isFactoryRoute: true,
        isAdminOwner: false,
        myAccess: restrictedAccountsOnly,
        factorySettings: undefined,
        factoryDefaultPage: "/factory/accounts",
        currentLocation: "/factory/accounts",
      })
    ).toBeNull();

    expect(
      computeFactoryGuardRedirect({
        isFactoryRoute: true,
        isAdminOwner: false,
        myAccess: restrictedAccountsOnly,
        factorySettings: undefined,
        factoryDefaultPage: "/factory/accounts",
        currentLocation: "/factory/vouchers",
      })
    ).toBe("/factory/accounts");
  });

  it("enforces hidden tabs on direct and legacy Factory routes", () => {
    const hiddenCustomers: MyAccess = {
      ...restrictedAccountsOnly,
      fullAccess: true,
      pageKeys: [],
      hiddenCostFields: ["hide_tab_parties_customers"],
    };
    expect(
      computeFactoryGuardRedirect({
        isFactoryRoute: true,
        isAdminOwner: false,
        myAccess: hiddenCustomers,
        factorySettings: undefined,
        factoryDefaultPage: "/factory/production-report",
        currentLocation: "/factory/customers/12",
      })
    ).toBe("/factory/parties");

    const hiddenInvoices: MyAccess = {
      ...hiddenCustomers,
      hiddenCostFields: ["hide_invoicing_invoices_tab"],
    };
    expect(
      computeFactoryGuardRedirect({
        isFactoryRoute: true,
        isAdminOwner: false,
        myAccess: hiddenInvoices,
        factorySettings: undefined,
        factoryDefaultPage: "/factory/production-report",
        currentLocation: "/factory/sales/invoices/99",
      })
    ).toBe("/factory/invoicing");

    const hiddenBatches: MyAccess = {
      ...hiddenCustomers,
      hiddenCostFields: ["hide_tab_dispatch_batches"],
    };
    expect(
      computeFactoryGuardRedirect({
        isFactoryRoute: true,
        isAdminOwner: false,
        myAccess: hiddenBatches,
        factorySettings: undefined,
        factoryDefaultPage: "/factory/production-report",
        currentLocation: "/factory/dispatch-batches/7",
      })
    ).toBe("/factory/dispatch-batches");
    expect(
      computeFactoryGuardRedirect({
        isFactoryRoute: true,
        isAdminOwner: false,
        myAccess: hiddenBatches,
        factorySettings: undefined,
        factoryDefaultPage: "/factory/production-report",
        currentLocation: "/factory/dispatch-batches",
      })
    ).toBeNull();
  });

  it("default-denies unregistered Factory routes for restricted users", () => {
    expect(
      computeFactoryGuardRedirect({
        isFactoryRoute: true,
        isAdminOwner: false,
        myAccess: restrictedAccountsOnly,
        factorySettings: undefined,
        factoryDefaultPage: "/factory/accounts",
        currentLocation: "/factory/not-a-managed-page",
      })
    ).toBe("/factory/accounts");
  });
});

describe("Factory restriction settings wiring", () => {
  it("loads tenant-scoped Factory permission data in Factory mode", () => {
    const hub = readFileSync("client/src/pages/settings/UsersPermissionsHub.tsx", "utf8");
    const users = readFileSync("client/src/pages/settings/users/UsersSection.tsx", "utf8");
    const server = readFileSync("server/routes/factory/docs-users/usersAccessRoutes.ts", "utf8");

    expect(hub).toContain("<UsersSection appMode={appMode} />");
    expect(users).toContain('appMode === "factory" ? "/api/factory/users" : "/api/users"');
    expect(server).toContain("role: companyRole");
    expect(server).toContain('entry.pageKey.startsWith("factory/")');
  });

  it("shows stored Factory tab visibility with checked meaning visible", () => {
    const restrictions = readFileSync("client/src/pages/settings/users/AdvancedRestrictions.tsx", "utf8");
    expect(restrictions).toContain("Checked tabs are <strong>shown</strong> to this user.");
    expect(restrictions).toContain("checked={!hiddenCostFields.includes(tab.key)}");
    expect(restrictions).toContain("setFactoryTabVisible(tab.key, checked === true)");
  });

  it("exposes the expanded Factory page and tab catalogs", () => {
    const sidebar = readFileSync("client/src/components/FactorySidebar.tsx", "utf8");
    const constants = readFileSync("client/src/pages/settings/users/UserManagementConstants.tsx", "utf8");
    const tabRegistry = readFileSync("client/src/app/factoryTabAccessRegistry.ts", "utf8");

    for (const key of [
      "factory/production-report",
      "factory/agents",
      "factory/accounts",
      "factory/vouchers",
      "factory/stock-query",
      "factory/dispatch-batches",
      "factory/production-comparison",
    ]) {
      expect(sidebar).toContain(key);
    }
    expect(sidebar).toContain("!myAccess.pageKeys.includes(pageKey)");

    for (const key of [
      "hide_tab_parties_customers",
      "hide_tab_payrollhub_workers",
      "hide_tab_supplier_intel_report",
      "hide_tab_production_intel_summary",
      "hide_tab_overview_production",
      "hide_invoicing_invoices_tab",
    ]) {
      expect(tabRegistry).toContain(key);
    }
  });
});
