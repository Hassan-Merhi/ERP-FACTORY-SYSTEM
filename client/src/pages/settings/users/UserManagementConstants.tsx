import { FACTORY_SETTINGS_PAGES } from "@/app/factoryAccessRegistry";
import { FACTORY_TAB_REGISTRY } from "@shared/factoryPermissionCatalog";
import { FEATURE_KEYS, FEATURE_PAGE_INFO } from "@shared/schema";

export const ALL_FACTORY_PAGES = FACTORY_SETTINGS_PAGES;
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
  { key: "hide_invoicing_proforma_col", label: "Proforma Column (Invoices)" },
  { key: "hide_invoicing_totals_usd", label: "Total Amounts (USD)" },
];

export const FACTORY_TABS = FACTORY_TAB_REGISTRY;
export const FACTORY_TAB_GROUPS = Array.from(new Set(FACTORY_TABS.map((t) => t.group)));
