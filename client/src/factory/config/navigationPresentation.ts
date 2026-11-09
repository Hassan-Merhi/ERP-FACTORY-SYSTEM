/**
 * Factory-only navigation presentation metadata.
 * Canonical page destinations and role gates remain in factoryAccessRegistry.
 * This table only controls visibility of nested hub tabs and never grants access.
 */
export const FACTORY_HUB_HIDDEN_TABS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "/factory/bales-hub": {
    history: "hide_tab_bales_history",
    barcode: "hide_tab_bales_barcode",
    products: "hide_tab_bales_products",
    "customer-loading": "hide_tab_bales_customer_loading",
  },
  "/factory/invoicing": {
    proformas: "hide_invoicing_proformas_tab",
    invoices: "hide_invoicing_invoices_tab",
    loadings: "hide_invoicing_loadings_tab",
    pending: "hide_tab_loadings_pending",
    priority: "hide_tab_loadings_pending",
  },
  "/factory/sales/loadings": {
    loadings: "hide_invoicing_loadings_tab",
    pending: "hide_tab_loadings_pending",
    priority: "hide_tab_loadings_pending",
  },
  "/factory/parties": {
    customers: "hide_tab_parties_customers",
    suppliers: "hide_tab_parties_suppliers",
  },
  "/factory/others": {
    comparison: "hide_tab_overview_comparison",
    "product-comparison": "hide_tab_overview_product_comparison",
  },
  "/factory/payroll-hub": {
    workers: "hide_tab_payrollhub_workers",
    employees: "hide_tab_payrollhub_employees",
    insurance: "hide_tab_payrollhub_insurance",
  },
};

export const FACTORY_WORKERS_HUB_TABS = {
  workers: "hide_tab_workers_workers",
  payroll: "hide_tab_workers_payroll",
  attendance: "hide_tab_workers_attendance",
  report: "hide_tab_workers_report",
  advances: "hide_tab_workers_advances",
  bonuses: "hide_tab_workers_bonuses",
} as const;

export const FACTORY_SALES_DISPATCH_ROUTES = {
  pos: "/factory/pos",
  wasteDispatch: "/factory/waste-dispatch",
} as const;

export const FACTORY_OTHERS_NAV_LINKS = [
  {
    title: "Comparison",
    url: "/factory/others?tab=comparison",
    accessKey: "factory/production-report",
    hideKey: "hide_tab_overview_comparison",
    iconKey: "comparison",
  },
  {
    title: "Product Comparison",
    url: "/factory/others?tab=product-comparison",
    accessKey: "factory/production-report",
    hideKey: "hide_tab_overview_product_comparison",
    iconKey: "productComparison",
  },
] as const;

/** This is a visibility filter, not an authorization decision. */
export function factoryHubTabHideKey(path: string, tabOrSection: string | null): string | undefined {
  return tabOrSection ? FACTORY_HUB_HIDDEN_TABS[path]?.[tabOrSection] : undefined;
}
