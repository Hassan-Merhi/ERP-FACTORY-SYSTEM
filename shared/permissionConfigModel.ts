// Extracted from ./permissionConfig.ts

export type PermissionType = "module" | "page" | "tab" | "action" | "sensitive" | "export" | "pos";

export interface PermissionEntry {
  key: string;
  label: string;
  group: string;
  type: PermissionType;
  description?: string;
}

export const MODULE_PERMISSIONS: PermissionEntry[] = [
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

export const ACTION_PERMISSIONS: PermissionEntry[] = [
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
