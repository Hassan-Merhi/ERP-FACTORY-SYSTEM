/**
 * Route tables for the Factory mobile rendered regression (scripts/verify-factory-mobile-browser.mjs).
 * Kept apart so the route inventory can grow without growing the runner.
 */

/** Canonical Factory destinations (docs/factory-navigation-registry.md) and key workflows. */
export const STATIC_ROUTES = [
  // Production / inventory
  "/factory/production-report",
  "/factory/stock-entry",
  "/factory/raw-materials",
  "/factory/raw-stock",
  "/factory/waste-dispatch",
  "/factory/bales-hub",
  "/factory/location-inventory",
  "/factory/containers-hub",
  "/factory/stock-allocation-v5",
  "/factory/sheets-sacks",
  "/factory/stock-query",
  // Finance / people
  "/factory/daybook",
  "/factory/accounts",
  "/factory/vouchers",
  "/factory/parties",
  "/factory/contacts",
  "/factory/payroll-hub",
  // Sales
  "/factory/invoicing",
  "/factory/sales/new",
  "/factory/sales/loading/new",
  "/factory/dispatch-batches",
  // Intelligence
  "/factory/intelligence/dashboard",
  "/factory/intelligence/kpis",
  "/factory/intelligence/alerts",
  "/factory/intelligence/supplier-hub",
  "/factory/intelligence/financial-hub",
  "/factory/intelligence/production-hub",
  "/factory/financial-snapshot",
  "/factory/net-position-details",
  "/factory/production-comparison",
  // Other
  "/factory/rental/shops",
  "/factory/rental/warehouses",
  "/factory/rental/payments",
  "/factory/settings",
  "/factory/containers/new",
  "/factory/analytics",
  "/factory/agents",
  // Forms and admin tools (Phase 10)
  "/factory/create",
  "/factory/raw-stock/recalculate",
  "/factory/customer-logos",
  "/factory/label-banners",
  "/factory/intelligence/settings",
  "/factory/chatbot-settings",
  "/factory/conflicts",
  "/factory/deleted-items",
  "/factory/import-cycle-diagnostics",
  "/factory/inventory-repair",
  "/factory/company-data-reset",
  "/my-settings",
  // Every hub section/tab, not only the default one
  "/factory/production-report?tab=production",
  "/factory/production-report?tab=comparison",
  "/factory/production-report?tab=product-comparison",
  "/factory/production-report?tab=shipping",
  "/factory/production-report?tab=sheets",
  "/factory/production-report?tab=container-tracking",
  "/factory/bales-hub?tab=barcode",
  "/factory/bales-hub?tab=products",
  "/factory/bales-hub?tab=customer-loading",
  "/factory/containers-hub?section=otw",
  "/factory/invoicing?tab=loadings",
  "/factory/invoicing?tab=pending",
  "/factory/invoicing?tab=proformas",
  "/factory/parties?section=suppliers",
  "/factory/payroll-hub?section=employees",
  "/factory/payroll-hub?section=insurance",
  "/factory/intelligence/supplier-hub?section=statement",
  "/factory/intelligence/supplier-hub?section=scores",
  "/factory/intelligence/production-hub?section=waste",
  "/factory/intelligence/production-hub?section=mix-optimizer",
  "/factory/intelligence/production-hub?section=container-tracking",
];


/**
 * A safe dialog or sheet per route (never a submit action). The regression opens it, checks it
 * fits the viewport, scrolls internally, keeps its last action reachable and keeps a focused field
 * in view, then closes it with Escape, which must not navigate.
 */
export const DIALOG_TRIGGERS = [
  { route: "/factory/contacts", selector: '[data-testid="button-add-contact"]' },
  { route: "/factory/sheets-sacks", selector: '[data-testid="button-add-item"]' },
  { route: "/factory/dispatch-batches", selector: '[data-testid="button-new-dispatch-batch"]', exact: true },
  { route: "/factory/rental/shops", selector: '[data-testid="button-factory-rental-shops-add-unit"]' },
  { route: "/factory/daybook", selector: '[data-testid="factory-daybook-filters-open"]', phoneOnly: true },
  {
    route: "/factory/production-comparison",
    selector: '[data-testid="production-comparison-filters-open"]',
    phoneOnly: true,
  },
  { route: "/factory/employees/", selector: '[data-testid="button-edit-employee"]' },
  // Data-dependent: skipped (not failed) when the list has no matching row.
  {
    route: "/factory/containers-hub",
    selector: '[data-testid^="button-view-container-"]',
    exact: true,
    optional: true,
  },
  {
    route: "/factory/containers-hub?section=otw",
    selector: '[data-testid^="button-otw-edit-"], [data-testid^="button-tracking-settings-"]',
    exact: true,
    optional: true,
  },
];


/** Detail/workflow routes that need an existing record; ids resolve at runtime. */
export const SEEDED_ROUTES = [
  { key: "order", path: (s) => `/factory/sales/invoices/${s.order}` },
  { key: "order", path: (s) => `/factory/invoices/${s.order}/loading-scan` },
  { key: "order", path: (s) => `/factory/sales/pending-invoices/${s.order}/verify` },
  { key: "batch", path: (s) => `/factory/dispatch-batches/${s.batch}` },
  { key: "ride", path: (s) => `/factory/dispatch-batches/${s.batch}/rides/${s.ride}/scan` },
  { key: "customer", path: (s) => `/factory/customers/${s.customer}` },
  { key: "employee", path: (s) => `/factory/employees/${s.employee}` },
  { key: "worker", path: (s) => `/factory/workers/${s.worker}` },
  { key: "proforma", path: (s) => `/factory/sales/proformas/${s.proforma}/add-line` },
  { key: "product", path: (s) => `/factory/stock-query/${s.product}` },
  { key: "productLocation", path: (s) => `/factory/bale-product-history/${s.product}/${s.location}` },
  { key: "productLocation", path: (s) => `/factory/bale-product-history/${s.product}/${s.location}/2026/all` },
  { key: "productLocation", path: (s) => `/factory/bale-product-history/${s.product}/${s.location}/2026/9` },
  { key: "account", path: (s) => `/factory/ledger-monthly/${s.account}` },
  { key: "account", path: (s) => `/factory/ledger-vouchers/${s.account}/2026/9` },
  { key: "voucher", path: (s) => `/factory/voucher-detail/${s.voucher}` },
  { key: "voucher", path: (s) => `/factory/vouchers/${s.voucher}/edit` },
  { key: "openingBalance", path: (s) => `/factory/raw-stock/opening-balance/${s.openingBalance}/edit` },
];

/** Seed keys a seeded route needs (composite keys expand to their parts). */
export const SEED_KEYS = { ride: ["batch", "ride"], productLocation: ["product", "location"] };
