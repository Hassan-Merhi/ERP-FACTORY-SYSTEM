import { db, type DatabaseOrTransaction } from "../../db";
import { logger } from "../../lib/logger";
import {
  auditLog,
  ledgerAccounts,
  bankAccounts,
  suppliers,
  employees,
  customers,
  factorySuppliers,
} from "@shared/schema";
import { inArray } from "drizzle-orm";

// ─── Audit log ────────────────────────────────────────────────────────────────
export type AuditAction =
  | "create"
  | "update"
  | "delete"
  | "restore"
  | "reverse"
  | "void"
  | "return"
  | "recalculate"
  | "repair"
  | "import"
  | "export"
  | "send_whatsapp"
  | "send_email"
  | "approve"
  | "cancel"
  | "offload"
  | "transfer"
  | "adjust"
  | "login"
  | "permission_change"
  | "settings_change";

function normalizeAuditAction(params: {
  action: AuditAction;
  tableName: string;
  changes?: Record<string, { old?: AuditChangeValue; new?: AuditChangeValue }> | null;
}): AuditAction {
  if (params.action !== "update" || params.tableName !== "factory_customer_orders") {
    return params.action;
  }

  const statusChange = params.changes?.status;
  const oldStatus = String(statusChange?.old ?? "").toUpperCase();
  const newStatus = String(statusChange?.new ?? "").toUpperCase();

  if (newStatus === "CANCELLED") return "cancel";
  if (oldStatus === "CANCELLED" && newStatus === "LOADING") return "restore";

  return params.action;
}

export async function logAudit(
  params: {
    userId: string;
    username: string;
    companyId?: number | null;
    action: AuditAction;
    tableName: string;
    recordId?: number | null;
    recordIdentifier?: string | null;
    changes?: Record<string, { old?: AuditChangeValue; new?: AuditChangeValue }> | null;
  },
  // Optional transaction/connection handle. Pass the same `tx` used for the
  // financial write so the audit INSERT is atomic with it — if the audit
  // insert fails, the whole transaction (including the financial write)
  // rolls back instead of silently losing the audit trail. Defaults to the
  // pool-level `db` for existing non-transactional callers.
  dbConn: { insert: typeof db.insert } = db
) {
  try {
    await dbConn.insert(auditLog).values({
      userId: params.userId,
      username: params.username,
      companyId: params.companyId,
      action: normalizeAuditAction(params),
      tableName: params.tableName,
      recordId: params.recordId,
      recordIdentifier: params.recordIdentifier,
      changes: params.changes,
    });
  } catch (error) {
    logger.error("Error logging audit:", { error: error });
    throw error;
  }
}

// ─── Voucher audit helpers ─────────────────────────────────────────────────────

type EntrySnap = { account: string; debit: string; credit: string; narration?: string };
/**
 * A recorded before/after value. Audit entries carry whatever the changed
 * column held, so the value is only ever serialised, never inspected.
 */
type AuditChangeValue = unknown;
/**
 * Entries as recorded on an audit row: either the resolved snapshot or the raw
 * voucher-entry rows a caller already has. Both are only compared and stored.
 */
type RecordedEntries = readonly (EntrySnap | Record<string, unknown>)[];
type VoucherSnap = {
  voucherType?: string | null;
  voucherDate?: string | null;
  totalAmount?: string | null;
  description?: string | null;
  locationName?: string | null;
  locationId?: number | null;
  optional?: boolean | null;
};

