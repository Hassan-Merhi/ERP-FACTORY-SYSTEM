// Extracted from ./permanent-delete.ts: shared helpers.
import { db, type DbTransaction } from "../../../db";
import {
  factoryCategories,
  factoryBaleProducts,
  factoryContainers,
  factoryRawStock,
  factoryRawMaterialAdjustments,
  factoryMixBatches,
  factoryBales,
  customerProformas,
  customerOrders,
  stockItems,
  stockGroups,
  bankAccounts,
  vouchers,
  customers,
  locations,
  employees,
  ledgerAccounts,
} from "@shared/schema";
import { companyScopedSuppliers } from "@shared/schema/supplierCompanyScope";
import { sql, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import type { DeletedItemRow } from "./permanent-delete";
import { toMoney } from "../../../lib/money";

// The soft-deleted rows each type lists in Deleted Items (see ./list.ts).
// Wave 18 (B): suppliers are company-owned (suppliers.company_id), so they
// are scoped like every other type.
export const DELETED_ITEM_ROWS: Record<string, DeletedItemRow> = {
  location: { id: locations.id, companyId: locations.companyId, deletedAt: locations.deletedAt },
  stockItem: { id: stockItems.id, companyId: stockItems.companyId, deletedAt: stockItems.deletedAt },
  stockGroup: { id: stockGroups.id, companyId: stockGroups.companyId, deletedAt: stockGroups.deletedAt },
  ledgerAccount: { id: ledgerAccounts.id, companyId: ledgerAccounts.companyId, deletedAt: ledgerAccounts.deletedAt },
  employee: { id: employees.id, companyId: employees.companyId, deletedAt: employees.deletedAt },
  customer: { id: customers.id, companyId: customers.companyId, deletedAt: customers.deletedAt },
  supplier: {
    id: companyScopedSuppliers.id,
    companyId: companyScopedSuppliers.companyId,
    deletedAt: companyScopedSuppliers.deletedAt,
  },
  bankAccount: { id: bankAccounts.id, companyId: bankAccounts.companyId, deletedAt: bankAccounts.deletedAt },
  voucher: { id: vouchers.id, companyId: vouchers.companyId, deletedAt: vouchers.deletedAt },
  factoryCategory: {
    id: factoryCategories.id,
    companyId: factoryCategories.companyId,
    deletedAt: factoryCategories.deletedAt,
  },
  factoryBaleProduct: {
    id: factoryBaleProducts.id,
    companyId: factoryBaleProducts.companyId,
    deletedAt: factoryBaleProducts.deletedAt,
  },
  factoryContainer: {
    id: factoryContainers.id,
    companyId: factoryContainers.companyId,
    deletedAt: factoryContainers.deletedAt,
  },
  factoryRawStock: {
    id: factoryRawStock.id,
    companyId: factoryRawStock.companyId,
    deletedAt: factoryRawStock.deletedAt,
  },
  factoryRawMaterialAdjustment: {
    id: factoryRawMaterialAdjustments.id,
    companyId: factoryRawMaterialAdjustments.companyId,
    deletedAt: factoryRawMaterialAdjustments.deletedAt,
  },
  factoryMixBatch: {
    id: factoryMixBatches.id,
    companyId: factoryMixBatches.companyId,
    deletedAt: factoryMixBatches.deletedAt,
  },
  factoryBale: { id: factoryBales.id, companyId: factoryBales.companyId, deletedAt: factoryBales.deletedAt },
  customerProforma: {
    id: customerProformas.id,
    companyId: customerProformas.companyId,
    deletedAt: customerProformas.deletedAt,
  },
  customerOrder: { id: customerOrders.id, companyId: customerOrders.companyId, deletedAt: customerOrders.deletedAt },
};

/**
 * Whether the item is in this company's Deleted Items list. Permanent delete
 * removes dependent rows by id before the company-scoped delete of the item
 * itself, so it must only run for an item the user already moved to the bin:
 * never a live record, and never another company's. Returns null for an
 * unknown type.
 */
export async function isInDeletedItems(type: string, itemId: number, companyId: number): Promise<boolean | null> {
  let condition: SQL;
  if (type === "orphanedPosSale") {
    // A live voucher whose location no longer exists or was soft-deleted.
    condition = sql`EXISTS (
      SELECT 1 FROM ${vouchers} LEFT JOIN ${locations} ON ${locations.id} = ${vouchers.locationId}
      WHERE ${vouchers.id} = ${itemId} AND ${vouchers.companyId} = ${companyId}
        AND ${vouchers.deletedAt} IS NULL AND ${vouchers.locationId} IS NOT NULL
        AND (${locations.id} IS NULL OR ${locations.deletedAt} IS NOT NULL))`;
  } else {
    const row = DELETED_ITEM_ROWS[type];
    if (!row) return null;
    const scope = row.companyId ? sql` AND ${row.companyId} = ${companyId}` : sql``;
    condition = sql`EXISTS (
      SELECT 1 FROM ${row.id.table} WHERE ${row.id} = ${itemId} AND ${row.deletedAt} IS NOT NULL${scope})`;
  }
  const result = await db.execute(sql`SELECT ${condition} AS found`);
  const rows = Array.isArray(result) ? result : (result as { rows?: unknown[] }).rows;
  return (rows?.[0] as { found?: boolean } | undefined)?.found === true;
}

/**
 * Wave 9 (ledger safety): permanently deleting a voucher erases accounting
 * history, so it is an Admin/Owner action (Developer passes, as with
 * requireRole). Wave 18 (B): every item type is (a permanent delete cannot be
 * undone), each one runs in one transaction with its audit row (the row as it
 * was and the dependent rows removed with it), scoped to the active company.
 */
export const PERMANENT_DELETE_ROLES = new Set(["Admin", "Owner", "Developer"]);

/** The row as it is, for the audit (null when it is gone). */
export async function snapshotRow(
  executor: DbTransaction,
  table: PgTable,
  id: number
): Promise<Record<string, unknown> | null> {
  const result = await executor.execute(sql`SELECT to_jsonb(t) AS row FROM ${table} t WHERE t.id = ${id}`);
  const rows = Array.isArray(result) ? result : (result as { rows?: unknown[] }).rows;
  return ((rows?.[0] as { row?: Record<string, unknown> } | undefined)?.row ?? null) as Record<string, unknown> | null;
}

export function rowIdentifier(row: Record<string, unknown> | null): string | null {
  if (!row) return null;
  for (const key of ["code", "voucher_number", "batch_code", "legal_name", "name", "container_number"]) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

export const CLOSING_VOUCHER_MESSAGE = "A fiscal-period closing voucher cannot be deleted";

/**
 * Wave 12 (audit trail). An orphaned POS sale is a live voucher whose location
 * is gone. One with ledger lines or sold-item (stock) lines is posted, and
 * erasing it would change the books and the stock with no reversal, so it is
 * refused (delete it as a voucher instead: that soft-deletes it and reverses
 * its stock). An empty one is removed, Admin/Owner only, in one transaction,
 * audited with the header it held.
 */
export const ORPHANED_POS_POSTED_MESSAGE =
  "This orphaned POS sale has ledger or stock lines, so it is posted and cannot be permanently deleted. Delete it as a voucher instead, which keeps its history.";

/**
 * Wave 12: a party named on any voucher line (live or deleted voucher) keeps
 * its record, so the line still says who it was posted to; it used to be
 * cleared from the posted lines.
 */
export const EMPLOYEE_HAS_HISTORY_MESSAGE =
  "This employee is named on voucher lines, salary advances or payroll, so it cannot be permanently deleted. Keep it in Deleted Items.";

/** Wave 16 (A): a location whose inventory rows hold a quantity or a value keeps its record. */
export const LOCATION_HAS_STOCK_MESSAGE =
  "This location still holds stock (a quantity or a value), so it cannot be permanently deleted. Move or write off the stock first, or keep it in Deleted Items.";

export const CUSTOMER_HAS_HISTORY_MESSAGE =
  "This customer is named on voucher lines or sales, so it cannot be permanently deleted. Keep it in Deleted Items.";

/** Wave 18 (B): accounts and parties with lines or a non-zero opening keep their record. */
export const ACCOUNT_HAS_HISTORY_MESSAGE =
  "This account is named on voucher lines or has an opening balance, so it cannot be permanently deleted. Keep it in Deleted Items.";

export const CUSTOMER_HAS_OPENING_MESSAGE =
  "This customer has an opening balance, so it cannot be permanently deleted. Keep it in Deleted Items.";

/** Wave 18 (B): a voucher retired by the system (renamed ~DEL) is history of the posting that replaced it. */
export const RETIRED_VOUCHER_NOT_DELETABLE_MESSAGE =
  "This voucher was retired by the system when its posting was replaced, so it is kept as history and cannot be permanently deleted.";

/** Non-zero opening (exact decimal). */
export function hasOpening(row: Record<string, unknown> | null): boolean {
  const value = row?.opening_balance;
  if (value == null) return false;
  return !toMoney(String(value)).isZero();
}

export async function firstFound(executor: DbTransaction, checks: SQL[]): Promise<boolean> {
  for (const check of checks) {
    const result = await executor.execute(sql`SELECT EXISTS (${check}) AS found`);
    const rows = Array.isArray(result) ? result : (result as { rows?: unknown[] }).rows;
    if ((rows?.[0] as { found?: boolean } | undefined)?.found === true) return true;
  }
  return false;
}

export class PermanentDeleteRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentDeleteRefused";
  }
}
