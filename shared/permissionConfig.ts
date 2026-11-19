/**
 * Central permission catalog for Advanced Restrictions.
 *
 * Key naming conventions:
 *   mod_*      → top-level module visibility
 *   page_*     → full page/route visibility
 *   tab_*      → tab or sub-section visibility
 *   act_*      → action buttons / write operations
 *   fld_*      → sensitive field visibility
 *   exp_*      → export / print capabilities
 *   pos_perm_* → POS-specific capability overrides
 *
 * Semantics (enforced by server/lib/permissionHelpers.ts):
 *   Developer / Admin          → always allowed (cannot be restricted via this system)
 *   Owner / Manager / POS      → ALLOWED by default; enabled=false in DB means RESTRICTED
 *   Normal User                → DENIED by default; enabled=true in DB means EXPLICITLY ALLOWED
 *
 * UI checkbox semantics:
 *   Owner/Manager/POS  → checked = restriction is active  (stored as enabled=false)
 *   Normal User        → checked = access is granted      (stored as enabled=true)
 */

import {
  MODULE_PERMISSIONS,
  ACTION_PERMISSIONS,
  type PermissionType,
  type PermissionEntry,
} from "./permissionConfigModel";
export type { PermissionType, PermissionEntry } from "./permissionConfigModel";

// ─── Module-level Access ───────────────────────────────────────────────────────

// ─── Pages & Routes ───────────────────────────────────────────────────────────

const PAGE_PERMISSIONS: PermissionEntry[] = [
  { key: "page_dashboard", label: "Dashboard / Tracking", group: "Overview", type: "page" },
  { key: "page_analytics", label: "Analytics", group: "Overview", type: "page" },
  { key: "page_pos", label: "Point of Sale", group: "Sales & POS", type: "page" },
  { key: "page_pos_daybook", label: "POS Daybook", group: "Sales & POS", type: "page" },
  { key: "page_sales_report", label: "Sales Report", group: "Sales & POS", type: "page" },
  { key: "page_stock_items", label: "Stock Items", group: "Inventory", type: "page" },
  { key: "page_location_inventory", label: "Location Inventory", group: "Inventory", type: "page" },
  { key: "page_containers", label: "Containers (OTW)", group: "Inventory", type: "page" },
  { key: "page_stock_otw", label: "Stock OTW", group: "Inventory", type: "page" },
  { key: "page_stock_query", label: "Stock Query", group: "Inventory", type: "page" },
  { key: "page_location_summary", label: "Location Summary", group: "Inventory", type: "page" },
  { key: "page_optional_vouchers", label: "Optional Vouchers", group: "Inventory", type: "page" },
  { key: "page_accounts", label: "Accounts", group: "Accounting", type: "page" },
  { key: "page_suppliers", label: "Suppliers", group: "Accounting", type: "page" },
  { key: "page_customers", label: "Customers", group: "Accounting", type: "page" },
  { key: "page_vouchers", label: "Vouchers List", group: "Accounting", type: "page" },
  { key: "page_create", label: "Create Voucher", group: "Accounting", type: "page" },
  { key: "page_daybook", label: "Daybook", group: "Accounting", type: "page" },
  { key: "page_payroll", label: "Payroll", group: "Accounting", type: "page" },
  { key: "page_factory_production", label: "Factory Production", group: "Factory", type: "page" },
  { key: "page_settings", label: "Settings", group: "System", type: "page" },
];

// ─── Tab Restrictions ─────────────────────────────────────────────────────────

