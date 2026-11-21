// Extracted from ./permanentDeleteCases.ts
import { db } from "../../../db";
import { writeAuditEvent } from "../../../services/audit";
import {
  voucherEntries,
  salaryAdvances,
  customers,
  employees,
  employeeGroupMembers,
  employeeBaleRates,
  employeeBalePctRates,
  erpWorkerDocs,
  erpPayrollRunItems,
  inventory,
  stockItems,
  stockItemCodeAliases,
  stockItemLocationPrices,
} from "@shared/schema";
import { eq, and, sql } from "drizzle-orm";
import {
  PermanentDeleteRefused,
  firstFound,
  CUSTOMER_HAS_HISTORY_MESSAGE,
  CUSTOMER_HAS_OPENING_MESSAGE,
  EMPLOYEE_HAS_HISTORY_MESSAGE,
} from "./permanent-deleteHelpers";
import type { permanentDeleteStep } from "./permanentDeleteStep";
import type { Request, Response } from "express";
import { toMoney } from "../../../lib/money";
import { STOCK_ITEM_HAS_HISTORY_MESSAGE, stockItemHasHistory } from "../../../services/inventory/stockItemHistory";

export type PermanentDeleteStepResult = Awaited<ReturnType<typeof permanentDeleteStep>>;

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
