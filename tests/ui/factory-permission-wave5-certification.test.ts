// @vitest-environment jsdom
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  FACTORY_ACCESS_REGISTRY,
  FACTORY_PINNED_PAGES,
  FACTORY_SETTINGS_PAGES,
  factoryPageAllowsRole,
  resolveFactoryPage,
  resolveFactoryPageKey,
} from "@shared/factoryAccessRegistry";
import {
  DEPRECATED_FACTORY_HIDDEN_KEYS,
  FACTORY_TAB_REGISTRY,
  canonicalFactoryPageKey,
  normalizeAssignableFactoryPageKeys,
  normalizeFactoryHiddenFields,
  normalizePersistedFactoryPageKeysFailClosed,
} from "@shared/factoryPermissionCatalog";
import { computeFactoryDefaultPage, computeFactoryGuardRedirect, type MyAccess } from "@/app/factoryAccessGuard";
import { canonicalizeHubLocation } from "@/hooks/use-hub-query-state";

function readTree(root: string): string {
  return readdirSync(root)
    .flatMap((entry) => {
      const path = join(root, entry);
      const stats = statSync(path);
      if (stats.isDirectory()) return [readTree(path)];
      return /\.(?:ts|tsx)$/.test(entry) ? [readFileSync(path, "utf8")] : [];
    })
    .join("\n");
}

function guardedRedirect(access: MyAccess, currentLocation: string, userRole = "User", privileged = false) {
  const defaultPage = computeFactoryDefaultPage(access, userRole);
  return computeFactoryGuardRedirect({
    isFactoryRoute: true,
    isAdminOwner: privileged,
    userRole,
    myAccess: access,
    factorySettings: {},
    factoryDefaultPage: defaultPage,
    currentLocation,
  });
}

