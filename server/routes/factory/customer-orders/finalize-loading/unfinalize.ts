/**
 * orderFinalizeLoadingRoutes: OrderUnfinalize endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../../lib/httpHandlers";
import { logger } from "../../../../lib/logger";
import { parseId } from "../../../../lib/parseId";
import { getClientDate } from "../../../../lib/dateUtils";
import { db } from "../../../../db";
import { requireAuth } from "../../../../auth";
import { writeDaybookEntry } from "../../_helpers";
import {
  factoryBales,
  customerOrders,
  customerOrderBales,
  customerOrderCharges,
  customerBalances,
  customers,
  voucherEntries,
  factoryDaybookEntries,
  vouchers,
} from "@shared/schema";
import { eq, and, sql, inArray } from "drizzle-orm";

export function registerOrderUnfinalizeRoutes(app: Express) {
  app.post(
    "/api/factory/customer-orders/:id/force-sync-bale-status",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const session = req.session;
        const companyId = session.factoryCompanyId || session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const role = (session.currentRole || session.role || "").toLowerCase();
        if (role !== "admin" && role !== "owner" && role !== "developer") {
          return res.status(403).json({ message: "Only admin/owner can force-sync bale statuses" });
        }

        const orderId = parseId(req.params.id);

        if (orderId === null) return res.status(400).json({ message: "Invalid id" });
        const [order] = await db
          .select()
          .from(customerOrders)
          .where(and(eq(customerOrders.id, orderId), eq(customerOrders.companyId, companyId)));
        if (!order) return res.status(404).json({ message: "Order not found" });
        if (!["VERIFIED", "FINALIZED"].includes(order.status)) {
          return res.status(400).json({ message: "Order must be VERIFIED or FINALIZED to force-sync bale statuses" });
        }
        if (!order.invoiceNumber) {
          return res
            .status(400)
            .json({ message: "Order must have an invoice number (previously finalized) to use force-sync" });
        }

        const orderBales = await db.select().from(customerOrderBales).where(eq(customerOrderBales.orderId, orderId));
        if (orderBales.length === 0) return res.status(400).json({ message: "Order has no bales" });

        let updated = 0;
        for (const b of orderBales) {
          const [existing] = await db
            .select({ status: factoryBales.status })
            .from(factoryBales)
            .where(eq(factoryBales.id, b.baleId));
          if (existing && existing.status !== "SOLD") {
            await db
              .update(factoryBales)
              .set({ status: "SOLD", updatedAt: new Date() })
              .where(eq(factoryBales.id, b.baleId));
            updated++;
          }
        }

        res.json({ message: `${updated} bale(s) marked as SOLD`, updated, total: orderBales.length });
      } catch (error: unknown) {
        logger.error("Error force-syncing bale status:", { error: error });
        res.status(400).json({ message: getErrorMessage(error) });
      }
    }
  );

  // Export a single customer order to Excel with full bale detail

  app.post("/api/factory/customer-orders/:id/unfinalize", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const orderId = parseId(req.params.id);

      if (orderId === null) return res.status(400).json({ message: "Invalid id" });

      await db.transaction(async (tx) => {
        const [order] = await tx
          .select()
          .from(customerOrders)
          .where(and(eq(customerOrders.id, orderId), eq(customerOrders.companyId, companyId)));
        if (!order) throw new Error("Order not found");
        if (order.status !== "FINALIZED") throw new Error("Only FINALIZED orders can be reverted to Draft");

        // Block if any payment has been recorded against this invoice
        const payments = await tx
          .select({ id: customerBalances.id })
          .from(customerBalances)
          .where(
            and(
              eq(customerBalances.companyId, companyId),
              eq(customerBalances.referenceId, orderId),
              eq(customerBalances.referenceType, "INVOICE"),
              eq(customerBalances.transactionType, "PAYMENT")
            )
          );
        if (payments.length > 0) {
          throw new Error("Cannot revert: this invoice has payments recorded against it. Reverse the payments first.");
        }

        // Delete the SALE balance entry for this invoice
        await tx
          .delete(customerBalances)
          .where(
            and(
              eq(customerBalances.companyId, companyId),
              eq(customerBalances.referenceId, orderId),
              eq(customerBalances.referenceType, "INVOICE"),
              eq(customerBalances.transactionType, "SALE")
            )
          );

        // Phase 6: delete charge journal vouchers via FK linkage; fall back to invoice-number
        // pattern for legacy unbacked rows. After delete, clear the FK on the charge rows so
        // they can be re-finalized later without dangling references.
        const linkedChargeRows = await tx
          .select({ id: customerOrderCharges.id, voucherId: customerOrderCharges.voucherId })
          .from(customerOrderCharges)
          .where(and(eq(customerOrderCharges.orderId, orderId), sql`${customerOrderCharges.voucherId} IS NOT NULL`));
        const linkedVoucherIds = linkedChargeRows.map((r) => r.voucherId).filter((v): v is number => v != null);

        if (linkedVoucherIds.length > 0) {
          await tx.delete(voucherEntries).where(inArray(voucherEntries.voucherId, linkedVoucherIds));
          await tx.update(vouchers).set({ deletedAt: new Date() }).where(inArray(vouchers.id, linkedVoucherIds));
          await tx
            .update(customerOrderCharges)
            .set({ voucherId: null })
            .where(and(eq(customerOrderCharges.orderId, orderId), sql`${customerOrderCharges.voucherId} IS NOT NULL`));
        }

        // Legacy fallback for charge vouchers that were never FK-linked
        if (order.invoiceNumber) {
          const legacyChargeVouchers = await tx
            .select({ id: vouchers.id })
            .from(vouchers)
            .where(
              and(
                eq(vouchers.companyId, companyId),
                eq(vouchers.sourceModule, "FACTORY"),
                sql`${vouchers.voucherNumber} LIKE ${"CHARGE-" + order.invoiceNumber + "-%"}`
              )
            );
          for (const cv of legacyChargeVouchers) {
            await tx.delete(voucherEntries).where(eq(voucherEntries.voucherId, cv.id));
            await tx.update(vouchers).set({ deletedAt: new Date() }).where(eq(vouchers.id, cv.id));
          }
        }

        // Revert bales from SOLD → RESERVED_FOR_ORDER (order still exists, just un-finalized)
        const bales = await tx.select().from(customerOrderBales).where(eq(customerOrderBales.orderId, orderId));
        for (const b of bales) {
          await tx
            .update(factoryBales)
            .set({ status: "RESERVED_FOR_ORDER", updatedAt: new Date() })
            .where(and(eq(factoryBales.id, b.baleId), eq(factoryBales.status, "SOLD")));
        }

        // Reset order to VERIFIED (skip Pending step), clear invoice number
        await tx
          .update(customerOrders)
          .set({
            status: "VERIFIED",
            invoiceNumber: null,
            updatedAt: new Date(),
          })
          .where(eq(customerOrders.id, orderId));

        // Daybook entry
        const [unfCustomer] = await tx
          .select({ legalName: customers.legalName })
          .from(customers)
          .where(eq(customers.id, order.customerId));
        const unfToday = req.body.txDate || getClientDate(req);
        // Remove any previous INVOICE and INVOICE_REVERTED rows so only this revert shows
        await tx
          .delete(factoryDaybookEntries)
          .where(
            and(
              eq(factoryDaybookEntries.companyId, companyId),
              sql`${factoryDaybookEntries.txType} IN ('INVOICE','INVOICE_REVERTED')`,
              eq(factoryDaybookEntries.referenceId, orderId)
            )
          );
        await writeDaybookEntry(tx, {
          companyId,
          txDate: unfToday,
          txType: "INVOICE_REVERTED",
          referenceId: orderId,
          description: `Invoice ${order.invoiceNumber} reverted to Draft – ${unfCustomer?.legalName || "Customer"}`,
        });
      });

      res.json({ message: "Invoice reverted to Draft successfully" });
    } catch (error: unknown) {
      logger.error("Error unfinalizing order:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });
}
