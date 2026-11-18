// ── Date formatting ──────────────────────────────────────────────────────────

import {
  BUSINESS_FIELD_LABELS,
  changeValue,
  fieldLabel,
  fmtDate,
  normalizeAuditChanges,
  securityActionSummary,
  securityParts,
} from "./normalizeAuditChanges";
export {
  BUSINESS_FIELD_LABELS,
  fieldLabel,
  fmtDate,
  normalizeAuditChanges,
  securityActionSummary,
} from "./normalizeAuditChanges";
export type { AuditChangePair } from "./normalizeAuditChanges";

function formatPlainNumber(value: unknown, maximumFractionDigits = 6): string | null {
  const n = typeof value === "number" ? value : Number(String(value));
  if (!Number.isFinite(n)) return null;
  return n.toLocaleString(undefined, { maximumFractionDigits });
}

export function fmtBusinessValue(field: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (field === "optional") return value ? "Optional" : "Active";
  if (typeof value === "boolean") return value ? "Yes" : "No";

  const lowerField = field.toLowerCase();

  if (field === "occurredAt" && (typeof value === "number" || /^\d{11,}$/.test(String(value)))) {
    return fmtDate(Number(value));
  }

  if (
    lowerField.includes("date") ||
    lowerField.endsWith("at") ||
    (typeof value === "string" && /^\d{4}-\d{2}-\d{2}(?:[T\s]|$)/.test(value))
  ) {
    const date = new Date(String(value));
    if (!Number.isNaN(date.getTime())) {
      return /[T\s]\d{2}:\d{2}/.test(String(value)) || lowerField.endsWith("at")
        ? fmtDate(date)
        : date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    }
  }

  if (/amount|balance|total|price|cost|debit|credit/.test(lowerField)) {
    const n = Number(String(value));
    if (Number.isFinite(n)) {
      return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
  }

  if (/rate|quantity|weight|count|rows|updated|skipped/.test(lowerField)) {
    const formatted = formatPlainNumber(value);
    if (formatted !== null) return formatted;
  }

  if (field === "action" && typeof value === "string") {
    return fieldLabel(value);
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return "None";
    if (value.every((item) => item === null || ["string", "number", "boolean"].includes(typeof item))) {
      return value.map((item) => String(item)).join(", ");
    }
    return `${value.length} item${value.length !== 1 ? "s" : ""}`;
  }

  if (typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) return "—";
    const preview = entries
      .slice(0, 4)
      .map(([key, nested]) => `${BUSINESS_FIELD_LABELS[key] || fieldLabel(key)}: ${fmtBusinessValue(key, nested)}`)
      .join("; ");
    return entries.length > 4 ? `${preview}; +${entries.length - 4} more` : preview;
  }

  return String(value);
}

// ── Module/table name mapping ────────────────────────────────────────────────

const MODULE_LABEL_MAP: Record<string, string> = {
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
  factory_post_offload_charges: "Post-Offload Charges",
  factory_container_commissions: "Container Commissions",
  factory_container_freight: "Container Freight",
  factory_container_extra_charges: "Container Extra Charges",
  factory_mix_batches: "Mix Batches",
  factory_mix_batch_sources: "Mix Batch Sources",
  production_raw_stock: "Raw Material Stock",
  factory_raw_stock: "Raw Material Stock",
  factory_repairs: "Factory Repairs",
  factory_fx_repairs: "FX Repairs",
  factory_landed_cost_repairs: "Landed Cost Repairs",
  bales: "Bales",
  factory_bales: "Bales",
  factory_customer_orders: "Factory Customer Orders",
  users: "Users",
  user_company_roles: "Roles & Permissions",
  exchange_rates: "Exchange Rates",
  company_settings: "Company Settings",
  reports: "Reports",
  security_events: "Security Events",
  remote_support_sessions: "Remote Support",
  payroll_workers: "Payroll Workers",
  payroll_salaries: "Payroll Salaries",
  rental_properties: "Rental Properties",
  rental_payments: "Rental Payments",
  pos_shifts: "POS Shifts",
  pos_sales: "POS Sales",
  pos_locations: "POS Locations",
};

