/**
 * deletedItemsRoutes: DeletedItemsPermanentDelete endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage, errorStatus } from "../../../lib/httpHandlers";
import { db, type DbTransaction } from "../../../db";
import { writeAuditEvent } from "../../../services/audit";
import { requireAuth, requireNonPOS } from "../../../auth";
import {
  factoryCategories,
  factoryBaleProducts,
  factoryContainers,
  factoryRawStock,
  factoryRawMaterialAdjustments,
  factoryMixBatches,
  factoryMixBatchSources,
  factoryBales,
  factoryContainerCommissions,
  factoryDutyAuditLog,
  factoryFxAllocations,
  factoryWasteEntries,
  customerProformas,
  customerProformaLines,
  customerOrders,
  customerOrderLines,
  customerOrderBales,
  customerOrderCharges,
  proformaStockReservations,
  inventory,
  stockItems,
  stockGroups,
  stockItemCodeAliases,
  stockItemLocationPrices,
  stockTransferVouchers,
  stockTransferItems,
  containerSales,
  bankAccounts,
  purchaseOrders,
  vouchers,
  voucherEntries,
  salesItems,
  suppliers,
  customers,
  locations,
  employees,
  interCompanyTransfers,
  ledgerAccounts,
  fiscalPeriodClosures,
  wasteDispatches,
  salaryAdvances,
  employeeGroupMembers,
  employeeBaleRates,
  employeeBalePctRates,
  erpWorkerDocs,
  erpPayrollRunItems,
  propertyPayments,
  factoryTransporterTransactions,
} from "@shared/schema";
import { eq, and, inArray, ne, or, sql, type SQL } from "drizzle-orm";
import { STOCK_ITEM_HAS_HISTORY_MESSAGE, stockItemHasHistory } from "../../../services/inventory/stockItemHistory";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

type DeletedItemRow = { id: AnyPgColumn; companyId: AnyPgColumn | null; deletedAt: AnyPgColumn };

// The soft-deleted rows each type lists in Deleted Items (see ./list.ts).
// Suppliers are global, so they have no company column to scope by.
const DELETED_ITEM_ROWS: Record<string, DeletedItemRow> = {
  location: { id: locations.id, companyId: locations.companyId, deletedAt: locations.deletedAt },
  stockItem: { id: stockItems.id, companyId: stockItems.companyId, deletedAt: stockItems.deletedAt },
  stockGroup: { id: stockGroups.id, companyId: stockGroups.companyId, deletedAt: stockGroups.deletedAt },
  ledgerAccount: { id: ledgerAccounts.id, companyId: ledgerAccounts.companyId, deletedAt: ledgerAccounts.deletedAt },
  employee: { id: employees.id, companyId: employees.companyId, deletedAt: employees.deletedAt },
  customer: { id: customers.id, companyId: customers.companyId, deletedAt: customers.deletedAt },
  supplier: { id: suppliers.id, companyId: null, deletedAt: suppliers.deletedAt },
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
async function isInDeletedItems(type: string, itemId: number, companyId: number): Promise<boolean | null> {
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
 * requireRole). The other item types keep the route-level non-POS rule.
 */
const VOUCHER_PERMANENT_DELETE_ROLES = new Set(["Admin", "Owner", "Developer"]);
const CLOSING_VOUCHER_MESSAGE = "A fiscal-period closing voucher cannot be deleted";

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

async function firstFound(executor: DbTransaction, checks: SQL[]): Promise<boolean> {
  for (const check of checks) {
    const result = await executor.execute(sql`SELECT EXISTS (${check}) AS found`);
    const rows = Array.isArray(result) ? result : (result as { rows?: unknown[] }).rows;
    if ((rows?.[0] as { found?: boolean } | undefined)?.found === true) return true;
  }
  return false;
}

class PermanentDeleteRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentDeleteRefused";
  }
}

