/**
 * Canonical Factory page-access registry.
 *
 * This file is intentionally UI-framework agnostic. Settings, sidebar navigation,
 * route guards and landing-page resolution all consume this same registry so
 * Factory page access cannot drift between separate hard-coded lists.
 */
export type FactoryAccessLevel = "user" | "admin" | "developer";

export interface FactoryPageDefinition {
  key: string;
  label: string;
  group: string;
  route: string;
  aliases?: readonly string[];
  sidebar?: boolean;
  pinned?: boolean;
  settingsVisible?: boolean;
  landing?: boolean;
  accessLevel?: FactoryAccessLevel;
  featureFlag?: string;
  featureFlagDefaultOn?: boolean;
  hideKey?: string;
}

export const FACTORY_ACCESS_REGISTRY: readonly FactoryPageDefinition[] = [
  // Pinned / primary
  {
    key: "factory/production-report",
    label: "Overview",
    group: "Production",
    route: "/factory/production-report",
    aliases: ["/factory/bale-ledger", "/factory/pos"],
    pinned: true,
    landing: true,
  },
  {
    key: "factory/agents",
    label: "Agent Ledger",
    group: "Finance",
    route: "/factory/agents",
    pinned: true,
    landing: true,
  },
  {
    key: "factory/accounts",
    label: "Accounts",
    group: "Finance",
    route: "/factory/accounts",
    aliases: ["/factory/ledger-monthly", "/factory/ledger-vouchers", "/factory/create"],
    pinned: true,
    landing: true,
  },
  {
    key: "factory/daybook",
    label: "Daybook",
    group: "Finance",
    route: "/factory/daybook",
    pinned: true,
    sidebar: true,
    landing: true,
  },
  {
    key: "factory/vouchers",
    label: "Vouchers",
    group: "Finance",
    route: "/factory/vouchers",
    aliases: ["/factory/voucher-detail"],
    pinned: true,
    landing: true,
  },

  // Production
  {
    key: "factory/stock-entry",
    label: "Stock Entry",
    group: "Production",
    route: "/factory/stock-entry",
    aliases: ["/factory/pressing", "/factory/finalize"],
    sidebar: true,
    landing: true,
  },
  {
    key: "factory/raw-materials",
    label: "Raw Materials",
    group: "Production",
    route: "/factory/raw-materials",
    aliases: ["/factory/raw-stock"],
    sidebar: true,
    landing: true,
  },
  {
    key: "factory/waste-dispatch",
    label: "Waste Dispatch",
    group: "Production",
    route: "/factory/waste-dispatch",
    sidebar: true,
    landing: true,
  },
  {
    key: "factory/bales-hub",
    label: "Bale Explorer",
    group: "Production",
    route: "/factory/bales-hub",
    aliases: [
      "/factory/bale-products",
      "/factory/bale-product-history",
      "/factory/reprint-labels",
      "/factory/bales-history",
      "/factory/barcode-lookup",
    ],
    sidebar: true,
    landing: true,
  },
  {
    key: "factory/bale-relabeling",
    label: "Bale Relabeling",
    group: "Production",
    route: "/factory/bale-relabeling",
    landing: true,
  },
  {
    key: "factory/production-comparison",
    label: "Production Comparison",
    group: "Production",
    route: "/factory/production-comparison",
    landing: true,
  },

  // Sales
  {
    key: "factory/invoicing",
    label: "Invoicing",
    group: "Sales",
    route: "/factory/invoicing",
    aliases: [
      "/factory/sales/new",
      "/factory/sales/loading",
      "/factory/sales/loadings",
      "/factory/sales/pending-invoices",
      "/factory/invoices",
      "/factory/sales/invoices",
      "/factory/sales/proformas",
    ],
    sidebar: true,
    landing: true,
  },
  {
    key: "factory/price-list",
    label: "Price List",
    group: "Sales",
    route: "/factory/price-list",
    landing: true,
  },
  {
    key: "factory/dispatch-batches",
    label: "Dispatch Batches",
    group: "Sales",
    route: "/factory/dispatch-batches",
    landing: true,
  },

  // Inventory
  {
    key: "factory/location-inventory",
    label: "Location Inventory",
    group: "Inventory",
    route: "/factory/location-inventory",
    sidebar: true,
    landing: true,
  },
  {
    key: "factory/containers-hub",
    label: "Containers",
    group: "Inventory",
    route: "/factory/containers-hub",
    aliases: ["/factory/containers", "/factory/stock-otw"],
    sidebar: true,
    landing: true,
  },
  {
    key: "factory/stock-allocation-v5",
    label: "Stock Allocation",
    group: "Inventory",
    route: "/factory/stock-allocation-v5",
    aliases: ["/factory/stock-allocation", "/factory/stock-allocation-v3"],
    sidebar: true,
    landing: true,
  },
  {
    key: "factory/sheets-sacks",
    label: "Sheets & Sacks",
    group: "Inventory",
    route: "/factory/sheets-sacks",
    sidebar: true,
    landing: true,
  },
  {
    key: "factory/stock-query",
    label: "Stock Query",
    group: "Inventory",
    route: "/factory/stock-query",
    landing: true,
  },
  {
    key: "factory/stock-bale-list",
    label: "Stock Bale List",
    group: "Inventory",
    route: "/factory/stock-bale-list",
    landing: true,
  },
  {
    key: "factory/bale-tracking",
    label: "Bale Tracking",
    group: "Inventory",
    route: "/factory/bale-tracking",
    landing: true,
  },
  {
    key: "factory/import",
    label: "Import",
    group: "Inventory",
    route: "/factory/import",
    landing: true,
  },
  {
    key: "factory/merge-bale-products",
    label: "Merge Bale Products",
    group: "Inventory",
    route: "/factory/merge-bale-products",
    landing: true,
  },
  {
    key: "factory/bale-product-images",
    label: "Bale Product Images",
    group: "Inventory",
    route: "/factory/bale-product-images",
    landing: true,
  },

  // Finance
  {
    key: "factory/parties",
    label: "Parties",
    group: "Finance",
    route: "/factory/parties",
    aliases: ["/factory/customers", "/factory/suppliers"],
    sidebar: true,
    landing: true,
  },
  {
    key: "factory/contacts",
    label: "Contacts",
    group: "Finance",
    route: "/factory/contacts",
    sidebar: true,
    landing: true,
  },
  {
    key: "factory/payroll-hub",
    label: "Payroll & Benefits",
    group: "Finance",
    route: "/factory/payroll-hub",
    aliases: [
      "/factory/finance",
      "/factory/payroll",
      "/factory/worker-payroll",
      "/factory/workers",
      "/factory/employees",
      "/factory/insurance",
    ],
    sidebar: true,
    landing: true,
  },
  {
    key: "factory/analytics",
    label: "Analytics",
    group: "Finance",
    route: "/factory/analytics",
    aliases: ["/factory/financial-snapshot"],
    sidebar: true,
    settingsVisible: false,
    accessLevel: "admin",
  },
  {
    key: "factory/transporters",
    label: "Transporters",
    group: "Finance",
    route: "/factory/transporters",
    landing: true,
  },
  {
    key: "factory/broker-visual-statement",
    label: "Broker Statement",
    group: "Finance",
    route: "/factory/broker-visual-statement",
    landing: true,
  },

  // Rentals
  {
    key: "factory/rental/shops",
    label: "Shops",
    group: "Rentals",
    route: "/factory/rental/shops",
    sidebar: true,
    landing: true,
  },
  {
    key: "factory/rental/warehouses",
    label: "Warehouses",
    group: "Rentals",
    route: "/factory/rental/warehouses",
    sidebar: true,
    settingsVisible: false,
    accessLevel: "developer",
  },
  {
    key: "factory/rental/payments",
    label: "Payments",
    group: "Rentals",
    route: "/factory/rental/payments",
    sidebar: true,
    settingsVisible: false,
    accessLevel: "developer",
  },

  // Intelligence (developer workspace)
  {
    key: "factory/intelligence/dashboard",
    label: "Factory Dashboard",
    group: "Intelligence",
    route: "/factory/intelligence/dashboard",
    sidebar: true,
    settingsVisible: false,
    accessLevel: "developer",
    featureFlag: "dashboardEnabled",
  },
  {
    key: "factory/intelligence/kpis",
    label: "KPIs",
    group: "Intelligence",
    route: "/factory/intelligence/kpis",
    sidebar: true,
    settingsVisible: false,
    accessLevel: "developer",
    featureFlag: "kpisEnabled",
  },
  {
    key: "factory/intelligence/supplier-hub",
    label: "Supplier Intel",
    group: "Intelligence",
    route: "/factory/intelligence/supplier-hub",
    aliases: ["/factory/supplier-report", "/factory/supplier-statement", "/factory/intelligence/supplier-scores"],
    sidebar: true,
    settingsVisible: false,
    accessLevel: "developer",
    featureFlag: "supplierReportEnabled",
  },
  {
    key: "factory/intelligence/financial-hub",
    label: "Financial Intel",
    group: "Intelligence",
    route: "/factory/intelligence/financial-hub",
    aliases: [
      "/factory/intelligence/profitability",
      "/factory/intelligence/cashflow",
      "/factory/net-position-details",
      "/factory/net-position",
      "/factory/net-profit-analytics",
    ],
    sidebar: true,
    settingsVisible: false,
    accessLevel: "developer",
    featureFlag: "netProfitEnabled",
  },
  {
    key: "factory/intelligence/production-hub",
    label: "Production Intel",
    group: "Intelligence",
    route: "/factory/intelligence/production-hub",
    aliases: ["/factory/production-summary", "/factory/intelligence/mix-optimizer", "/factory/intelligence/waste"],
    sidebar: true,
    settingsVisible: false,
    accessLevel: "developer",
    featureFlag: "productionSummaryEnabled",
  },
  {
    key: "factory/intelligence/alerts",
    label: "Alerts",
    group: "Intelligence",
    route: "/factory/intelligence/alerts",
    sidebar: true,
    settingsVisible: false,
    accessLevel: "developer",
    featureFlag: "alertsEnabled",
  },
  {
    key: "factory/intelligence/settings",
    label: "Intel Settings",
    group: "Intelligence",
    route: "/factory/intelligence/settings",
    sidebar: true,
    settingsVisible: false,
    accessLevel: "developer",
  },

  // System / utility pages
  {
    key: "factory/conflicts",
    label: "Conflicts",
    group: "Other",
    route: "/factory/conflicts",
    landing: true,
  },
  {
    key: "factory/settings",
    label: "Settings",
    group: "Other",
    route: "/factory/settings",
    aliases: ["/factory/users", "/factory/customer-logos", "/factory/label-banners"],
    settingsVisible: false,
    accessLevel: "admin",
  },
  {
    key: "factory/spreadsheet",
    label: "Spreadsheet",
    group: "Other",
    route: "/factory/spreadsheet",
    settingsVisible: false,
    accessLevel: "developer",
  },
  {
    key: "factory/chat",
    label: "Chat",
    group: "Other",
    route: "/factory/chat",
    settingsVisible: false,
    accessLevel: "developer",
  },
  {
    key: "factory/location-inventory-mockup",
    label: "Location Inventory Mockup",
    group: "Other",
    route: "/factory/location-inventory-mockup",
    settingsVisible: false,
    accessLevel: "developer",
  },
  {
    key: "factory/account-groups",
    label: "Account Groups",
    group: "Other",
    route: "/factory/account-groups",
    settingsVisible: false,
    accessLevel: "admin",
  },
  {
    key: "factory/deleted-items",
    label: "Deleted Items",
    group: "Other",
    route: "/factory/deleted-items",
    settingsVisible: false,
    accessLevel: "admin",
  },
  {
    key: "factory/orphaned-records",
    label: "Orphaned Records",
    group: "Other",
    route: "/factory/orphaned-records",
    settingsVisible: false,
    accessLevel: "admin",
  },
  {
    key: "factory/chatbot-settings",
    label: "Chatbot Settings",
    group: "Other",
    route: "/factory/chatbot-settings",
    settingsVisible: false,
    accessLevel: "admin",
  },
  {
    key: "factory/import-cycle-diagnostics",
    label: "Import Cycle Diagnostics",
    group: "Other",
    route: "/factory/import-cycle-diagnostics",
    settingsVisible: false,
    accessLevel: "admin",
  },
  {
    key: "factory/inventory-repair",
    label: "Inventory Repair",
    group: "Other",
    route: "/factory/inventory-repair",
    settingsVisible: false,
    accessLevel: "admin",
  },
  {
    key: "factory/company-data-reset",
    label: "Company Data Reset",
    group: "Other",
    route: "/factory/company-data-reset",
    settingsVisible: false,
    accessLevel: "admin",
  },
] as const;

