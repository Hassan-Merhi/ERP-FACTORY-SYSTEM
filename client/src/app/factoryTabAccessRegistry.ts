/**
 * Canonical Factory tab-access registry.
 *
 * Settings reads this catalog, while Factory surfaces consume the same stable
 * hidden keys. Route restrictions below close legacy/deep-link paths that would
 * otherwise bypass a hidden tab.
 */
export interface FactoryTabDefinition {
  key: string;
  label: string;
  group: string;
}

export const FACTORY_TAB_ACCESS_REGISTRY: readonly FactoryTabDefinition[] = [
  { key: "hide_tab_workers_workers", label: "Workers", group: "Workers Hub" },
  { key: "hide_tab_workers_payroll", label: "Payroll", group: "Workers Hub" },
  { key: "hide_tab_workers_attendance", label: "Attendance", group: "Workers Hub" },
  { key: "hide_tab_workers_report", label: "Report", group: "Workers Hub" },
  { key: "hide_tab_workers_advances", label: "Advances", group: "Workers Hub" },
  { key: "hide_tab_workers_bonuses", label: "Bonuses", group: "Workers Hub" },

  { key: "hide_tab_employees_employees", label: "Employees", group: "Employees Hub" },
  { key: "hide_tab_employees_payroll", label: "Payroll", group: "Employees Hub" },
  { key: "hide_tab_employees_attendance", label: "Attendance", group: "Employees Hub" },
  { key: "hide_tab_employees_advances", label: "Advances", group: "Employees Hub" },
  { key: "hide_tab_employees_bonuses", label: "Bonuses", group: "Employees Hub" },
  { key: "hide_tab_employees_withdrawals", label: "Withdrawals", group: "Employees Hub" },

  { key: "hide_tab_bales_history", label: "Bales History", group: "Bales Hub" },
  { key: "hide_tab_bales_barcode", label: "Barcode Lookup", group: "Bales Hub" },
  { key: "hide_tab_bales_products", label: "Bale Products", group: "Bales Hub" },
  { key: "hide_tab_bales_customer_loading", label: "Customer Loading", group: "Bales Hub" },

  { key: "hide_tab_stockentry_entry", label: "Stock Entry", group: "Stock Entry" },
  { key: "hide_tab_stockentry_history", label: "History", group: "Stock Entry" },
  { key: "hide_tab_stockentry_ground_scan", label: "Ground Scan", group: "Stock Entry" },
  { key: "hide_tab_stockentry_daily_scan", label: "Daily Scan", group: "Stock Entry" },
  { key: "hide_tab_stockentry_production_targets", label: "Production Targets", group: "Stock Entry" },

  { key: "hide_tab_parties_customers", label: "Customers", group: "Parties Hub" },
  { key: "hide_tab_parties_suppliers", label: "Suppliers", group: "Parties Hub" },

  { key: "hide_tab_payrollhub_workers", label: "Workers", group: "Payroll & Benefits" },
  { key: "hide_tab_payrollhub_employees", label: "Employees", group: "Payroll & Benefits" },
  { key: "hide_tab_payrollhub_insurance", label: "Insurance", group: "Payroll & Benefits" },

  { key: "hide_tab_supplier_intel_report", label: "Supplier Report", group: "Supplier Intel" },
  { key: "hide_tab_supplier_intel_statement", label: "Supplier Statement", group: "Supplier Intel" },
  { key: "hide_tab_supplier_intel_scores", label: "Supplier Scores", group: "Supplier Intel" },

  { key: "hide_tab_production_intel_summary", label: "Production Summary", group: "Production Intel" },
  { key: "hide_tab_production_intel_waste", label: "Waste Tracking", group: "Production Intel" },
  { key: "hide_tab_production_intel_mix", label: "Mix Optimizer", group: "Production Intel" },
  { key: "hide_tab_production_intel_container_tracking", label: "Container Tracking", group: "Production Intel" },

  { key: "hide_tab_overview_otw_tracking", label: "OTW Tracking", group: "Overview" },
  { key: "hide_tab_overview_production", label: "Production", group: "Overview" },
  { key: "hide_tab_overview_comparison", label: "Comparison", group: "Overview" },
  { key: "hide_tab_overview_product_comparison", label: "Product Comparison", group: "Overview" },
  { key: "hide_tab_overview_shipping", label: "Shipping", group: "Overview" },
  { key: "hide_tab_overview_sheets", label: "Sheets", group: "Overview" },

  { key: "hide_invoicing_proformas_tab", label: "Proformas", group: "Invoicing" },
  { key: "hide_invoicing_invoices_tab", label: "Invoices", group: "Invoicing" },
  { key: "hide_invoicing_loadings_tab", label: "Container Loadings", group: "Invoicing" },
  { key: "hide_tab_loadings_pending", label: "Pending Loadings", group: "Invoicing" },

  { key: "hide_tab_daybook_transactions", label: "Transactions", group: "Daybook" },
  { key: "hide_tab_daybook_activity", label: "Edits & Activity", group: "Daybook" },

  { key: "hide_tab_import_suppliers", label: "Supplier Balances", group: "Import" },
  { key: "hide_tab_import_raw_stock", label: "Raw Stock", group: "Import" },
  { key: "hide_tab_import_bales", label: "Bales Inventory", group: "Import" },
  { key: "hide_tab_import_opening_stock", label: "Opening Raw Stock", group: "Import" },
  { key: "hide_tab_import_ob_edit", label: "Edit Opening Balance", group: "Import" },

  { key: "hide_tab_customer_statement", label: "Statement", group: "Customer Profile" },
  { key: "hide_tab_customer_pricelist", label: "Price List", group: "Customer Profile" },

  { key: "hide_tab_dispatch_batches", label: "Batches", group: "Dispatch Batches" },
  { key: "hide_tab_dispatch_reports", label: "Reports", group: "Dispatch Batches" },

  { key: "hide_tab_sheets_stock", label: "Stock", group: "Sheets & Sacks" },
  { key: "hide_tab_sheets_movements", label: "Movements", group: "Sheets & Sacks" },

  { key: "hide_tab_relabeling_main", label: "Bale Relabeling", group: "Bale Relabeling" },
  { key: "hide_tab_relabeling_wipers", label: "Wipers Re-Entry by Date", group: "Bale Relabeling" },

  { key: "hide_tab_accounts_view", label: "View Accounts", group: "Accounts" },
  { key: "hide_tab_accounts_find_voucher", label: "Find Voucher", group: "Accounts" },

  { key: "hide_tab_vouchers_payment", label: "Payment", group: "Vouchers" },
  { key: "hide_tab_vouchers_receipt", label: "Receipt", group: "Vouchers" },
  { key: "hide_tab_vouchers_journal", label: "Journal", group: "Vouchers" },
  { key: "hide_tab_vouchers_transfer", label: "Stock Transfer", group: "Vouchers" },
  { key: "hide_tab_vouchers_transferorder", label: "Transfer Order", group: "Vouchers" },
  { key: "hide_tab_vouchers_adjustment", label: "Adjustment", group: "Vouchers" },
  { key: "hide_tab_vouchers_creditnote", label: "Credit Note", group: "Vouchers" },

  { key: "hide_tab_advances_advances", label: "Advances", group: "Advances" },
  { key: "hide_tab_advances_repayments", label: "Repayments", group: "Advances" },
  { key: "hide_tab_advances_deductions", label: "Deductions", group: "Advances" },

  { key: "hide_tab_kpis_daily", label: "Daily Production", group: "KPIs" },
  { key: "hide_tab_kpis_worker_performance", label: "Worker Performance", group: "KPIs" },
  { key: "hide_tab_kpis_mix_efficiency", label: "Mix Efficiency", group: "KPIs" },

  { key: "hide_tab_payroll_records", label: "Payroll Records", group: "Payroll" },
  { key: "hide_tab_payroll_worker_master", label: "Worker Master", group: "Payroll" },

  { key: "hide_tab_profitability_bales", label: "Bale Costs", group: "Profitability" },
  { key: "hide_tab_profitability_containers", label: "Container Profitability", group: "Profitability" },

  { key: "hide_tab_workers_list", label: "Workers", group: "Workers List" },
  { key: "hide_tab_workers_categories", label: "Categories", group: "Workers List" },

  { key: "hide_tab_workerdetail_profile", label: "Profile", group: "Worker Profile" },
  { key: "hide_tab_workerdetail_statement", label: "Statement", group: "Worker Profile" },
  { key: "hide_tab_workerdetail_advances", label: "Advances", group: "Worker Profile" },
  { key: "hide_tab_workerdetail_bales", label: "Bales", group: "Worker Profile" },
  { key: "hide_tab_workerdetail_documents", label: "Documents", group: "Worker Profile" },
] as const;