const TAB_PERMISSIONS: PermissionEntry[] = [
  // Workers Hub
  { key: "tab_workers_payroll", label: "Payroll", group: "Workers Hub", type: "tab" },
  { key: "tab_workers_attendance", label: "Attendance", group: "Workers Hub", type: "tab" },
  { key: "tab_workers_report", label: "Report", group: "Workers Hub", type: "tab" },
  { key: "tab_workers_advances", label: "Advances", group: "Workers Hub", type: "tab" },
  { key: "tab_workers_bonuses", label: "Bonuses", group: "Workers Hub", type: "tab" },
  // Bales Hub
  { key: "tab_bales_barcode", label: "Barcode Lookup", group: "Bales Hub", type: "tab" },
  { key: "tab_bales_remove", label: "Remove from Stock", group: "Bales Hub", type: "tab" },
  // Loadings
  { key: "tab_loadings_pending", label: "Pending Loadings", group: "Loadings", type: "tab" },
  // Stock Entry
  { key: "tab_stockentry_entry", label: "Stock Entry", group: "Stock Entry", type: "tab" },
  { key: "tab_stockentry_history", label: "History", group: "Stock Entry", type: "tab" },
  // Advances
  { key: "tab_advances_repayments", label: "Repayments", group: "Advances", type: "tab" },
  // KPIs
  { key: "tab_kpis_worker_perf", label: "Worker Performance", group: "KPIs", type: "tab" },
  { key: "tab_kpis_mix_efficiency", label: "Mix Efficiency", group: "KPIs", type: "tab" },
  // Payroll
  { key: "tab_payroll_worker_master", label: "Worker Master", group: "Payroll Tab", type: "tab" },
  // Profitability
  { key: "tab_profitability_containers", label: "Container P&L", group: "Profitability", type: "tab" },
  // Workers List
  { key: "tab_workers_categories", label: "Categories", group: "Workers List", type: "tab" },
  // Worker Profile
  { key: "tab_workerdetail_statement", label: "Statement", group: "Worker Profile", type: "tab" },
  { key: "tab_workerdetail_advances", label: "Advances", group: "Worker Profile", type: "tab" },
  { key: "tab_workerdetail_bales", label: "Bales", group: "Worker Profile", type: "tab" },
  { key: "tab_workerdetail_documents", label: "Documents", group: "Worker Profile", type: "tab" },
  // Invoicing
  { key: "tab_invoicing_proformas", label: "Proformas Tab", group: "Invoicing", type: "tab" },
  { key: "tab_invoicing_proforma_col", label: "Proforma Column", group: "Invoicing", type: "tab" },
  { key: "tab_invoicing_totals_usd", label: "USD Totals", group: "Invoicing", type: "tab" },
  // Sidebar
  { key: "tab_sidebar_daybook", label: "Daybook", group: "Sidebar Tabs", type: "tab" },
  { key: "tab_sidebar_agents", label: "Agents", group: "Sidebar Tabs", type: "tab" },
];

// ─── Action Restrictions ──────────────────────────────────────────────────────

// ─── Sensitive Field Restrictions ─────────────────────────────────────────────

const SENSITIVE_PERMISSIONS: PermissionEntry[] = [
  {
    key: "fld_cost_price",
    label: "Cost Price / Avg Rate",
    group: "Financial Fields",
    type: "sensitive",
    description: "Purchase cost and average cost rate columns",
  },
  { key: "fld_total_value", label: "Total Inventory Value", group: "Financial Fields", type: "sensitive" },
  { key: "fld_profit_margin", label: "Profit / Margin", group: "Financial Fields", type: "sensitive" },
  { key: "fld_sell_price", label: "Sell Price Column", group: "Financial Fields", type: "sensitive" },
  { key: "fld_bank_balance", label: "Bank Account Balances", group: "Financial Fields", type: "sensitive" },
  { key: "fld_account_balances", label: "Ledger Account Balances", group: "Financial Fields", type: "sensitive" },
  { key: "fld_supplier_balance", label: "Supplier Balances", group: "Financial Fields", type: "sensitive" },
  { key: "fld_customer_balance", label: "Customer Balances", group: "Financial Fields", type: "sensitive" },
  { key: "fld_bale_cost_kg", label: "Bale Cost/KG", group: "Factory Fields", type: "sensitive" },
  { key: "fld_bale_total_cost", label: "Bale Total Cost", group: "Factory Fields", type: "sensitive" },
  { key: "fld_proforma_price", label: "Proforma Price/Bale", group: "Factory Fields", type: "sensitive" },
];

// ─── Export & Print Restrictions ──────────────────────────────────────────────

const EXPORT_PERMISSIONS: PermissionEntry[] = [
  { key: "exp_pdf", label: "Export / Download PDF", group: "Export & Print", type: "export" },
  { key: "exp_excel", label: "Export / Download Excel", group: "Export & Print", type: "export" },
  { key: "exp_customer_statement", label: "Customer Statement PDF", group: "Export & Print", type: "export" },
  { key: "exp_stock_report", label: "Stock Report Export", group: "Export & Print", type: "export" },
  { key: "exp_whatsapp_send", label: "Send via WhatsApp", group: "Export & Print", type: "export" },
  { key: "exp_print_invoice", label: "Print / Share Invoice", group: "Export & Print", type: "export" },
  { key: "exp_audit_log", label: "View Audit Log", group: "Export & Print", type: "export" },
  {
    key: "exp_backup_download",
    label: "Download Backup / Data Export",
    group: "Export & Print",
    type: "export",
    description: "Daily export center and bulk data downloads",
  },
];

