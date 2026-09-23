import { FACTORY_NAV_PAGES } from "@/components/FactorySidebar";
import { FEATURE_KEYS, FEATURE_PAGE_INFO } from "@shared/schema";

export const ALL_FACTORY_PAGES = FACTORY_NAV_PAGES;
export const FACTORY_PAGE_GROUPS = Array.from(new Set(ALL_FACTORY_PAGES.map((p) => p.group)));
export const ALL_ERP_PAGES: { key: string; label: string; group: string }[] = FEATURE_KEYS.map((key) => ({
  key,
  label: FEATURE_PAGE_INFO[key].label,
  group: FEATURE_PAGE_INFO[key].group,
}));
export const ERP_PAGE_GROUPS = Array.from(new Set(ALL_ERP_PAGES.map((p) => p.group)));
export const ERP_COST_FIELDS = [
  { key: "sales_profit_cost", label: "Sales Cost/Profit Columns" },
  { key: "hide_export_selling_price", label: "Hide Selling Prices in Exports/Prints" },
  { key: "hide_export_cost_price", label: "Hide Cost / Production Prices in Exports/Prints" },
];

export const FACTORY_COST_FIELDS = [
  { key: "inventory_avg_rate", label: "Avg Rate Column" },
  { key: "inventory_total_value", label: "Total Value Column" },
  { key: "inventory_sell_price", label: "Sell Price Column" },
  { key: "inventory_sell_value", label: "Sell Value Column" },
  { key: "bale_history_cost_per_kg", label: "Cost/KG Column" },
  { key: "bale_history_total_cost", label: "Total Cost Column" },
  { key: "bales_list_cost_per_kg", label: "Cost/kg Column" },
  { key: "hide_proforma_price", label: "Price/Bale Column (Proformas)" },
];

export const FACTORY_TABS: { key: string; label: string; group: string }[] = [
  { key: "hide_tab_workers_payroll", label: "Payroll", group: "Workers Hub" },
  { key: "hide_tab_workers_attendance", label: "Attendance", group: "Workers Hub" },
  { key: "hide_tab_workers_report", label: "Report", group: "Workers Hub" },
  { key: "hide_tab_workers_advances", label: "Advances", group: "Workers Hub" },
  { key: "hide_tab_workers_bonuses", label: "Bonuses", group: "Workers Hub" },
  { key: "hide_tab_bales_barcode", label: "Barcode Lookup", group: "Bales Hub" },
  { key: "hide_tab_bales_remove", label: "Remove from Stock", group: "Bales Hub" },
  { key: "hide_tab_loadings_pending", label: "Pending Loadings", group: "Loadings Hub" },
  { key: "hide_tab_stockentry_entry", label: "Stock Entry", group: "Stock Entry" },
  { key: "hide_tab_stockentry_history", label: "History", group: "Stock Entry" },
  { key: "hide_tab_stockentry_ground_scan", label: "Ground Scan", group: "Stock Entry" },
  { key: "hide_tab_stockentry_daily_scan", label: "Daily Scan", group: "Stock Entry" },
  { key: "hide_tab_stockentry_production_targets", label: "Production Targets", group: "Stock Entry" },
  { key: "hide_tab_advances_repayments", label: "Repayments", group: "Advances" },
  { key: "hide_tab_kpis_worker_performance", label: "Worker Performance", group: "KPIs" },
  { key: "hide_tab_kpis_mix_efficiency", label: "Mix Efficiency", group: "KPIs" },
  { key: "hide_tab_payroll_worker_master", label: "Worker Master", group: "Payroll" },
  { key: "hide_tab_profitability_containers", label: "Container Profitability", group: "Profitability" },
  { key: "hide_tab_workers_categories", label: "Categories", group: "Workers List" },
  { key: "hide_tab_workerdetail_statement", label: "Statement", group: "Worker Profile" },
  { key: "hide_tab_workerdetail_advances", label: "Advances", group: "Worker Profile" },
  { key: "hide_tab_workerdetail_bales", label: "Bales", group: "Worker Profile" },
  { key: "hide_tab_workerdetail_documents", label: "Documents", group: "Worker Profile" },
  { key: "hide_tab_production_analytics", label: "Overview", group: "Sidebar Pages" },
  { key: "hide_tab_daybook", label: "Daybook", group: "Sidebar Pages" },
  { key: "hide_tab_agents", label: "Agent Ledger", group: "Sidebar Pages" },
  { key: "hide_invoicing_proformas_tab", label: "Proformas Tab", group: "Invoicing" },
  { key: "hide_invoicing_proforma_col", label: "Proforma Column", group: "Invoicing" },
  { key: "hide_invoicing_totals_usd", label: "Total Amounts (USD)", group: "Invoicing" },
];
export const FACTORY_TAB_GROUPS = Array.from(new Set(FACTORY_TABS.map((t) => t.group)));