export function registerDeletedItemsPermanentDeleteRoutes(app: Express) {
  // Permanently delete an item
  app.delete("/api/deleted-items/:type/:id/permanent", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const { type, id } = req.params;
      const itemId = parseInt(id);
      if (isNaN(itemId)) {
        return res.status(400).json({ message: "Invalid item ID" });
      }

      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const inDeletedItems = await isInDeletedItems(type, itemId, companyId);
      if (inDeletedItems === null) {
        return res.status(400).json({ message: "Invalid item type" });
      }
      if (!inDeletedItems) {
        return res.status(404).json({ message: `${type} not found in Deleted Items` });
      }

      switch (type) {
        case "location":
          // Wave 16 (A): refused while any inventory row of the location holds
          // a quantity or a value; the stock (and the ledger's inventory)
          // would lose its location. One transaction, audited.
          await db.transaction(async (tx) => {
            const [location] = await tx
              .select()
              .from(locations)
              .where(and(eq(locations.id, itemId), eq(locations.companyId, companyId)))
              .for("update");
            const held = await tx
              .select({ id: inventory.id })
              .from(inventory)
              .where(
                and(eq(inventory.locationId, itemId), or(ne(inventory.quantity, "0"), ne(inventory.totalValue, "0")))
              )
              .limit(1);
            if (held.length > 0) throw new PermanentDeleteRefused(LOCATION_HAS_STOCK_MESSAGE);
            await tx.delete(locations).where(and(eq(locations.id, itemId), eq(locations.companyId, companyId)));
            await writeAuditEvent(
              {
                userId: req.session.userId ?? "unknown",
                username: req.session.username || "unknown",
                companyId,
                action: "delete",
                tableName: "locations",
                recordId: itemId,
                recordIdentifier: location?.code ?? null,
                changes: { permanentDelete: { new: true }, location: { old: location ?? null } },
              },
              tx
            );
          });
          break;
        case "stockItem":
          // Wave 15 (M9): an item with stock history (document lines, stock
          // movements, shortage layers, valuation records, stock on hand) is
          // refused; its lines used to be deleted with it, so the documents
          // that moved it could no longer be reversed exactly. An item with
          // no history is removed in one transaction, audited.
          await db.transaction(async (tx) => {
            if (await stockItemHasHistory(tx, companyId, itemId))
              throw new PermanentDeleteRefused(STOCK_ITEM_HAS_HISTORY_MESSAGE);
            const [item] = await tx
              .select()
              .from(stockItems)
              .where(and(eq(stockItems.id, itemId), eq(stockItems.companyId, companyId)));
            await tx.delete(inventory).where(eq(inventory.stockItemId, itemId));
            await tx.delete(stockItemCodeAliases).where(eq(stockItemCodeAliases.stockItemId, itemId));
            await tx.delete(stockItemLocationPrices).where(eq(stockItemLocationPrices.stockItemId, itemId));
            await tx.delete(stockItems).where(and(eq(stockItems.id, itemId), eq(stockItems.companyId, companyId)));
            await writeAuditEvent(
              {
                userId: req.session.userId ?? "unknown",
                username: req.session.username || "unknown",
                companyId,
                action: "delete",
                tableName: "stock_items",
                recordId: itemId,
                recordIdentifier: item?.code ?? null,
                changes: { permanentDelete: { new: true }, stockItem: { old: item ?? null } },
              },
              tx
            );
          });
          break;
        case "stockGroup":
          await db.delete(stockGroups).where(and(eq(stockGroups.id, itemId), eq(stockGroups.companyId, companyId)));
          break;
        case "ledgerAccount":
          await db
            .delete(ledgerAccounts)
            .where(and(eq(ledgerAccounts.id, itemId), eq(ledgerAccounts.companyId, companyId)));
          break;
        case "employee":
          // Wave 12: refused while any voucher line, advance or payroll item names
          // the employee; otherwise one transaction, audited.
          await db.transaction(async (tx) => {
            if (
              await firstFound(tx, [
                sql`SELECT 1 FROM ${voucherEntries} WHERE ${voucherEntries.employeeId} = ${itemId}`,
                sql`SELECT 1 FROM ${salaryAdvances} WHERE ${salaryAdvances.employeeId} = ${itemId}`,
                sql`SELECT 1 FROM ${erpPayrollRunItems} WHERE ${erpPayrollRunItems.employeeId} = ${itemId}`,
              ])
            ) {
              throw new PermanentDeleteRefused(EMPLOYEE_HAS_HISTORY_MESSAGE);
            }
            const [employee] = await tx
              .select()
              .from(employees)
              .where(and(eq(employees.id, itemId), eq(employees.companyId, companyId)));
            await tx.delete(employeeGroupMembers).where(eq(employeeGroupMembers.employeeId, itemId));
            await tx.delete(employeeBaleRates).where(eq(employeeBaleRates.employeeId, itemId));
            await tx.delete(employeeBalePctRates).where(eq(employeeBalePctRates.employeeId, itemId));
            await tx.delete(erpWorkerDocs).where(eq(erpWorkerDocs.employeeId, itemId));
            await tx.delete(employees).where(and(eq(employees.id, itemId), eq(employees.companyId, companyId)));
            await writeAuditEvent(
              {
                userId: req.session.userId ?? "unknown",
                username: req.session.username || "unknown",
                companyId,
                action: "delete",
                tableName: "employees",
                recordId: itemId,
                recordIdentifier: employee?.code ?? null,
                changes: { permanentDelete: { new: true }, employee: { old: employee ?? null } },
              },
              tx
            );
          });
          break;
        case "customer": {
          // Permanent customer delete — must clear all FK references first.
          // Use db.transaction() + tx.execute(sql`...`) matching the established
          // pattern in this file (pool.connect parameterized queries fail here).
          await db.transaction(async (tx) => {
            // Wave 12: refused while a voucher line or a sale names the customer
            // (posted lines used to have the customer cleared).
            if (
              await firstFound(tx, [
                sql`SELECT 1 FROM voucher_entries WHERE customer_id = ${itemId}`,
                sql`SELECT 1 FROM container_sales WHERE customer_id = ${itemId}`,
                sql`SELECT 1 FROM factory_pos_sales WHERE customer_id = ${itemId}`,
              ])
            ) {
              throw new PermanentDeleteRefused(CUSTOMER_HAS_HISTORY_MESSAGE);
            }
            const [customer] = await tx
              .select()
              .from(customers)
              .where(and(eq(customers.id, itemId), eq(customers.companyId, companyId)));

            // 1. Null out nullable FKs (keep bales intact)
            await tx.execute(sql`UPDATE bales SET customer_id = NULL WHERE customer_id = ${itemId}`);

            // 2. Delete dispatch sub-rows (deepest first)
            await tx.execute(sql`
              DELETE FROM customer_dispatch_bale_scans
              WHERE batch_id IN (SELECT id FROM customer_dispatch_batches WHERE customer_id = ${itemId})`);
            await tx.execute(sql`
              DELETE FROM customer_dispatch_truck_rides
              WHERE batch_id IN (SELECT id FROM customer_dispatch_batches WHERE customer_id = ${itemId})`);
            await tx.execute(sql`DELETE FROM customer_dispatch_batches WHERE customer_id = ${itemId}`);

            // 3. Delete invoice loading sessions
            await tx.execute(sql`DELETE FROM factory_invoice_loading_sessions WHERE customer_id = ${itemId}`);

            // 5. Delete customer order children then orders
            await tx.execute(sql`
              DELETE FROM customer_order_bales_history
              WHERE order_id IN (SELECT id FROM customer_orders WHERE customer_id = ${itemId})`);
            await tx.execute(sql`
              DELETE FROM customer_order_bales
              WHERE order_id IN (SELECT id FROM customer_orders WHERE customer_id = ${itemId})`);
            await tx.execute(sql`
              DELETE FROM customer_order_lines
              WHERE order_id IN (SELECT id FROM customer_orders WHERE customer_id = ${itemId})`);
            await tx.execute(sql`
              DELETE FROM customer_order_charges
              WHERE order_id IN (SELECT id FROM customer_orders WHERE customer_id = ${itemId})`);
            await tx.execute(sql`DELETE FROM customer_orders WHERE customer_id = ${itemId}`);

            // 6. Delete customer proforma children then proformas
            await tx.execute(sql`
              DELETE FROM proforma_stock_reservations
              WHERE proforma_id IN (SELECT id FROM customer_proformas WHERE customer_id = ${itemId})`);
            await tx.execute(sql`
              DELETE FROM customer_proforma_lines
              WHERE proforma_id IN (SELECT id FROM customer_proformas WHERE customer_id = ${itemId})`);
            await tx.execute(sql`DELETE FROM customer_proformas WHERE customer_id = ${itemId}`);

            // 7. Delete the customer (customerBalances + customerLogos cascade automatically)
            await tx.execute(sql`DELETE FROM customers WHERE id = ${itemId} AND company_id = ${companyId}`);

            await writeAuditEvent(
              {
                userId: req.session.userId ?? "unknown",
                username: req.session.username || "unknown",
                companyId,
                action: "delete",
                tableName: "customers",
                recordId: itemId,
                recordIdentifier: customer?.legalName ?? null,
                changes: { permanentDelete: { new: true }, customer: { old: customer ?? null } },
              },
              tx
            );
          });
          break;
        }
        case "supplier":
          await db.delete(suppliers).where(eq(suppliers.id, itemId));
          break;
        case "bankAccount":
          await db.delete(bankAccounts).where(and(eq(bankAccounts.id, itemId), eq(bankAccounts.companyId, companyId)));
          break;
        case "voucher": {
          if (!VOUCHER_PERMANENT_DELETE_ROLES.has(req.user?.role ?? "")) {
            return res.status(403).json({ message: "Forbidden" });
          }
          // A fiscal close's journal is referenced by its closure row. Deleting
          // that row would silently reopen the period, so refuse instead.
          const [closure] = await db
            .select({ id: fiscalPeriodClosures.id })
            .from(fiscalPeriodClosures)
            .where(eq(fiscalPeriodClosures.closingVoucherId, itemId))
            .limit(1);
          if (closure) {
            return res.status(409).json({ message: CLOSING_VOUCHER_MESSAGE });
          }

          // One transaction: the voucher, its lines and every unlinked
          // reference go together, or nothing changes.
          await db.transaction(async (tx) => {
            const [voucher] = await tx
              .select()
              .from(vouchers)
              .where(and(eq(vouchers.id, itemId), eq(vouchers.companyId, companyId)));
            const entries = await tx.select().from(voucherEntries).where(eq(voucherEntries.voucherId, itemId));

            // ── Step 1: Null out nullable FKs in tables with onDelete: "restrict" ──
            await tx.update(purchaseOrders).set({ voucherId: null }).where(eq(purchaseOrders.voucherId, itemId));
            await tx.update(containerSales).set({ voucherId: null }).where(eq(containerSales.voucherId, itemId));
            await tx
              .update(interCompanyTransfers)
              .set({ fromVoucherId: null })
              .where(eq(interCompanyTransfers.fromVoucherId, itemId));
            await tx
              .update(interCompanyTransfers)
              .set({ toVoucherId: null })
              .where(eq(interCompanyTransfers.toVoucherId, itemId));
            await tx.update(salaryAdvances).set({ voucherId: null }).where(eq(salaryAdvances.voucherId, itemId));
            await tx
              .update(customerOrderCharges)
              .set({ voucherId: null })
              .where(eq(customerOrderCharges.voucherId, itemId));
            await tx.update(wasteDispatches).set({ voucherId: null }).where(eq(wasteDispatches.voucherId, itemId));
            await tx.update(propertyPayments).set({ voucherId: null }).where(eq(propertyPayments.voucherId, itemId));
            await tx
              .update(factoryTransporterTransactions)
              .set({ voucherId: null })
              .where(eq(factoryTransporterTransactions.voucherId, itemId));

            // ── Step 2: Delete rows with notNull FKs ──────────────────────────
            // stock_transfer_vouchers.voucherId is notNull — delete its items first
            const stvRows = await tx
              .select({ id: stockTransferVouchers.id })
              .from(stockTransferVouchers)
              .where(eq(stockTransferVouchers.voucherId, itemId));
            if (stvRows.length > 0) {
              const stvIds = stvRows.map((r) => r.id);
              // transferId is the correct FK column on stock_transfer_items
              await tx.delete(stockTransferItems).where(inArray(stockTransferItems.transferId, stvIds));
              await tx.delete(stockTransferVouchers).where(inArray(stockTransferVouchers.id, stvIds));
            }

            // ── Step 3: Delete voucher entries (also cascade, but be explicit) ─
            await tx.delete(voucherEntries).where(eq(voucherEntries.voucherId, itemId));

            // ── Step 4: Delete the voucher itself ────────────────────────────
            await tx.delete(vouchers).where(and(eq(vouchers.id, itemId), eq(vouchers.companyId, companyId)));

            // ── Step 5: Audit, with the header and lines as they were ────────
            await writeAuditEvent(
              {
                userId: req.session.userId ?? "unknown",
                username: req.session.username || "unknown",
                companyId,
                action: "delete",
                tableName: "vouchers",
                recordId: itemId,
                recordIdentifier: voucher?.voucherNumber ?? null,
                changes: {
                  permanentDelete: { new: true },
                  voucher: { old: voucher ?? null },
                  entries: { old: entries },
                  unlinkedStockTransferVoucherIds: { old: stvRows.map((r) => r.id) },
                },
              },
              tx
            );
          });
          break;
        }
        case "orphanedPosSale": {
          if (!VOUCHER_PERMANENT_DELETE_ROLES.has(req.user?.role ?? "")) {
            return res.status(403).json({ message: "Forbidden" });
          }
          // Wave 12: refused when posted (ledger or stock lines); otherwise the
          // empty voucher goes in one transaction, audited.
          await db.transaction(async (tx) => {
            const [voucher] = await tx
              .select()
              .from(vouchers)
              .where(and(eq(vouchers.id, itemId), eq(vouchers.companyId, companyId)))
              .for("update");
            const entries = await tx.select().from(voucherEntries).where(eq(voucherEntries.voucherId, itemId));
            const items = await tx.select().from(salesItems).where(eq(salesItems.voucherId, itemId));
            if (entries.length > 0 || items.length > 0) throw new PermanentDeleteRefused(ORPHANED_POS_POSTED_MESSAGE);
            await tx.delete(vouchers).where(and(eq(vouchers.id, itemId), eq(vouchers.companyId, companyId)));
            await writeAuditEvent(
              {
                userId: req.session.userId ?? "unknown",
                username: req.session.username || "unknown",
                companyId,
                action: "delete",
                tableName: "vouchers",
                recordId: itemId,
                recordIdentifier: voucher?.voucherNumber ?? null,
                changes: {
                  permanentDelete: { new: true },
                  orphanedPosSale: { new: true },
                  voucher: { old: voucher ?? null },
                },
              },
              tx
            );
          });
          break;
        }
        // === Wave 1 permanent deletes ===
        // Note: these only remove the row + immediate dependent rows. They do NOT
        // attempt to reverse historical financial vouchers/daybook entries — that
        // would require running the original cascade logic and is left for a future
        // wave. For full financial unwind, perform a manual reversal voucher.
        case "factoryCategory":
          await db
            .delete(factoryCategories)
            .where(and(eq(factoryCategories.id, itemId), eq(factoryCategories.companyId, companyId)));
          break;
        case "factoryBaleProduct":
          await db
            .delete(factoryBaleProducts)
            .where(and(eq(factoryBaleProducts.id, itemId), eq(factoryBaleProducts.companyId, companyId)));
          break;
        case "factoryContainer": {
          // Delete child rows in FK dependency order before the parent.
          // RESTRICT tables must be cleared manually; CASCADE tables
          // (factory_offload_additional_charges, factory_container_other_charges,
          //  factory_container_profit_snapshots) are handled automatically.
          await db.delete(factoryWasteEntries).where(eq(factoryWasteEntries.containerId, itemId));
          await db.delete(factoryDutyAuditLog).where(eq(factoryDutyAuditLog.containerId, itemId));
          await db.delete(factoryFxAllocations).where(eq(factoryFxAllocations.containerId, itemId));
          await db.delete(factoryContainerCommissions).where(eq(factoryContainerCommissions.containerId, itemId));
          // mix_batch_sources refs both container and raw_stock — delete before raw_stock
          await db.delete(factoryMixBatchSources).where(eq(factoryMixBatchSources.containerId, itemId));
          await db.delete(factoryRawStock).where(eq(factoryRawStock.containerId, itemId));
          await db
            .delete(factoryContainers)
            .where(and(eq(factoryContainers.id, itemId), eq(factoryContainers.companyId, companyId)));
          break;
        }
        case "factoryRawStock":
          await db
            .delete(factoryRawStock)
            .where(and(eq(factoryRawStock.id, itemId), eq(factoryRawStock.companyId, companyId)));
          break;
        case "factoryRawMaterialAdjustment":
          await db
            .delete(factoryRawMaterialAdjustments)
            .where(
              and(eq(factoryRawMaterialAdjustments.id, itemId), eq(factoryRawMaterialAdjustments.companyId, companyId))
            );
          break;
        case "factoryMixBatch":
          await db
            .delete(factoryMixBatches)
            .where(and(eq(factoryMixBatches.id, itemId), eq(factoryMixBatches.companyId, companyId)));
          break;
        case "factoryBale":
          await db.delete(factoryBales).where(and(eq(factoryBales.id, itemId), eq(factoryBales.companyId, companyId)));
          break;
        case "customerProforma":
          await db.delete(customerProformaLines).where(eq(customerProformaLines.proformaId, itemId));
          await db.delete(proformaStockReservations).where(eq(proformaStockReservations.proformaId, itemId));
          await db
            .delete(customerProformas)
            .where(and(eq(customerProformas.id, itemId), eq(customerProformas.companyId, companyId)));
          break;
        case "customerOrder":
          await db.delete(customerOrderBales).where(eq(customerOrderBales.orderId, itemId));
          await db.delete(customerOrderLines).where(eq(customerOrderLines.orderId, itemId));
          await db.delete(customerOrderCharges).where(eq(customerOrderCharges.orderId, itemId));
          await db
            .delete(customerOrders)
            .where(and(eq(customerOrders.id, itemId), eq(customerOrders.companyId, companyId)));
          break;
        default:
          return res.status(400).json({ message: "Invalid item type" });
      }

      res.json({ message: `${type} permanently deleted` });
    } catch (error: unknown) {
      if (error instanceof PermanentDeleteRefused) return res.status(409).json({ message: error.message });
      res.status(errorStatus(error)).json({ message: getErrorMessage(error) });
    }
  });

  // ============ AI Chatbot API Endpoints ============

  // Check if chatbot is enabled for current user
}
