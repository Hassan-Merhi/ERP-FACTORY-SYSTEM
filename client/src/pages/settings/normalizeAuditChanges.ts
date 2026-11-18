// Extracted from ./AuditLogUtils.tsx to keep that module under the source-size cap.

export function fmtDate(d: string | number | Date) {
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return "—";
  return (
    dt.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) +
    " " +
    dt.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
  );
}

// ── Field label helpers ──────────────────────────────────────────────────────

export function fieldLabel(key: string) {
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/[._:-]+/g, " ")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\s+/g, " ")
    .trim();
}

export const BUSINESS_FIELD_LABELS: Record<string, string> = {
  voucherType: "Voucher Type",
  voucherNumber: "Voucher Number",
  date: "Date",
  chargeDate: "Charge Date",
  occurredAt: "Occurred At",
  amount: "Amount",
  totalAmount: "Total Amount",
  description: "Description",
  narration: "Narration",
  location: "Location",
  optional: "Status",
  ledgerAccount: "Ledger Account",
  debitAccount: "Debit Account",
  creditAccount: "Credit Account",
  cashAccount: "Cash / Bank Account",
  customer: "Customer",
  supplier: "Supplier",
  paymentMethod: "Payment Method",
  currency: "Currency",
  fxRate: "FX Rate",
  exchangeRate: "Exchange Rate",
  sourceLocation: "Source Location",
  destinationLocation: "Destination Location",
  company: "Company",
  companyId: "Company ID",
  reference: "Reference",
  referenceNumber: "Reference Number",
  newReferenceNumber: "New Reference Number",
  name: "Name",
  status: "Status",
  type: "Type",
  saleType: "Sale Type",
  balance: "Balance",
  phone: "Phone",
  email: "Email",
  address: "Address",
  contactPerson: "Contact Person",
  notes: "Notes",
  paymentTerms: "Payment Terms",
  taxNumber: "Tax Number",
  code: "Code",
  unit: "Unit",
  category: "Category",
  quantity: "Quantity",
  weight: "Weight",
  unitPrice: "Unit Price",
  total: "Total",
  itemCount: "Number of Items",
  changedItemCount: "Items Changed",
  appliedRevisionCount: "Revisions Applied",
  revisionNumber: "Revision Number",
  route: "Route",
  note: "Note",
  items: "Items",
  lines: "Items",
  lineItems: "Items",
  affectedItems: "Affected Items",
  stockItemId: "Item ID",
  stockItemName: "Item",
  sourceLocationId: "Source Location ID",
  sourceLocationName: "Source Location",
  originalQuantity: "Before Qty",
  newQuantity: "After Qty",
  delta: "Change",
  rate: "Rate",
  compatibilityMode: "Compatibility Mode",
  affectedRows: "Records Affected",
  updated: "Records Updated",
  skipped: "Records Skipped",
  scope: "Scope",
  mode: "Mode",
  operation: "Operation",
  delivery: "Delivery Method",
  reason: "Reason",
  reasonCode: "Reason Code",
  kind: "Security Area",
  action: "Security Check",
  outcome: "Result",
  eventKey: "Technical Reference",
  severity: "Severity",
  ipAddress: "IP Address",
  userAgent: "Browser / Device",
  targetType: "Affected Record Type",
  targetId: "Affected Record ID",
  actorUserId: "User ID",
  metadata: "Additional Details",
};

export type AuditChangePair = { old?: unknown; new?: unknown };

/**
 * Audit rows come from two historical formats:
 *  1. business mutations: { field: { old, new } }
 *  2. security events:     { field: value }
 * Normalize both so every screen can render actual values instead of blank rows.
 */
export function normalizeAuditChanges(source: unknown): Record<string, AuditChangePair> {
  const sourceRecord = (source && typeof source === "object" ? source : {}) as Record<string, unknown>;
  const raw = sourceRecord.changes ?? sourceRecord.diff ?? source;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};

  const normalized: Record<string, AuditChangePair> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (Object.prototype.hasOwnProperty.call(value, "old") || Object.prototype.hasOwnProperty.call(value, "new"))
    ) {
      normalized[key] = value as AuditChangePair;
    } else {
      normalized[key] = { new: value };
    }
  }
  return normalized;
}

export function changeValue(changes: Record<string, AuditChangePair>, key: string) {
  const pair = changes[key];
  if (!pair) return undefined;
  return pair.new !== undefined ? pair.new : pair.old;
}

export function securityParts(logOrAction: unknown): {
  category: string;
  check: string;
  outcome: string;
  changes: Record<string, AuditChangePair>;
} | null {
  const action =
    typeof logOrAction === "string"
      ? logOrAction
      : String(((logOrAction ?? {}) as Record<string, unknown>).action || "");
  if (!action.toUpperCase().startsWith("SECURITY:")) return null;

  const changes = normalizeAuditChanges(typeof logOrAction === "string" ? {} : logOrAction);
  const pieces = action.split(":");
  return {
    category: String(changeValue(changes, "kind") ?? pieces[1] ?? "Security"),
    check: String(changeValue(changes, "action") ?? pieces.slice(2, -1).join(":") ?? "Check"),
    outcome: String(changeValue(changes, "outcome") ?? pieces[pieces.length - 1] ?? "Recorded"),
    changes,
  };
}

export function securityActionSummary(logOrAction: unknown): string {
  const parsed = securityParts(logOrAction);
  if (!parsed) return "Security event recorded";

  const combined = `${parsed.category} ${parsed.check}`.toLowerCase();
  const outcome = parsed.outcome.toLowerCase();
  const outcomeWord = outcome.includes("allow")
    ? "allowed"
    : outcome.includes("deny") || outcome.includes("reject") || outcome.includes("block")
      ? "denied"
      : fieldLabel(parsed.outcome).toLowerCase();

  let subject = fieldLabel(parsed.check);
  if (combined.includes("company") && combined.includes("context")) subject = "Company access";
  else if (combined.includes("privileged")) subject = "Privileged action";
  else if (combined.includes("sensitive") && combined.includes("input")) subject = "Sensitive input";
  else if (combined.includes("protected") && (combined.includes("file") || combined.includes("asset")))
    subject = "File access";
  else if (combined.includes("permission")) subject = "Permission check";
  else if (combined.includes("session")) subject = "Session check";

  return `${subject} ${outcomeWord}`;
}