describe("Wave 5 Factory permission registry certification", () => {
  it("covers every mounted Factory route, including detail and compatibility routes", () => {
    const routesSource = readFileSync("client/src/components/FactoryRoutes.tsx", "utf8");
    const mountedRoutes = [...routesSource.matchAll(/<Route\s+path="(\/factory\/[^"]+)"/g)].map((match) => match[1]);

    expect(mountedRoutes.length).toBeGreaterThan(100);
    const uncovered = mountedRoutes.filter((route) => resolveFactoryPage(route) === null);
    expect(uncovered).toEqual([]);
  });

  it("keeps canonical page keys unique and removes obsolete V2/V3 permission entries", () => {
    const keys = FACTORY_ACCESS_REGISTRY.map((page) => page.key);
    const routes = FACTORY_ACCESS_REGISTRY.map((page) => page.route);

    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(routes).size).toBe(routes.length);
    expect(FACTORY_SETTINGS_PAGES.some((page) => page.key === "factory/stock-allocation-v2")).toBe(false);
    expect(FACTORY_SETTINGS_PAGES.some((page) => page.key === "factory/stock-allocation-v3")).toBe(false);
    expect(resolveFactoryPageKey("/factory/stock-allocation-v3")).toBe("factory/stock-allocation-v5");
  });

  it("keeps every used Factory tab in Settings and every Settings tab in active UI", () => {
    const source = [
      readTree("client/src/pages/factory"),
      readFileSync("client/src/pages/AccountsLegacy.tsx", "utf8"),
      readFileSync("client/src/pages/Vouchers.tsx", "utf8"),
    ].join("\n");

    const usedKeys = new Set(
      [...source.matchAll(/["']((?:hide_tab_[a-z0-9_]+)|(?:hide_invoicing_[a-z0-9_]+_tab))["']/g)].map(
        (match) => match[1]
      )
    );
    const settingsKeys = new Set<string>(FACTORY_TAB_REGISTRY.map((tab) => tab.key));

    const missingFromSettings = [...usedKeys].filter((key) => !settingsKeys.has(key));
    const unusedInUi = [...settingsKeys].filter((key) => !usedKeys.has(key));

    expect(missingFromSettings).toEqual([]);
    expect(unusedInUi).toEqual([]);
  });

  it("keeps backend page/tab ownership keys aligned with the shared registries", () => {
    const backend = readFileSync("server/middleware/factoryBackendAccessBoundary.ts", "utf8");
    const pageKeys = new Set(
      [...backend.matchAll(/requirement\("(factory\/[a-z0-9_\/-]+)"/g)].map((match) => match[1])
    );
    const tabKeys = new Set(
      [...backend.matchAll(/["']((?:hide_tab_[a-z0-9_]+)|(?:hide_invoicing_[a-z0-9_]+_tab))["']/g)].map(
        (match) => match[1]
      )
    );
    const canonicalPages = new Set<string>(FACTORY_ACCESS_REGISTRY.map((page) => page.key));
    const canonicalTabs = new Set<string>(FACTORY_TAB_REGISTRY.map((tab) => tab.key));

    expect([...pageKeys].filter((key) => !canonicalPages.has(key))).toEqual([]);
    expect([...tabKeys].filter((key) => !canonicalTabs.has(key))).toEqual([]);
  });

  it("retires the duplicate Factory visibility tree and its placeholder mappings", () => {
    const tree = readFileSync("client/src/pages/settings/PageVisibilityTree.tsx", "utf8");

    expect(tree).not.toContain("Needs mapping");
    expect(tree).not.toContain("factory/stock-allocation-v2");
    expect(tree).not.toContain("factory/stock-allocation-v3");
    expect(tree).toContain('data-testid="factory-visibility-managed-per-user"');
    expect(tree).toContain('t("settings.userManagement")');
    expect(tree).toContain('t("settings.selectUser")');
  });

  it("canonicalizes legacy page keys without widening stale persisted restrictions", () => {
    expect(canonicalFactoryPageKey("factory/raw-stock")).toBe("factory/raw-materials");
    expect(canonicalFactoryPageKey("factory/sales/loading/new")).toBe("factory/invoicing");
    expect(canonicalFactoryPageKey("factory/stock-allocation-v2")).toBe("factory/stock-allocation-v5");

    expect(
      normalizeAssignableFactoryPageKeys([
        "factory/raw-stock",
        "factory/raw-materials",
        "factory/stock-allocation-v3",
        "factory/not-real",
      ])
    ).toEqual(["factory/raw-materials", "factory/stock-allocation-v5"]);

    expect(normalizePersistedFactoryPageKeysFailClosed(["factory/not-real"])).toEqual(["factory/not-real"]);
    expect(normalizePersistedFactoryPageKeysFailClosed([])).toEqual([]);
  });

  it("removes deprecated/stale tab keys while preserving valid tab and cost restrictions", () => {
    expect(DEPRECATED_FACTORY_HIDDEN_KEYS.has("hide_tab_production_analytics")).toBe(true);
    expect(
      normalizeFactoryHiddenFields([
        "hide_tab_production_analytics",
        "hide_tab_stockentry_attendance_register",
        "hide_tab_daybook_transactions",
        "inventory_avg_rate",
      ])
    ).toEqual(["hide_tab_daybook_transactions", "inventory_avg_rate"]);
  });

  it("keeps migration v2 separate, idempotent, and never treats canonical Daybook as stale", () => {
    const migration = readFileSync("server/startup-schema/001-core-tables-and-columns.ts", "utf8");
    const wave5Start = migration.indexOf("// Wave 5 Factory permission canonicalization");
    const wave5End = migration.indexOf("// Add ledger account link to customer order charges", wave5Start);
    const wave5 = migration.slice(wave5Start, wave5End);
    const legacyV1 = migration.slice(0, wave5Start);

    expect(wave5Start).toBeGreaterThan(-1);
    expect(wave5End).toBeGreaterThan(wave5Start);
    expect(wave5).toContain("factory/stock-allocation-v2");
    expect(wave5).toContain("factory/stock-allocation-v3");
    expect(wave5).toContain("factory/stock-allocation-v5");
    expect(wave5).toContain("ON CONFLICT (company_id, user_id, page_key) DO NOTHING");
    expect(wave5).toContain("ON CONFLICT (key) DO NOTHING");
    expect(wave5).not.toMatch(/DELETE FROM factory_user_page_access[^;]+factory\/daybook/s);
    expect(legacyV1).not.toContain(
      "('factory/mix-batches', 'factory/sales/new', 'factory/bale-transfers', 'factory/create', 'factory/users', 'factory/daybook')"
    );
  });

  it("maps representative deep routes to the owning parent permission", () => {
    const cases: Array<[string, string]> = [
      ["/factory/vouchers/123/edit", "factory/vouchers"],
      ["/factory/customers/42", "factory/parties"],
      ["/factory/dispatch-batches/5/rides/9/scan", "factory/dispatch-batches"],
      ["/factory/raw-stock/opening-balance/5/edit", "factory/raw-materials"],
      ["/factory/sales/proformas/2/add-line", "factory/invoicing"],
      ["/factory/workers/88", "factory/payroll-hub"],
      ["/factory/ledger-vouchers/12/2026/9", "factory/accounts"],
    ];

    for (const [route, expectedKey] of cases) {
      expect(resolveFactoryPageKey(route), route).toBe(expectedKey);
    }
  });
});

describe("Wave 5 Factory user-profile certification", () => {
  const unrestricted: MyAccess = {
    fullAccess: true,
    pageKeys: [],
    hasErpAccess: true,
    hasFactoryAccess: true,
    hiddenCostFields: [],
  };
  const onePage: MyAccess = {
    ...unrestricted,
    fullAccess: false,
    pageKeys: ["factory/accounts"],
  };
  const severalPages: MyAccess = {
    ...unrestricted,
    fullAccess: false,
    pageKeys: ["factory/accounts", "factory/vouchers", "factory/daybook"],
  };
  const heavilyRestricted: MyAccess = {
    ...unrestricted,
    fullAccess: false,
    pageKeys: ["factory/stock-entry"],
    hiddenCostFields: FACTORY_TAB_REGISTRY.map((tab) => tab.key).filter((key) => key !== "hide_tab_stockentry_entry"),
  };

  it("certifies Admin, Owner and Developer role boundaries", () => {
    const adminPage = resolveFactoryPage("/factory/settings")!;
    const devPage = resolveFactoryPage("/factory/spreadsheet")!;

    expect(factoryPageAllowsRole(adminPage, "Admin")).toBe(true);
    expect(factoryPageAllowsRole(adminPage, "Owner")).toBe(true);
    expect(factoryPageAllowsRole(adminPage, "Developer")).toBe(true);
    expect(factoryPageAllowsRole(devPage, "Admin")).toBe(false);
    expect(factoryPageAllowsRole(devPage, "Owner")).toBe(false);
    expect(factoryPageAllowsRole(devPage, "Developer")).toBe(true);

    expect(guardedRedirect(unrestricted, "/factory/settings", "Admin", true)).toBeNull();
    expect(guardedRedirect(unrestricted, "/factory/settings", "Owner", true)).toBeNull();
    expect(guardedRedirect(unrestricted, "/factory/spreadsheet", "Developer", true)).toBeNull();
  });

  it("keeps an unrestricted normal user unrestricted on user-level pages", () => {
    expect(guardedRedirect(unrestricted, "/factory/accounts")).toBeNull();
    expect(guardedRedirect(unrestricted, "/factory/invoicing")).toBeNull();
  });

  it("certifies one-page-only direct URLs and inherited detail routes", () => {
    expect(guardedRedirect(onePage, "/factory/accounts")).toBeNull();
    expect(guardedRedirect(onePage, "/factory/ledger-monthly/55")).toBeNull();
    expect(guardedRedirect(onePage, "/factory/vouchers")).toBe("/factory/accounts");
    expect(guardedRedirect(onePage, "/factory/not-registered")).toBe("/factory/accounts");
  });

  it("certifies several-page users without widening the allow-list", () => {
    expect(guardedRedirect(severalPages, "/factory/accounts")).toBeNull();
    expect(guardedRedirect(severalPages, "/factory/vouchers/91/edit")).toBeNull();
    expect(guardedRedirect(severalPages, "/factory/daybook?tab=activity")).toBeNull();
    expect(guardedRedirect(severalPages, "/factory/raw-materials")).toBe("/factory/accounts");
  });

  it("certifies one-tab-only and heavily restricted query-string behavior", () => {
    window.history.replaceState({}, "", "/factory/stock-entry?tab=history#history");
    const active = canonicalizeHubLocation({
      key: "tab",
      allowedValues: ["entry"] as const,
      knownValues: ["entry", "history", "ground-scan", "daily-scan", "production-targets"] as const,
      defaultValue: "entry" as const,
    });

    expect(active).toBe("entry");
    expect(window.location.search).toBe("?tab=entry");
    expect(window.location.hash).toBe("");
    expect(guardedRedirect(heavilyRestricted, "/factory/stock-entry?tab=history")).toBeNull();
    expect(guardedRedirect(heavilyRestricted, "/factory/accounts")).toBe("/factory/stock-entry");
  });

  it("keeps pinned links backed by canonical registry entries", () => {
    expect(FACTORY_PINNED_PAGES.length).toBeGreaterThan(0);
    for (const page of FACTORY_PINNED_PAGES) {
      expect(resolveFactoryPage(page.route)?.key).toBe(page.key);
    }
  });
});
