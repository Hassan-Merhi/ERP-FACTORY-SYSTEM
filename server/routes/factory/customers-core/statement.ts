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
import { customerOrders, customerBalances, customers, voucherEntries, vouchers } from "@shared/schema";
import { eq, and, desc, sql } from "drizzle-orm";
import { toMoney } from "../../../lib/money";

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
        invoices.map((inv) => [inv.id, parseFloat(inv.totalWeightKg ?? "0")])
      );

      // Build a map of orderId → current grandTotal so we can correct stale
      // INVOICE rows on the fly (read-only — no DB writes from a GET).
      const invoiceGrandTotalMap = new Map<number, string>(invoices.map((inv) => [inv.id, inv.grandTotal]));

      // Map orderId → finalized date (date portion of finalizedAt, or orderDate fallback for legacy rows)
      const invoiceFinalizedDateMap = new Map<number, string>(
        invoices.map((inv) => {
          const d: Date | null = inv.finalizedAt ?? null;
          return [inv.id, d ? d.toISOString().slice(0, 10) : (inv.orderDate as string)];
        })
      );

      // Get all balance history entries ordered by date
      const rawBalanceRows = await db
        .select()
        .from(customerBalances)
        .where(and(eq(customerBalances.companyId, companyId), eq(customerBalances.customerId, customerId)))
        .orderBy(customerBalances.transactionDate, customerBalances.id);

      const balanceRows = rawBalanceRows.map((row) => {
        if (row.referenceType === "INVOICE" && row.referenceId) {
          const overrides: Record<string, unknown> = {};
          if (invoiceGrandTotalMap.has(row.referenceId)) {
            const actualAmt = invoiceGrandTotalMap.get(row.referenceId)!;
            overrides.debitAmount = actualAmt;
            overrides.balance = actualAmt;
          }
          if (invoiceFinalizedDateMap.has(row.referenceId)) {
            overrides.transactionDate = invoiceFinalizedDateMap.get(row.referenceId);
          }
          return { ...row, ...overrides };
        }
        return row;
      });

      // Also pull voucher entries for this customer (by ledgerAccountId or direct customerId link)
      // to include manual accounting vouchers that don't flow through customerBalances.
      // Exclude CHARGE-* vouchers (those are already included via invoices).
      const voucherRows = [];
      const ledgerAccountId = customer.ledgerAccountId;
      const voucherConditions = ledgerAccountId
        ? sql`(${voucherEntries.ledgerAccountId} = ${ledgerAccountId} OR ${voucherEntries.customerId} = ${customerId})`
        : sql`${voucherEntries.customerId} = ${customerId}`;

      const rawVoucherRows = await db
        .select({
          id: voucherEntries.id,
          voucherId: voucherEntries.voucherId,
          voucherNumber: vouchers.voucherNumber,
          voucherType: vouchers.voucherType,
          voucherDate: vouchers.voucherDate,
          description: vouchers.description,
          debitAmount: voucherEntries.debitAmount,
          creditAmount: voucherEntries.creditAmount,
          narration: voucherEntries.narration,
          optional: vouchers.optional,
        })
        .from(voucherEntries)
        .innerJoin(
          vouchers,
          and(
            eq(voucherEntries.voucherId, vouchers.id),
            eq(vouchers.companyId, companyId),
            sql`${vouchers.voucherNumber} NOT LIKE 'CHARGE-%'`,
            sql`${vouchers.voucherNumber} NOT LIKE 'INV-%'`
          )
        )
        .where(voucherConditions)
        .orderBy(vouchers.voucherDate, voucherEntries.id);

      // Convert to unified row format matching customerBalances shape
      for (const ve of rawVoucherRows) {
        if (ve.optional) continue; // optional vouchers don't affect the balance
        voucherRows.push({
          id: `ve-${ve.id}`,
          customerId,
          companyId,
          transactionDate: ve.voucherDate,
          transactionType: ve.voucherType || "VOUCHER",
          referenceType: "VOUCHER",
          referenceId: ve.voucherId,
          referenceNumber: ve.voucherNumber,
          description: ve.narration || ve.description || ve.voucherType,
          debitAmount: ve.debitAmount ?? "0",
          creditAmount: ve.creditAmount ?? "0",
          balance: "0",
          _fromVoucher: true,
        });
      }

      // Merge customerBalances + voucher rows, sort by date then id
      const allRows = [...balanceRows.map((r) => ({ ...r, _fromVoucher: false })), ...voucherRows].sort((a, b) => {
        const da = (a.transactionDate || "").toString();
        const db2 = (b.transactionDate || "").toString();
        if (da < db2) return -1;
        if (da > db2) return 1;
        // same date: customerBalances rows first (they have numeric ids)
        const ia = a._fromVoucher ? 1 : 0;
        const ib = b._fromVoucher ? 1 : 0;
        return ia - ib;
      });

      // Build running balance
      // Exact running balance: a float total drifted (0.10 + 0.20 = 0.30000000000000004).
      const openingBalance = toMoney(customer.openingBalance);
      const openingSide = customer.openingBalanceSide || "Dr";
      let runningBalance = openingSide === "Dr" ? openingBalance : openingBalance.negated();

      const balanceHistory = allRows.map((row) => {
        runningBalance = runningBalance.plus(toMoney(row.debitAmount)).minus(toMoney(row.creditAmount));
        const containerNumber =
          row.referenceType === "INVOICE" && row.referenceId ? (containerByOrderId.get(row.referenceId) ?? null) : null;
        const destination =
          row.referenceType === "INVOICE" && row.referenceId
            ? (destinationByOrderId.get(row.referenceId) ?? null)
            : null;
        const totalQtyBales =
          row.referenceType === "INVOICE" && row.referenceId
            ? (totalQtyBalesByOrderId.get(row.referenceId) ?? null)
            : null;
        const totalWeightKg =
          row.referenceType === "INVOICE" && row.referenceId
            ? (totalWeightKgByOrderId.get(row.referenceId) ?? null)
            : null;
        return {
          ...row,
          containerNumber,
          destination,
          totalQtyBales,
          totalWeightKg,
          runningBalance: runningBalance.toNumber(),
          runningBalanceSide: runningBalance.gte(0) ? "Dr" : "Cr",
        };
      });

      const currentBalance = runningBalance.abs().toNumber();
      const currentBalanceSide = runningBalance.gte(0) ? "Dr" : "Cr";

      res.json({
        customer,
        invoices,
        balanceHistory,
        currentBalance,
        currentBalanceSide,
        openingBalance: openingBalance.toNumber(),
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
