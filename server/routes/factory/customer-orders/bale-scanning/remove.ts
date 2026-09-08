/**
 * baleScanningRoutes: OrderBaleRemoval endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../../lib/httpHandlers";
import { logger } from "../../../../lib/logger";
import { parseId } from "../../../../lib/parseId";
import { db } from "../../../../db";
import { requireAuth } from "../../../../auth";
import { recalculateOrderTotals } from "../../_helpers";
import {
  factoryBales,
  customerOrders,
  customerOrderLines,
  customerOrderBales,
  customerOrderCharges,
  customerBalances,
  factoryDaybookEntries,
  customerOrderBaleRemovals,
} from "@shared/schema";
import { eq, and } from "drizzle-orm";

export function registerOrderBaleRemovalRoutes(app: Express) {
  app.delete("/api/factory/customer-orders/:id/bales/:baleId", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const orderId = parseId(req.params.id);

      if (orderId === null) return res.status(400).json({ message: "Invalid id" });
      const baleId = parseId(req.params.baleId);
      if (baleId === null) return res.status(400).json({ message: "Invalid id" });

      const [order] = await db
        .select()
        .from(customerOrders)
        .where(and(eq(customerOrders.id, orderId), eq(customerOrders.companyId, companyId)));
      if (!order) return res.status(404).json({ message: "Order not found" });
      if (!["DRAFT", "LOADING", "PENDING_VERIFICATION", "VERIFIED", "FINALIZED"].includes(order.status))
        return res.status(400).json({ message: "Can only remove bales from orders that are not yet cancelled" });

      const [orderBale] = await db
        .select()
        .from(customerOrderBales)
        .where(and(eq(customerOrderBales.orderId, orderId), eq(customerOrderBales.id, baleId)));

      // Fetch full bale details before deleting the join row, so we can log it
      let baleDetails: typeof factoryBales.$inferSelect | undefined;
      if (orderBale) {
        const [found] = await db.select().from(factoryBales).where(eq(factoryBales.id, orderBale.baleId));
        baleDetails = found;
      }

      await db
        .delete(customerOrderBales)
        .where(and(eq(customerOrderBales.orderId, orderId), eq(customerOrderBales.id, baleId)));

      if (orderBale && baleDetails) {
        await db
          .update(factoryBales)
          .set({ status: "IN_STOCK", updatedAt: new Date() })
          .where(eq(factoryBales.id, orderBale.baleId));

        // Log the removal so it's visible on the loading page
        const userId = req.user?.id ? String(req.user.id) : null;
        const username = req.user?.username || null;
        await db.insert(customerOrderBaleRemovals).values({
          orderId,
          baleId: orderBale.baleId,
          referenceNumber: baleDetails.referenceNumber,
          articleCode: baleDetails.articleCode || null,
          productName: baleDetails.productName || null,
          weightKg: baleDetails.weightKg,
          removedByUserId: userId,
          removedByUsername: username,
        });
      } else if (orderBale) {
        await db
          .update(factoryBales)
          .set({ status: "IN_STOCK", updatedAt: new Date() })
          .where(eq(factoryBales.id, orderBale.baleId));
      }

      await recalculateOrderTotals(db, orderId);

      const [updatedOrder] = await db.select().from(customerOrders).where(eq(customerOrders.id, orderId));
      const updatedBales = await db.select().from(customerOrderBales).where(eq(customerOrderBales.orderId, orderId));
      const updatedLines = await db.select().from(customerOrderLines).where(eq(customerOrderLines.orderId, orderId));
      const updatedCharges = await db
        .select()
        .from(customerOrderCharges)
        .where(eq(customerOrderCharges.orderId, orderId));

      res.json({ ...updatedOrder, bales: updatedBales, lines: updatedLines, charges: updatedCharges });
    } catch (error: unknown) {
      logger.error("Error removing bale from order:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // POST /api/factory/bales/:id/return-to-stock — remove a bale from its order and return it to stock
  // Works for any order status. For FINALIZED orders: updates customer_balances + daybook. Admin-gated.
  app.post("/api/factory/bales/:id/return-to-stock", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const baleId = parseId(req.params.id);
      if (baleId === null) return res.status(400).json({ message: "Invalid bale id" });

      const userId = req.user?.id ? String(req.user.id) : null;
      const username = req.user?.username || null;

      // 1. Find the bale
      const [bale] = await db
        .select()
        .from(factoryBales)
        .where(and(eq(factoryBales.id, baleId), eq(factoryBales.companyId, companyId)));
      if (!bale) return res.status(404).json({ message: "Bale not found" });
      if (!["RESERVED_FOR_ORDER", "RESERVED", "SOLD"].includes(bale.status)) {
        return res.status(400).json({ message: `Bale is ${bale.status} — it is not allocated to an order` });
      }

      // 2. Find the customer_order_bales row
      const [orderBale] = await db.select().from(customerOrderBales).where(eq(customerOrderBales.baleId, baleId));
      if (!orderBale) {
        // Bale has no order row — just flip it back to IN_STOCK
        await db
          .update(factoryBales)
          .set({ status: "IN_STOCK", updatedAt: new Date() })
          .where(eq(factoryBales.id, baleId));
        return res.json({
          message: "Bale returned to stock (no order link found)",
          orderId: null,
          orderStatus: null,
        });
      }

      const orderId = orderBale.orderId;

      // 3. Fetch order
      const [order] = await db
        .select()
        .from(customerOrders)
        .where(and(eq(customerOrders.id, orderId), eq(customerOrders.companyId, companyId)));
      if (!order) return res.status(404).json({ message: "Associated order not found" });

      // 4. Guard: cannot remove the LAST bale (order must be cancelled instead)
      const remainingBales = await db
        .select({ id: customerOrderBales.id })
        .from(customerOrderBales)
        .where(eq(customerOrderBales.orderId, orderId));
      if (remainingBales.length <= 1) {
        return res.status(400).json({
          message: "This is the last bale in the order. Cancel the entire order instead of removing individual bales.",
          isLastBale: true,
        });
      }

      await db.transaction(async (tx) => {
        // 5. Remove from customer_order_bales
        await tx.delete(customerOrderBales).where(eq(customerOrderBales.id, orderBale.id));

        // 6. Return bale to IN_STOCK
        await tx
          .update(factoryBales)
          .set({ status: "IN_STOCK", updatedAt: new Date() })
          .where(eq(factoryBales.id, baleId));

        // 7. Audit log
        await tx.insert(customerOrderBaleRemovals).values({
          orderId,
          baleId,
          referenceNumber: bale.referenceNumber,
          articleCode: bale.articleCode || null,
          productName: bale.productName || null,
          weightKg: bale.weightKg,
          removedByUserId: userId,
          removedByUsername: username,
        });

        // 8. Recalculate order totals (regenerates order lines + grand total)
        await recalculateOrderTotals(tx, orderId);

        // 9. For FINALIZED orders: sync customer_balances + daybook INVOICE entry
        if (order.status === "FINALIZED") {
          const [recalcOrder] = await tx
            .select({ grandTotal: customerOrders.grandTotal })
            .from(customerOrders)
            .where(eq(customerOrders.id, orderId));
          const newGrandTotal = parseFloat(recalcOrder?.grandTotal || "0");

          const [ledgerEntry] = await tx
            .select({ id: customerBalances.id })
            .from(customerBalances)
            .where(
              and(
                eq(customerBalances.companyId, companyId),
                eq(customerBalances.referenceType, "INVOICE"),
                eq(customerBalances.referenceId, orderId)
              )
            );
          if (ledgerEntry) {
            await tx
              .update(customerBalances)
              .set({ debitAmount: String(newGrandTotal), balance: String(newGrandTotal) })
              .where(eq(customerBalances.id, ledgerEntry.id));
          }

          const [daybookEntry] = await tx
            .select({ id: factoryDaybookEntries.id })
            .from(factoryDaybookEntries)
            .where(
              and(
                eq(factoryDaybookEntries.companyId, companyId),
                eq(factoryDaybookEntries.txType, "INVOICE"),
                eq(factoryDaybookEntries.referenceId, orderId)
              )
            );
          if (daybookEntry) {
            await tx
              .update(factoryDaybookEntries)
              .set({ amountCurrency: String(newGrandTotal), amountUsd: String(newGrandTotal) })
              .where(eq(factoryDaybookEntries.id, daybookEntry.id));
          }
        }

        // 10. For VERIFIED orders: sync ORDER_VERIFIED daybook entry
        if (order.status === "VERIFIED") {
          const [recalcOrder] = await tx
            .select({ grandTotal: customerOrders.grandTotal })
            .from(customerOrders)
            .where(eq(customerOrders.id, orderId));
          const newGrandTotal = parseFloat(recalcOrder?.grandTotal || "0");

          const [verifiedEntry] = await tx
            .select({ id: factoryDaybookEntries.id })
            .from(factoryDaybookEntries)
            .where(
              and(
                eq(factoryDaybookEntries.companyId, companyId),
                eq(factoryDaybookEntries.txType, "ORDER_VERIFIED"),
                eq(factoryDaybookEntries.referenceId, orderId)
              )
            );
          if (verifiedEntry) {
            await tx
              .update(factoryDaybookEntries)
              .set({ amountCurrency: String(newGrandTotal), amountUsd: String(newGrandTotal) })
              .where(eq(factoryDaybookEntries.id, verifiedEntry.id));
          }
        }
      });

      // Return updated order info for the frontend to display
      const [finalOrder] = await db.select().from(customerOrders).where(eq(customerOrders.id, orderId));
      res.json({
        message: "Bale returned to stock",
        orderId,
        orderStatus: finalOrder?.status,
        invoiceNumber: finalOrder?.invoiceNumber,
        newGrandTotal: finalOrder?.grandTotal,
      });
    } catch (error: unknown) {
      logger.error("Error returning bale to stock:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
