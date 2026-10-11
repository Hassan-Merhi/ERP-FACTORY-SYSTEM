/**
 * factoryCustomersRoutes: FactoryCustomerStatement endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { toMoney } from "../../../lib/money";
import { NOT_IN_LEDGER_LABEL } from "../../../services/accounting/balances/customerLedgerStatement";
import { customerOrders, customerBalances, customers } from "@shared/schema";
import { buildFactoryCustomerStatement, withRunningBalances } from "./statementRows";
import { eq, and, desc, sql } from "drizzle-orm";

export function registerFactoryCustomerStatementRoutes(app: Express) {
  // CUSTOMER STATEMENT
  // ───────────────────────────────────────────────

  app.get("/api/factory/customers/:id/statement", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const customerId = parseInt(req.params.id);
      if (isNaN(customerId)) return res.status(400).json({ message: "Invalid customer ID" });

      const [customer] = await db
        .select()
        .from(customers)
        .where(and(eq(customers.id, customerId), eq(customers.companyId, companyId)));
      if (!customer) return res.status(404).json({ message: "Customer not found" });

      // Get finalized invoices
      const invoices = await db
        .select({
          id: customerOrders.id,
          invoiceNumber: customerOrders.invoiceNumber,
          orderDate: customerOrders.orderDate,
          finalizedAt: customerOrders.finalizedAt,
          grandTotal: customerOrders.grandTotal,
          subtotalBales: customerOrders.subtotalBales,
          freightAmount: customerOrders.freightAmount,
          otherChargesTotal: customerOrders.otherChargesTotal,
          totalQtyBales: customerOrders.totalQtyBales,
          totalWeightKg: sql<string>`COALESCE((SELECT SUM(cob.weight) FROM customer_order_bales cob WHERE cob.order_id = ${customerOrders.id}), 0)`,
          containerNumber: customerOrders.containerNumber,
          destination: customerOrders.destination,
          status: customerOrders.status,
          createdAt: customerOrders.createdAt,
        })
        .from(customerOrders)
        .where(
          and(
            eq(customerOrders.companyId, companyId),
            eq(customerOrders.customerId, customerId),
            eq(customerOrders.status, "FINALIZED")
          )
        )
        .orderBy(desc(customerOrders.createdAt));

      // Build orderId → various field maps for enriching statement rows
      const containerByOrderId = new Map<number, string | null>(
        invoices.map((inv) => [inv.id, inv.containerNumber ?? null])
      );
      const destinationByOrderId = new Map<number, string | null>(
        invoices.map((inv) => [inv.id, inv.destination ?? null])
      );
      const totalQtyBalesByOrderId = new Map<number, number>(invoices.map((inv) => [inv.id, inv.totalQtyBales ?? 0]));
      const totalWeightKgByOrderId = new Map<number, number>(
        invoices.map((inv) => [inv.id, toMoney(inv.totalWeightKg).toNumber()])
      );

      // Ledger rows from the balance engine plus the amounts not yet in the
      // ledger as flagged memo rows (statementRows.ts). `runningBalance` and
      // `currentBalance` keep the page's combined meaning (ledger + not in the
      // ledger); `ledgerRunningBalance` / `ledgerBalance` are the ledger alone.
      const statement = await buildFactoryCustomerStatement(companyId, customerId);
      const balanceHistory = withRunningBalances(statement).map(({ row, combined, ledger }) => {
        const { ledgerEffect: _ledgerEffect, combinedEffect: _combinedEffect, ...rest } = row;
        const orderId = row.referenceType === "INVOICE" ? row.referenceId : null;
        return {
          ...rest,
          containerNumber: orderId ? (containerByOrderId.get(orderId) ?? null) : null,
          destination: orderId ? (destinationByOrderId.get(orderId) ?? null) : null,
          totalQtyBales: orderId ? (totalQtyBalesByOrderId.get(orderId) ?? null) : null,
          totalWeightKg: orderId ? (totalWeightKgByOrderId.get(orderId) ?? null) : null,
          runningBalance: combined.toNumber(),
          runningBalanceSide: combined.lessThan(0) ? "Cr" : "Dr",
          ledgerRunningBalance: ledger.toNumber(),
          ledgerRunningBalanceSide: ledger.lessThan(0) ? "Cr" : "Dr",
        };
      });

      const combinedClosing = statement.ledgerClosing.plus(statement.notInLedgerTotal);
      const currentBalance = combinedClosing.abs().toNumber();
      const currentBalanceSide = combinedClosing.lessThan(0) ? "Cr" : "Dr";
      const openingBalance = toMoney(customer.openingBalance).toNumber();
      const openingSide = customer.openingBalanceSide || "Dr";

      res.json({
        customer,
        invoices,
        balanceHistory,
        currentBalance,
        currentBalanceSide,
        balanceBasis: "ledger+notInLedger",
        ledgerBalance: statement.ledgerClosing.abs().toNumber(),
        ledgerBalanceSide: statement.ledgerClosing.lessThan(0) ? "Cr" : "Dr",
        notInLedgerTotal: statement.notInLedgerTotal.toNumber(),
        notInLedgerLabel: NOT_IN_LEDGER_LABEL,
        openingBalance,
        openingBalanceSide: openingSide,
      });
    } catch (error: unknown) {
      logger.error("Error fetching customer statement:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ── Save Statement Note ─────────────────────────────────────────────────
  app.patch("/api/factory/customers/:id/statement-note", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const customerId = parseInt(req.params.id);
      if (isNaN(customerId)) return res.status(400).json({ message: "Invalid customer ID" });
      const { statementNote } = req.body;
      if (typeof statementNote !== "string") return res.status(400).json({ message: "statementNote must be a string" });
      const [customer] = await db
        .select()
        .from(customers)
        .where(and(eq(customers.id, customerId), eq(customers.companyId, companyId)));
      if (!customer) return res.status(404).json({ message: "Customer not found" });
      await db
        .update(customers)
        .set({ statementNote: statementNote || null })
        .where(eq(customers.id, customerId));
      res.json({ ok: true });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ── Save Row Note on a balance entry ────────────────────────────────────
  app.patch(
    "/api/factory/customers/:customerId/balance/:entryId/note",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const customerId = parseInt(req.params.customerId);
        const entryId = parseInt(req.params.entryId);
        if (isNaN(customerId) || isNaN(entryId)) return res.status(400).json({ message: "Invalid IDs" });
        const { rowNote } = req.body;
        if (typeof rowNote !== "string") return res.status(400).json({ message: "rowNote must be a string" });
        const [entry] = await db
          .select()
          .from(customerBalances)
          .where(
            and(
              eq(customerBalances.id, entryId),
              eq(customerBalances.customerId, customerId),
              eq(customerBalances.companyId, companyId)
            )
          );
        if (!entry) return res.status(404).json({ message: "Entry not found" });
        await db
          .update(customerBalances)
          .set({ rowNote: rowNote || null })
          .where(eq(customerBalances.id, entryId));
        res.json({ ok: true });
      } catch (error: unknown) {
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}