// ─── POS-Specific Permissions ─────────────────────────────────────────────────

const POS_PERMISSIONS: PermissionEntry[] = [
  {
    key: "pos_perm_override_price",
    label: "Override Item Price",
    group: "POS Capabilities",
    type: "pos",
    description: "Allow changing the sale price of an item at checkout",
  },
  { key: "pos_perm_discount", label: "Apply Discount", group: "POS Capabilities", type: "pos" },
  { key: "pos_perm_credit_sale", label: "Create Credit Sales", group: "POS Capabilities", type: "pos" },
  { key: "pos_perm_refund", label: "Issue Refund / Void", group: "POS Capabilities", type: "pos" },
  { key: "pos_perm_open_shift", label: "Open / Close Shift", group: "POS Capabilities", type: "pos" },
  { key: "pos_perm_view_shift_summary", label: "View Shift Summary", group: "POS Capabilities", type: "pos" },
];

// Ticket module permissions - effective access must still be checked per company/ticket.
const TICKET_PERMISSIONS: PermissionEntry[] = [
  {
    key: "page_ticket_management",
    label: "Ticket Management",
    group: "Ticket Management",
    type: "page",
  },
  {
    key: "act_ticket_create",
    label: "Ticket create",
    group: "Ticket Management",
    type: "action",
  },
  {
    key: "act_ticket_comment",
    label: "Ticket comment",
    group: "Ticket Management",
    type: "action",
  },
  {
    key: "act_ticket_assign",
    label: "Ticket assign",
    group: "Ticket Management",
    type: "action",
  },
  {
    key: "act_ticket_finalize",
    label: "Ticket finalize",
    group: "Ticket Management",
    type: "action",
  },
  {
    key: "act_ticket_reopen",
    label: "Ticket reopen",
    group: "Ticket Management",
    type: "action",
  },
  {
    key: "act_ticket_manage_all",
    label: "Ticket manage all",
    group: "Ticket Management",
    type: "action",
  },
  {
    key: "exp_ticket_export",
    label: "Export Tickets",
    group: "Ticket Management",
    type: "export",
  },
];

// ─── Combined catalog ─────────────────────────────────────────────────────────

export const PERMISSION_CATALOG: PermissionEntry[] = [
  ...MODULE_PERMISSIONS,
  ...PAGE_PERMISSIONS,
  ...TAB_PERMISSIONS,
  ...ACTION_PERMISSIONS,
  ...SENSITIVE_PERMISSIONS,
  ...EXPORT_PERMISSIONS,
  ...POS_PERMISSIONS,
  ...TICKET_PERMISSIONS,
];

/** Convenience lookup by key */
export const PERMISSION_BY_KEY: Record<string, PermissionEntry> = Object.fromEntries(
  PERMISSION_CATALOG.map((e) => [e.key, e])
);

/** Human-readable section labels for each type */
export const PERMISSION_TYPE_LABELS: Record<PermissionType, string> = {
  module: "Module Access",
  page: "Pages & Routes",
  tab: "Tab Restrictions",
  action: "Action Restrictions",
  sensitive: "Sensitive Field Restrictions",
  export: "Export & Print",
  pos: "POS Settings",
};

/**
 * Auto-detected / Unconfigured placeholder structure.
 *
 * Add entries here for pages/routes/tabs that exist in the app but haven't
 * been formally catalogued yet. These are shown in a separate
 * "Auto-detected / Unconfigured" section in the Advanced Restrictions UI.
 *
 * To add a new entry:
 *   UNCONFIGURED_PERMISSIONS.push({
 *     key: "page_my_new_page",
 *     label: "My New Page",
 *     group: "Unconfigured",
 *     type: "page",
 *   });
 */
export const UNCONFIGURED_PERMISSIONS: PermissionEntry[] = [
  // Example: { key: "page_new_feature", label: "New Feature (unconfigured)", group: "Unconfigured", type: "page" },
];