export async function snapshotVoucherEntries(
  entries: Array<{
    ledgerAccountId?: number | null;
    bankAccountId?: number | null;
    supplierId?: number | null;
    employeeId?: number | null;
    customerId?: number | null;
    factorySupplierId?: number | null;
    debitAmount?: string | null;
    creditAmount?: string | null;
    narration?: string | null;
  }>,
  // Wave 12: an audit written in a transaction resolves names on that transaction.
  reader: DatabaseOrTransaction = db
): Promise<EntrySnap[]> {
  // Resolve ledger account names
  const ledgerIds = [...new Set(entries.map((e) => e.ledgerAccountId).filter((id): id is number => id != null))];
  const ledgerNames: Record<number, string> = {};
  if (ledgerIds.length > 0) {
    const accts = await reader
      .select({ id: ledgerAccounts.id, name: ledgerAccounts.name })
      .from(ledgerAccounts)
      .where(inArray(ledgerAccounts.id, ledgerIds));
    accts.forEach((a) => {
      ledgerNames[a.id] = a.name;
    });
  }

  // Resolve bank account names
  const bankIds = [...new Set(entries.map((e) => e.bankAccountId).filter((id): id is number => id != null))];
  const bankNames: Record<number, string> = {};
  if (bankIds.length > 0) {
    const bnks = await reader
      .select({ id: bankAccounts.id, name: bankAccounts.name })
      .from(bankAccounts)
      .where(inArray(bankAccounts.id, bankIds));
    bnks.forEach((b) => {
      bankNames[b.id] = b.name;
    });
  }

  // Resolve supplier names
  const supplierIds = [...new Set(entries.map((e) => e.supplierId).filter((id): id is number => id != null))];
  const supplierNames: Record<number, string> = {};
  if (supplierIds.length > 0) {
    const supps = await reader
      .select({ id: suppliers.id, name: suppliers.legalName })
      .from(suppliers)
      .where(inArray(suppliers.id, supplierIds));
    supps.forEach((s) => {
      supplierNames[s.id] = s.name;
    });
  }

  // Resolve employee names (firstName + lastName)
  const employeeIds = [...new Set(entries.map((e) => e.employeeId).filter((id): id is number => id != null))];
  const employeeNames: Record<number, string> = {};
  if (employeeIds.length > 0) {
    const emps = await reader
      .select({ id: employees.id, firstName: employees.firstName, lastName: employees.lastName })
      .from(employees)
      .where(inArray(employees.id, employeeIds));
    emps.forEach((emp) => {
      employeeNames[emp.id] = `${emp.firstName} ${emp.lastName}`.trim();
    });
  }

  // Resolve customer names
  const customerIds = [...new Set(entries.map((e) => e.customerId).filter((id): id is number => id != null))];
  const customerNames: Record<number, string> = {};
  if (customerIds.length > 0) {
    const custs = await reader
      .select({ id: customers.id, name: customers.legalName })
      .from(customers)
      .where(inArray(customers.id, customerIds));
    custs.forEach((c) => {
      customerNames[c.id] = c.name;
    });
  }

  // Resolve factory supplier names
  const factorySupplierIds = [
    ...new Set(entries.map((e) => e.factorySupplierId).filter((id): id is number => id != null)),
  ];
  const factorySupplierNames: Record<number, string> = {};
  if (factorySupplierIds.length > 0) {
    const fsupps = await reader
      .select({ id: factorySuppliers.id, name: factorySuppliers.name })
      .from(factorySuppliers)
      .where(inArray(factorySuppliers.id, factorySupplierIds));
    fsupps.forEach((s) => {
      factorySupplierNames[s.id] = s.name;
    });
  }

  return entries.map((e) => {
    const account = e.ledgerAccountId
      ? (ledgerNames[e.ledgerAccountId] ?? `Account #${e.ledgerAccountId}`)
      : e.bankAccountId
        ? (bankNames[e.bankAccountId] ?? `Bank #${e.bankAccountId}`)
        : e.supplierId
          ? (supplierNames[e.supplierId] ?? `Supplier #${e.supplierId}`)
          : e.employeeId
            ? (employeeNames[e.employeeId] ?? `Employee #${e.employeeId}`)
            : e.customerId
              ? (customerNames[e.customerId] ?? `Customer #${e.customerId}`)
              : e.factorySupplierId
                ? (factorySupplierNames[e.factorySupplierId] ?? `Supplier #${e.factorySupplierId}`)
                : "—";
    const snap: EntrySnap = { account, debit: e.debitAmount || "0", credit: e.creditAmount || "0" };
    if (e.narration) snap.narration = e.narration;
    return snap;
  });
}

export function buildVoucherChangesForCreate(
  v: VoucherSnap,
  entries: RecordedEntries
): Record<string, { new: AuditChangeValue }> {
  const c: Record<string, { new: AuditChangeValue }> = {};
  if (v.voucherType) c.voucherType = { new: v.voucherType };
  if (v.voucherDate) c.date = { new: v.voucherDate };
  if (v.totalAmount) c.amount = { new: v.totalAmount };
  if (v.description) c.description = { new: v.description };
  if (v.locationName || v.locationId) c.location = { new: v.locationName ?? `Location #${v.locationId}` };
  if (entries.length > 0) c.entries = { new: entries };
  return c;
}

export function buildVoucherChangesForDelete(
  v: VoucherSnap,
  entries: RecordedEntries
): Record<string, { old: AuditChangeValue }> {
  const c: Record<string, { old: AuditChangeValue }> = {};
  if (v.voucherType) c.voucherType = { old: v.voucherType };
  if (v.voucherDate) c.date = { old: v.voucherDate };
  if (v.totalAmount) c.amount = { old: v.totalAmount };
  if (v.description) c.description = { old: v.description };
  if (v.locationName || v.locationId) c.location = { old: v.locationName ?? `Location #${v.locationId}` };
  if (entries.length > 0) c.entries = { old: entries };
  return c;
}

