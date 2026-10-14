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

export type PermissionType = "module" | "page" | "tab" | "action" | "sensitive" | "export" | "pos";

export interface PermissionEntry {
  key: string;
  label: string;
  group: string;
  type: PermissionType;
  description?: string;
}

// ─── Module-level Access ───────────────────────────────────────────────────────

const MODULE_PERMISSIONS: PermissionEntry[] = [
  {
    key: "mod_erp",
    label: "ERP Module",
    group: "Core Modules",
    type: "module",
    description: "Access to the ERP system (accounting, vouchers, customers, suppliers)",
  },
  {
    key: "mod_factory",
    label: "Factory Module",
    group: "Core Modules",
    type: "module",
    description: "Access to factory production, bales, workers, and payroll",
  },
  {
    key: "mod_pos",
    label: "POS Module",
    group: "Core Modules",
    type: "module",
    description: "Access to Point of Sale operations",
  },
  {
    key: "mod_properties",
    label: "Properties / Rentals",
    group: "Core Modules",
    type: "module",
    description: "Access to property and rental management",
  },
  {
    key: "mod_inventory",
    label: "Inventory Module",
    group: "Core Modules",
    type: "module",
    description: "Access to stock items, location inventory, containers, OTW",
  },
  {
    key: "mod_accounting",
    label: "Accounting Module",
    group: "Core Modules",
    type: "module",
    description: "Access to accounts, vouchers, ledgers, daybook",
  },
  {
    key: "mod_analytics",
    label: "Analytics & Reports",
    group: "Core Modules",
    type: "module",
    description: "Access to analytics dashboards and report exports",
  },
  {
    key: "mod_settings",
    label: "Settings & Tools",
    group: "Core Modules",
    type: "module",
    description: "Access to system settings, user management, and data tools",
  },
];

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

const ACTION_PERMISSIONS: PermissionEntry[] = [
  {
    key: "act_create_voucher",
    label: "Create Vouchers",
    group: "Accounting Actions",
    type: "action",
    description: "Ability to create new journal/purchase/payment vouchers",
  },
  { key: "act_void_sale", label: "Void / Cancel Sales", group: "Accounting Actions", type: "action" },
  { key: "act_approve_voucher", label: "Approve / Finalize Vouchers", group: "Accounting Actions", type: "action" },
  { key: "act_adjust_stock", label: "Adjust Stock Manually", group: "Inventory Actions", type: "action" },
  { key: "act_transfer_stock", label: "Transfer Stock", group: "Inventory Actions", type: "action" },
  { key: "act_import_data", label: "Import Data (Excel/CSV)", group: "Data Actions", type: "action" },
  { key: "act_bulk_operations", label: "Bulk Operations", group: "Data Actions", type: "action" },
  {
    key: "act_manage_users",
    label: "Manage Users & Roles",
    group: "Admin Actions",
    type: "action",
    description: "Add, edit, or remove users and their role assignments",
  },
  { key: "act_manage_companies", label: "Manage Companies", group: "Admin Actions", type: "action" },
  {
    key: "remote_support_view",
    label: "View Remote Support Screens",
    group: "Remote Support",
    type: "action",
    description: "Open live screen viewing and create a bounded support session for users in the active company",
  },
  {
    key: "remote_support_mouse",
    label: "Use Remote Support Mouse",
    group: "Remote Support",
    type: "action",
    description: "Enable guarded pointer, safe click, and scrolling commands in the exact ERP browser tab",
  },
  {
    key: "remote_support_keyboard",
    label: "Use Remote Support Keyboard",
    group: "Remote Support",
    type: "action",
    description: "Enable guarded keyboard input only for safe or explicitly approved ERP fields",
  },
  {
    key: "remote_support_audit",
    label: "View Remote Support Audit",
    group: "Remote Support",
    type: "action",
    description: "View permanent company-scoped remote support session and command metadata",
  },
];

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

// ─── Combined catalog ─────────────────────────────────────────────────────────

export const PERMISSION_CATALOG: PermissionEntry[] = [
  ...MODULE_PERMISSIONS,
  ...PAGE_PERMISSIONS,
  ...TAB_PERMISSIONS,
  ...ACTION_PERMISSIONS,
  ...SENSITIVE_PERMISSIONS,
  ...EXPORT_PERMISSIONS,
  ...POS_PERMISSIONS,
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
