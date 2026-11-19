// Extracted from ./auditLogRoutes.ts

const moduleLabels: Record<string, string> = {
  vouchers: "Vouchers",
  voucher_entries: "Journal Entries",
  ledger_accounts: "Accounts",
  customers: "Customers",
  suppliers: "Suppliers",
  stock_items: "Stock Items",
  inventory: "Inventory",
  stock_transfers: "Stock Transfers",
  stock_transfer_revisions: "Stock Transfer Revisions",
  containers: "Containers",
  factory_containers: "Factory Containers",
  factory_offload_charges: "Post-Offload Charges",
  factory_mix_batches: "Mix Batches",
  factory_mix_batch_sources: "Mix Batch Sources",
  production_raw_stock: "Raw Material Stock",
  bales: "Bales",
  factory_customer_orders: "Factory Customer Orders",
  users: "Users",
  user_company_roles: "Roles & Permissions",
  exchange_rates: "Exchange Rates",
  company_settings: "Company Settings",
  reports: "Reports",
};

const actionLabels: Record<string, string> = {
  create: "Created",
  update: "Updated",
  delete: "Deleted",
  restore: "Restored",
  reverse: "Reversed",
  void: "Voided",
  return: "Returned",
  recalculate: "Recalculated",
  repair: "Repaired",
  import: "Imported",
  export: "Exported",
  send_whatsapp: "Sent to WhatsApp",
  send_email: "Sent by Email",
  approve: "Approved",
  cancel: "Cancelled",
  offload: "Offloaded",
  transfer: "Transferred",
  adjust: "Adjusted",
  login: "Login",
  permission_change: "Permission Changed",
  settings_change: "Settings Changed",
};

function deriveModuleLabel(name: string): string {
  return (
    moduleLabels[name] ||
    name
      .replace(/^(factory_|payroll_|rental_|pos_)/, "")
      .replace(/_/g, " ")
      .replace(/\b\w/g, (character) => character.toUpperCase()) ||
    "Unknown"
  );
}

export function formatAuditRow(row: {
  id: number;
  userId: string;
  storedUsername: string;
  companyId: number | null;
  action: string;
  tableName: string;
  recordId: number | null;
  recordIdentifier: string | null;
  changes: unknown;
  createdAt: Date;
  resolvedUsername: string | null;
  displayName: string | null;
  companyName: string | null;
  companyCode: string | null;
}) {
  const { storedUsername, resolvedUsername, displayName, companyName, companyCode, ...rest } = row;
  const actionLower = String(rest.action || "").toLowerCase();
  return {
    ...rest,
    username: resolvedUsername || displayName || storedUsername || "Unknown",
    companyName: companyName || null,
    companyCode: companyCode || null,
    moduleLabel: deriveModuleLabel(rest.tableName),
    actionLabel:
      actionLabels[actionLower] ||
      (rest.action
        ? String(rest.action)
            .replace(/_/g, " ")
            .replace(/\b\w/g, (character) => character.toUpperCase())
        : "Unknown"),
    targetUrl: null as string | null,
  };
}

export type FormattedAuditRow = ReturnType<typeof formatAuditRow>;
