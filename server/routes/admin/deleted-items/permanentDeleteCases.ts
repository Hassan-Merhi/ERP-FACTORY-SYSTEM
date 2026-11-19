// Extracted from ./permanent-delete.ts: per-type delete handlers.
import { db } from "../../../db";
import { writeAuditEvent } from "../../../services/audit";
import {
  customerOrderCharges,
  stockTransferVouchers,
  stockTransferItems,
  containerSales,
  purchaseOrders,
  vouchers,
  voucherEntries,
  interCompanyTransfers,
  fiscalPeriodClosures,
  wasteDispatches,
  salaryAdvances,
  propertyPayments,
  factoryTransporterTransactions,
  bankAccounts,
  suppliers,
  customers,
  employees,
  employeeGroupMembers,
  employeeBaleRates,
  employeeBalePctRates,
  erpWorkerDocs,
  erpPayrollRunItems,
  ledgerAccounts,
  inventory,
  stockItems,
  stockItemCodeAliases,
  stockItemLocationPrices,
  locations,
} from "@shared/schema";
import { eq, and, inArray, sql, ne, or } from "drizzle-orm";
import { isRetiredVoucherNumber } from "../../../services/accounting/voucherRetirement";
import {
  CLOSING_VOUCHER_MESSAGE,
  RETIRED_VOUCHER_NOT_DELETABLE_MESSAGE,
  PermanentDeleteRefused,
  ACCOUNT_HAS_HISTORY_MESSAGE,
  hasOpening,
  firstFound,
  CUSTOMER_HAS_HISTORY_MESSAGE,
  CUSTOMER_HAS_OPENING_MESSAGE,
  EMPLOYEE_HAS_HISTORY_MESSAGE,
  LOCATION_HAS_STOCK_MESSAGE,
} from "./permanent-deleteHelpers";
import type { permanentDeleteStep } from "./permanentDeleteStep";
import type { Request, Response } from "express";
import { companyScopedSuppliers } from "@shared/schema/supplierCompanyScope";
import { toMoney } from "../../../lib/money";
import { STOCK_ITEM_HAS_HISTORY_MESSAGE, stockItemHasHistory } from "../../../services/inventory/stockItemHistory";

type PermanentDeleteStepResult = Awaited<ReturnType<typeof permanentDeleteStep>>;

export async function permanentDeleteVoucher({
  pd1,
  res,
  req,
}: {
  pd1: { pd1: Extract<PermanentDeleteStepResult, { done: false }>; req: Request; res: Response }["pd1"];
  res: Response;
  req: Request;
}) {
  const { itemId, companyId } = pd1;
  // A fiscal close's journal is referenced by its closure row. Deleting
  // that row would silently reopen the period, so refuse instead.
  const [closure] = await db
    .select({ id: fiscalPeriodClosures.id })
    .from(fiscalPeriodClosures)
    .where(eq(fiscalPeriodClosures.closingVoucherId, itemId))
    .limit(1);
  if (closure) {
    return {
      done: true as const,
      value: { done: true as const, value: res.status(409).json({ message: CLOSING_VOUCHER_MESSAGE }) },
    };
  }

  // One transaction: the voucher, its lines and every unlinked
  // reference go together, or nothing changes.
  await db.transaction(async (tx) => {
    const [voucher] = await tx
      .select()
      .from(vouchers)
      .where(and(eq(vouchers.id, itemId), eq(vouchers.companyId, companyId)))
      .for("update");
    // Wave 18 (B): a voucher the system retired (renamed ~DEL) stays.
    if (isRetiredVoucherNumber(voucher?.voucherNumber)) {
      throw new PermanentDeleteRefused(RETIRED_VOUCHER_NOT_DELETABLE_MESSAGE);
    }
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
    await tx.update(customerOrderCharges).set({ voucherId: null }).where(eq(customerOrderCharges.voucherId, itemId));
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
        companyId: companyId,
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

  return { done: false as const };
}

export async function permanentDeleteBankAccount({
  pd1,
}: {
  pd1: { pd1: Extract<PermanentDeleteStepResult, { done: false }>; req: Request; res: Response }["pd1"];
}) {
  const { removeOne, itemId, companyId } = pd1;
  await removeOne(
    bankAccounts,
    "bank_accounts",
    (tx) => tx.delete(bankAccounts).where(and(eq(bankAccounts.id, itemId), eq(bankAccounts.companyId, companyId))),
    async (tx, row) => {
      if (
        hasOpening(row) ||
        (await firstFound(tx, [sql`SELECT 1 FROM ${voucherEntries} WHERE ${voucherEntries.bankAccountId} = ${itemId}`]))
      ) {
        throw new PermanentDeleteRefused(ACCOUNT_HAS_HISTORY_MESSAGE);
      }
    }
  );
}

export async function permanentDeleteSupplier({
  pd1,
}: {
  pd1: { pd1: Extract<PermanentDeleteStepResult, { done: false }>; req: Request; res: Response }["pd1"];
}) {
  const { removeOne, itemId, companyId } = pd1;
  // Wave 18 (B): the active company's supplier only; refused while any
  // voucher line names it or its opening is not zero.
  await removeOne(
    suppliers,
    "suppliers",
    (tx) =>
      tx
        .delete(companyScopedSuppliers)
        .where(and(eq(companyScopedSuppliers.id, itemId), eq(companyScopedSuppliers.companyId, companyId))),
    async (tx, row) => {
      if (
        hasOpening(row) ||
        (await firstFound(tx, [sql`SELECT 1 FROM ${voucherEntries} WHERE ${voucherEntries.supplierId} = ${itemId}`]))
      ) {
        throw new PermanentDeleteRefused(ACCOUNT_HAS_HISTORY_MESSAGE);
      }
    }
  );
}

export async function permanentDeleteCustomer({
  pd1,
  req,
}: {
  pd1: { pd1: Extract<PermanentDeleteStepResult, { done: false }>; req: Request; res: Response }["pd1"];
  req: Request;
}) {
  const { itemId, companyId } = pd1;
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
      .where(and(eq(customers.id, itemId), eq(customers.companyId, companyId)))
      .for("update");
    // Wave 18 (B): a non-zero opening is history too.
    if (customer && !toMoney(customer.openingBalance ?? "0").isZero()) {
      throw new PermanentDeleteRefused(CUSTOMER_HAS_OPENING_MESSAGE);
    }

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
        companyId: companyId,
        action: "delete",
        tableName: "customers",
        recordId: itemId,
        recordIdentifier: customer?.legalName ?? null,
        changes: { permanentDelete: { new: true }, customer: { old: customer ?? null } },
      },
      tx
    );
  });
}