export const FACTORY_SETTINGS_PAGES = FACTORY_ACCESS_REGISTRY.filter(
  (page) => page.settingsVisible !== false && (page.accessLevel ?? "user") === "user"
);

export const FACTORY_SIDEBAR_PAGES = FACTORY_ACCESS_REGISTRY.filter((page) => page.sidebar === true);
export const FACTORY_PINNED_PAGES = FACTORY_ACCESS_REGISTRY.filter((page) => page.pinned === true);
export const FACTORY_LANDING_PAGES = FACTORY_ACCESS_REGISTRY.filter(
  (page) => page.landing === true && page.settingsVisible !== false
);

export const FACTORY_SUBPAGE_PARENT: [prefix: string, parentKey: string][] = FACTORY_ACCESS_REGISTRY.flatMap((page) =>
  (page.aliases ?? []).map((alias) => [alias, page.key] as [string, string])
);

export function normalizeFactoryAccessPath(path: string): string {
  const queryIndex = path.indexOf("?");
  const hashIndex = path.indexOf("#");
  const cutAt = [queryIndex, hashIndex].filter((index) => index >= 0).sort((a, b) => a - b)[0];
  const normalized = cutAt === undefined ? path : path.slice(0, cutAt);
  return normalized || "/";
}

function pathMatchesPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix + "/");
}