export function buildVoucherChangesForUpdate(
  oldV: VoucherSnap,
  newV: VoucherSnap,
  oldEntries: RecordedEntries,
  newEntries: RecordedEntries
): Record<string, { old?: AuditChangeValue; new?: AuditChangeValue }> {
  const c: Record<string, { old?: AuditChangeValue; new?: AuditChangeValue }> = {};
  if (oldV.voucherType !== newV.voucherType) c.voucherType = { old: oldV.voucherType, new: newV.voucherType };
  if (oldV.voucherDate !== newV.voucherDate) c.date = { old: oldV.voucherDate, new: newV.voucherDate };
  if (parseFloat(oldV.totalAmount || "0") !== parseFloat(newV.totalAmount || "0"))
    c.amount = { old: oldV.totalAmount, new: newV.totalAmount };
  if ((oldV.description ?? "") !== (newV.description ?? ""))
    c.description = { old: oldV.description ?? "", new: newV.description ?? "" };
  if (oldV.locationId !== newV.locationId)
    c.location = {
      old: oldV.locationName ?? (oldV.locationId ? `Location #${oldV.locationId}` : null),
      new: newV.locationName ?? (newV.locationId ? `Location #${newV.locationId}` : null),
    };
  if (oldV.optional !== newV.optional) c.optional = { old: oldV.optional, new: newV.optional };
  if (JSON.stringify(oldEntries) !== JSON.stringify(newEntries)) c.entries = { old: oldEntries, new: newEntries };
  return c;
}

// ─── Item-level diff builder ───────────────────────────────────────────────────
export async function buildItemLevelChanges(
  oldItems: Array<{
    stockItemId?: number | null;
    itemName?: string | null;
    quantity?: string | number | null;
    rate?: string | number | null;
    totalAmount?: string | number | null;
    lineTotal?: string | number | null;
    totalValue?: string | number | null;
  }>,
  newItems: Array<{
    stockItemId?: number | null;
    itemName?: string | null;
    quantity?: string | number | null;
    rate?: string | number | null;
    totalAmount?: string | number | null;
    lineTotal?: string | number | null;
    totalValue?: string | number | null;
  }>,
  resolveNameFn?: (id: number) => Promise<string>
): Promise<Record<string, { old?: string; new?: string }>> {
  const nameCache = new Map<number, string>();
  async function getName(id: number | null | undefined, hint?: string | null): Promise<string> {
    if (hint) return hint;
    if (!id) return "Unknown Item";
    if (nameCache.has(id)) return nameCache.get(id)!;
    const name = resolveNameFn ? await resolveNameFn(id) : `Item #${id}`;
    nameCache.set(id, name);
    return name;
  }

  const oldMap = new Map<number, (typeof oldItems)[0]>();
  for (const item of oldItems) {
    if (item.stockItemId != null) oldMap.set(item.stockItemId, item);
  }
  const newMap = new Map<number, (typeof newItems)[0]>();
  for (const item of newItems) {
    if (item.stockItemId != null) newMap.set(item.stockItemId, item);
  }

  const changes: Record<string, { old?: string; new?: string }> = {};
  let idx = 0;

  for (const [id, item] of newMap) {
    if (!oldMap.has(id)) {
      const name = await getName(id, item.itemName);
      const qty = String(item.quantity ?? "");
      const rate = String(item.rate ?? "");
      const total = String(item.totalAmount ?? item.lineTotal ?? item.totalValue ?? "");
      changes[`item_added_${++idx}`] = {
        new: `Added ${name}, quantity ${qty}, unit price ${rate}, total ${total}`,
      };
    }
  }

  for (const [id, item] of oldMap) {
    if (!newMap.has(id)) {
      const name = await getName(id, item.itemName);
      const qty = String(item.quantity ?? "");
      const rate = String(item.rate ?? "");
      const total = String(item.totalAmount ?? item.lineTotal ?? item.totalValue ?? "");
      changes[`item_removed_${++idx}`] = {
        old: `Removed ${name}, quantity ${qty}, rate ${rate}, total ${total}`,
      };
    }
  }

  for (const [id, newItem] of newMap) {
    const oldItem = oldMap.get(id);
    if (!oldItem) continue;
    const name = await getName(id, newItem.itemName ?? oldItem.itemName);
    const fieldChanges: string[] = [];
    const qn = parseFloat(String(newItem.quantity ?? 0));
    const qo = parseFloat(String(oldItem.quantity ?? 0));
    if (!isNaN(qn) && !isNaN(qo) && Math.abs(qn - qo) > 0.0001) {
      fieldChanges.push(`quantity from ${qo} to ${qn}`);
    }
    const rn = parseFloat(String(newItem.rate ?? 0));
    const ro = parseFloat(String(oldItem.rate ?? 0));
    if (!isNaN(rn) && !isNaN(ro) && Math.abs(rn - ro) > 0.0001) {
      fieldChanges.push(`unit price from ${ro} to ${rn}`);
    }
    if (fieldChanges.length) {
      changes[`item_changed_${++idx}`] = {
        new: `${name}: ${fieldChanges.join("; ")}`,
      };
    }
  }

  return changes;
}