/** Returns a human-readable title for a database table name. */
export function tableShortName(t: string): string {
  if (!t) return "Unknown";
  if (MODULE_LABEL_MAP[t]) return MODULE_LABEL_MAP[t];
  return t
    .replace(/^(factory_|payroll_|rental_|pos_)/, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── Action labels and badge variants ─────────────────────────────────────────

const ACTION_LABEL_MAP: Record<string, string> = {
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
  permission_change: "Permissions Changed",
  settings_change: "Settings Changed",
  remote_support_session_started: "Support Session Started",
  remote_support_session_stopped: "Support Session Stopped",
  remote_support_screen_watch_started: "Screen Watch Started",
  remote_support_screen_watch_ended: "Screen Watch Ended",
  remote_support_mouse_authorized: "Mouse Control Enabled",
  remote_support_mouse_revoked: "Mouse Control Disabled",
  remote_support_keyboard_authorized: "Keyboard Control Enabled",
  remote_support_keyboard_revoked: "Keyboard Control Disabled",
  remote_support_mouse_command: "Mouse Command Requested",
  remote_support_mouse_result: "Mouse Command Result",
  remote_support_keyboard_command: "Keyboard Command Requested",
  remote_support_keyboard_result: "Keyboard Command Result",
  remote_support_command_blocked: "Remote Command Blocked",
  remote_support_permission_denied: "Remote Support Permission Denied",
};

/** Returns a readable label for an audit action string. */
export function actionLabel(action: string): string {
  if (!action) return "—";
  const security = securityParts(action);
  if (security) {
    const outcome = security.outcome.toLowerCase();
    if (outcome.includes("allow")) return "Security Allowed";
    if (outcome.includes("deny") || outcome.includes("reject") || outcome.includes("block")) return "Security Denied";
    return "Security Event";
  }
  const key = action.toLowerCase();
  if (ACTION_LABEL_MAP[key]) return ACTION_LABEL_MAP[key];
  return fieldLabel(action);
}

type BadgeVariant = "default" | "secondary" | "destructive" | "outline";

/** Maps an audit action to a shadcn Badge variant for color-coding. */
export function actionBadgeVariant(action: string): BadgeVariant {
  const key = (action || "").toLowerCase();
  if (key.startsWith("security:")) {
    return key.includes(":denied") || key.includes(":rejected") || key.includes(":blocked")
      ? "destructive"
      : "secondary";
  }
  if (key === "delete" || key === "void" || key === "reverse" || key === "cancel") return "destructive";
  if (key === "create" || key === "approve" || key === "restore") return "default";
  return "secondary";
}

/** All action values accepted by the /api/audit-log endpoint. */
export const ALL_SUPPORTED_ACTIONS = [
  "create",
  "update",
  "delete",
  "restore",
  "reverse",
  "void",
  "return",
  "recalculate",
  "repair",
  "import",
  "export",
  "send_whatsapp",
  "send_email",
  "approve",
  "cancel",
  "offload",
  "transfer",
  "adjust",
  "login",
  "permission_change",
  "settings_change",
] as const;

// ── Record / diff helpers ────────────────────────────────────────────────────

export function isItemDiffKey(field: string): boolean {
  return /^item_(added|removed|changed)_/.test(field);
}

export function getRecordLabel(log: Record<string, unknown> | null | undefined): string {
  if (
    log?.tableName === "security_events" ||
    String(log?.action || "")
      .toUpperCase()
      .startsWith("SECURITY:")
  ) {
    const changes = normalizeAuditChanges(log);
    const targetType = changeValue(changes, "targetType");
    const targetId = changeValue(changes, "targetId");
    if (targetType) {
      return `${fieldLabel(String(targetType))}${targetId ? ` #${targetId}` : ""}`;
    }
    return securityActionSummary(log);
  }

  if (log?.recordIdentifier) {
    const id = String(log.recordIdentifier);
    if (id.length <= 60) return id;
    return id.slice(0, 58) + "…";
  }
  if (log?.recordId) return `${tableShortName(String(log.tableName ?? ""))} #${log.recordId}`;
  return tableShortName(String(log?.tableName ?? ""));
}

function fallbackDetails(action: string): string {
  const key = String(action || "").toLowerCase();
  const messages: Record<string, string> = {
    create: "Record created",
    update: "Record updated",
    delete: "Record deleted",
    restore: "Record restored",
    reverse: "Transaction reversed",
    void: "Transaction voided",
    return: "Sale returned",
    recalculate: "Values recalculated",
    repair: "Historical data repaired",
    import: "Data imported",
    export: "Data exported",
    send_whatsapp: "Sent to WhatsApp",
    send_email: "Sent by email",
    approve: "Record approved",
    cancel: "Record cancelled",
    offload: "Container offloaded",
    transfer: "Stock transferred",
    adjust: "Value adjusted",
    login: "User logged in",
    permission_change: "User permissions changed",
    settings_change: "Company settings changed",
  };
  return messages[key] || `${actionLabel(action)} activity recorded`;
}

export function getDetailsSentence(log: Record<string, unknown> | null | undefined): string {
  if (
    log?.tableName === "security_events" ||
    String(log?.action || "")
      .toUpperCase()
      .startsWith("SECURITY:")
  ) {
    const changes = normalizeAuditChanges(log);
    const reason = changeValue(changes, "reasonCode") ?? changeValue(changes, "reason");
    return reason
      ? `${securityActionSummary(log)} — ${fmtBusinessValue("reasonCode", reason)}`
      : securityActionSummary(log);
  }

  const changes = normalizeAuditChanges(log);
  const allKeys = Object.keys(changes);
  if (allKeys.length === 0) return fallbackDetails(String(log?.action ?? ""));

  const structuredItemKey = ["items", "lines", "lineItems", "affectedItems"].find((key) => changes[key]);
  const scalarKeys = allKeys.filter(
    (key) => key !== "entries" && !["items", "lines", "lineItems", "affectedItems"].includes(key) && !isItemDiffKey(key)
  );
  const itemKeys = allKeys.filter((key) => isItemDiffKey(key));
  const structuredItems = structuredItemKey ? changes[structuredItemKey] : undefined;
  const structuredItemCount = Array.isArray(structuredItems?.new)
    ? structuredItems.new.length
    : Array.isArray(structuredItems?.old)
      ? structuredItems.old.length
      : 0;
  const parts: string[] = [];

  if (scalarKeys.length > 0) {
    const changed = scalarKeys.slice(0, 3).map((key) => {
      const label = BUSINESS_FIELD_LABELS[key] || fieldLabel(key);
      const pair = changes[key] || {};
      const hasOld = pair.old !== undefined && pair.old !== null;
      const hasNew = pair.new !== undefined && pair.new !== null;
      if (hasOld && hasNew && JSON.stringify(pair.old) !== JSON.stringify(pair.new)) {
        return `${label}: ${fmtBusinessValue(key, pair.old)} → ${fmtBusinessValue(key, pair.new)}`;
      }
      return `${label}: ${fmtBusinessValue(key, hasNew ? pair.new : pair.old)}`;
    });
    parts.push(changed.join("; "));
    if (scalarKeys.length > 3) parts.push(`+${scalarKeys.length - 3} more`);
  }

  if (itemKeys.length > 0) {
    parts.push(`${itemKeys.length} item change${itemKeys.length !== 1 ? "s" : ""}`);
  }
  if (structuredItemCount > 0) {
    parts.push(`${structuredItemCount} item${structuredItemCount !== 1 ? "s" : ""}`);
  }

  const entries = changes.entries;
  const entryCount = Array.isArray(entries?.new)
    ? entries.new.length
    : Array.isArray(entries?.old)
      ? entries.old.length
      : 0;
  if (entryCount > 0) parts.push(`${entryCount} accounting entr${entryCount === 1 ? "y" : "ies"}`);

  return parts.length > 0 ? parts.join(" — ") : fallbackDetails(String(log?.action ?? ""));
}