export function resolveFactoryPage(path: string): FactoryPageDefinition | null {
  const normalizedPath = normalizeFactoryAccessPath(path);

  // Most-specific route wins so a protected child page cannot be swallowed by
  // a broader canonical page prefix.
  const direct = [...FACTORY_ACCESS_REGISTRY]
    .sort((a, b) => b.route.length - a.route.length)
    .find((page) => pathMatchesPrefix(normalizedPath, page.route));
  if (direct) return direct;

  const aliasMatch = FACTORY_ACCESS_REGISTRY.flatMap((page) =>
    (page.aliases ?? []).map((alias) => ({ page, alias }))
  )
    .sort((a, b) => b.alias.length - a.alias.length)
    .find(({ alias }) => pathMatchesPrefix(normalizedPath, alias));

  return aliasMatch?.page ?? null;
}

export function resolveFactoryPageKey(path: string): string | null {
  return resolveFactoryPage(path)?.key ?? null;
}

export function factoryPageAllowsRole(page: FactoryPageDefinition, role?: string | null): boolean {
  const level = page.accessLevel ?? "user";
  if (level === "developer") return role === "Developer";
  if (level === "admin") return role === "Admin" || role === "Owner" || role === "Developer";
  return true;
}

export function hasFactoryPageKey(page: FactoryPageDefinition, pageKeys: readonly string[]): boolean {
  if (pageKeys.includes(page.key)) return true;
  return (page.aliases ?? []).some((alias) => pageKeys.includes(alias.replace(/^\//, "")));
}
