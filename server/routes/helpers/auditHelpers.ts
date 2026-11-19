import { db, type DatabaseOrTransaction } from "../../db";
import { ledgerAccounts, bankAccounts, suppliers, employees, customers, factorySuppliers } from "@shared/schema";
import { inArray } from "drizzle-orm";
import { parseMoneyInput, toMoney } from "../../lib/money";
import type { EntrySnap, AuditChangeValue, RecordedEntries, VoucherSnap } from "./auditHelpersHelpers";
export { logAudit, type AuditAction } from "./auditHelpersHelpers";

// ─── Voucher audit helpers ─────────────────────────────────────────────────────

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
  if (toMoney(oldV.totalAmount).toNumber() !== toMoney(newV.totalAmount).toNumber())
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
    const qn = parseMoneyInput(String(newItem.quantity ?? 0))?.toNumber() ?? NaN;
    const qo = parseMoneyInput(String(oldItem.quantity ?? 0))?.toNumber() ?? NaN;
    if (!isNaN(qn) && !isNaN(qo) && Math.abs(qn - qo) > 0.0001) {
      fieldChanges.push(`quantity from ${qo} to ${qn}`);
    }
    const rn = parseMoneyInput(String(newItem.rate ?? 0))?.toNumber() ?? NaN;
    const ro = parseMoneyInput(String(oldItem.rate ?? 0))?.toNumber() ?? NaN;
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