export const FACTORY_SETTINGS_TABS: FactoryTabDefinition[] = FACTORY_TAB_ACCESS_REGISTRY.map((tab) => ({ ...tab }));
export const FACTORY_TAB_GROUPS = Array.from(new Set(FACTORY_SETTINGS_TABS.map((tab) => tab.group)));

export interface FactoryTabRouteRestriction {
  prefix: string;
  hiddenKeys: readonly string[];
  fallback: string;
  includeRoot?: boolean;
}

/**
 * Legacy/detail routes that render tab-owned content outside the canonical hub.
 * If any required tab is hidden, the user is returned to the parent hub where
 * the first visible tab (or an explicit no-access state) is selected.
 */
export const FACTORY_TAB_ROUTE_RESTRICTIONS: readonly FactoryTabRouteRestriction[] = [
  { prefix: "/factory/bale-relabeling/wipers-re-entry", hiddenKeys: ["hide_tab_relabeling_wipers"], fallback: "/factory/bale-relabeling" },

  { prefix: "/factory/customers", hiddenKeys: ["hide_tab_parties_customers"], fallback: "/factory/parties" },
  { prefix: "/factory/suppliers", hiddenKeys: ["hide_tab_parties_suppliers"], fallback: "/factory/parties" },

  { prefix: "/factory/workers", hiddenKeys: ["hide_tab_payrollhub_workers", "hide_tab_workers_workers"], fallback: "/factory/payroll-hub" },
  { prefix: "/factory/worker-payroll", hiddenKeys: ["hide_tab_payrollhub_workers", "hide_tab_workers_payroll"], fallback: "/factory/payroll-hub" },
  { prefix: "/factory/payroll", hiddenKeys: ["hide_tab_payrollhub_workers", "hide_tab_workers_payroll"], fallback: "/factory/payroll-hub" },
  { prefix: "/factory/employees", hiddenKeys: ["hide_tab_payrollhub_employees", "hide_tab_employees_employees"], fallback: "/factory/payroll-hub" },
  { prefix: "/factory/insurance", hiddenKeys: ["hide_tab_payrollhub_insurance"], fallback: "/factory/payroll-hub" },

  { prefix: "/factory/bales-history", hiddenKeys: ["hide_tab_bales_history"], fallback: "/factory/bales-hub" },
  { prefix: "/factory/bale-product-history", hiddenKeys: ["hide_tab_bales_history"], fallback: "/factory/bales-hub" },
  { prefix: "/factory/barcode-lookup", hiddenKeys: ["hide_tab_bales_barcode"], fallback: "/factory/bales-hub" },
  { prefix: "/factory/bale-products", hiddenKeys: ["hide_tab_bales_products"], fallback: "/factory/bales-hub" },

  { prefix: "/factory/sales/proformas", hiddenKeys: ["hide_invoicing_proformas_tab"], fallback: "/factory/invoicing" },
  { prefix: "/factory/sales/new", hiddenKeys: ["hide_invoicing_invoices_tab"], fallback: "/factory/invoicing" },
  { prefix: "/factory/sales/invoices", hiddenKeys: ["hide_invoicing_invoices_tab"], fallback: "/factory/invoicing" },
  { prefix: "/factory/sales/pending-invoices", hiddenKeys: ["hide_invoicing_invoices_tab"], fallback: "/factory/invoicing" },
  { prefix: "/factory/invoices", hiddenKeys: ["hide_invoicing_invoices_tab"], fallback: "/factory/invoicing" },
  { prefix: "/factory/sales/loading/pending", hiddenKeys: ["hide_tab_loadings_pending"], fallback: "/factory/invoicing" },
  { prefix: "/factory/sales/loading/new", hiddenKeys: ["hide_invoicing_loadings_tab"], fallback: "/factory/invoicing" },
  { prefix: "/factory/sales/loadings", hiddenKeys: ["hide_invoicing_loadings_tab"], fallback: "/factory/invoicing" },

  { prefix: "/factory/dispatch-batches", hiddenKeys: ["hide_tab_dispatch_batches"], fallback: "/factory/dispatch-batches", includeRoot: false },

  { prefix: "/factory/ledger-monthly", hiddenKeys: ["hide_tab_accounts_view"], fallback: "/factory/accounts" },
  { prefix: "/factory/ledger-vouchers", hiddenKeys: ["hide_tab_accounts_view"], fallback: "/factory/accounts" },
  { prefix: "/factory/create", hiddenKeys: ["hide_tab_accounts_view"], fallback: "/factory/accounts" },
] as const;

function cleanFactoryPath(path: string): string {
  const withoutHash = path.split("#", 1)[0];
  const withoutQuery = withoutHash.split("?", 1)[0];
  const trimmed = withoutQuery.replace(/\/+$/, "");
  return trimmed || "/";
}

export function resolveFactoryTabRouteRestriction(path: string): FactoryTabRouteRestriction | null {
  const clean = cleanFactoryPath(path);
  return (
    FACTORY_TAB_ROUTE_RESTRICTIONS.find((rule) =>
      rule.includeRoot === false ? clean.startsWith(`${rule.prefix}/`) : clean === rule.prefix || clean.startsWith(`${rule.prefix}/`)
    ) ?? null
  );
}