export async function permanentDeleteEmployee({
  pd1,
  req,
}: {
  pd1: { pd1: Extract<PermanentDeleteStepResult, { done: false }>; req: Request; res: Response }["pd1"];
  req: Request;
}) {
  const { itemId, companyId } = pd1;
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
        companyId: companyId,
        action: "delete",
        tableName: "employees",
        recordId: itemId,
        recordIdentifier: employee?.code ?? null,
        changes: { permanentDelete: { new: true }, employee: { old: employee ?? null } },
      },
      tx
    );
  });
}

export async function permanentDeleteLedgerAccount({
  pd1,
}: {
  pd1: { pd1: Extract<PermanentDeleteStepResult, { done: false }>; req: Request; res: Response }["pd1"];
}) {
  const { removeOne, itemId, companyId } = pd1;
  // Wave 18 (B): refused while any voucher line (live or deleted voucher)
  // names the account or its opening is not zero.
  await removeOne(
    ledgerAccounts,
    "ledger_accounts",
    (tx) =>
      tx.delete(ledgerAccounts).where(and(eq(ledgerAccounts.id, itemId), eq(ledgerAccounts.companyId, companyId))),
    async (tx, row) => {
      if (
        hasOpening(row) ||
        (await firstFound(tx, [
          sql`SELECT 1 FROM ${voucherEntries} WHERE ${voucherEntries.ledgerAccountId} = ${itemId}`,
        ]))
      ) {
        throw new PermanentDeleteRefused(ACCOUNT_HAS_HISTORY_MESSAGE);
      }
    }
  );
}

export async function permanentDeleteStockItem({
  pd1,
  req,
}: {
  pd1: { pd1: Extract<PermanentDeleteStepResult, { done: false }>; req: Request; res: Response }["pd1"];
  req: Request;
}) {
  const { companyId, itemId } = pd1;
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
        companyId: companyId,
        action: "delete",
        tableName: "stock_items",
        recordId: itemId,
        recordIdentifier: item?.code ?? null,
        changes: { permanentDelete: { new: true }, stockItem: { old: item ?? null } },
      },
      tx
    );
  });
}

export async function permanentDeleteLocation({
  pd1,
  req,
}: {
  pd1: { pd1: Extract<PermanentDeleteStepResult, { done: false }>; req: Request; res: Response }["pd1"];
  req: Request;
}) {
  const { itemId, companyId } = pd1;
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
      .where(and(eq(inventory.locationId, itemId), or(ne(inventory.quantity, "0"), ne(inventory.totalValue, "0"))))
      .limit(1);
    if (held.length > 0) throw new PermanentDeleteRefused(LOCATION_HAS_STOCK_MESSAGE);
    await tx.delete(locations).where(and(eq(locations.id, itemId), eq(locations.companyId, companyId)));
    await writeAuditEvent(
      {
        userId: req.session.userId ?? "unknown",
        username: req.session.username || "unknown",
        companyId: companyId,
        action: "delete",
        tableName: "locations",
        recordId: itemId,
        recordIdentifier: location?.code ?? null,
        changes: { permanentDelete: { new: true }, location: { old: location ?? null } },
      },
      tx
    );
  });
}
