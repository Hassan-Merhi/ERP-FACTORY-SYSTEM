/**
 * baleScanningRoutes: OrderBaleSwap endpoints.
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
import { factoryBales, customerOrders, customerOrderBales, customers, customerOrderBaleRemovals } from "@shared/schema";
import { eq, and, sql, ilike, inArray } from "drizzle-orm";
import { FactoryInvoiceRateRefusalError } from "../../../../services/accounting/perpetualInventory/factoryInvoice";
import { lockCustomerOrderTx, syncOrderTotalsTx } from "../orderChargeLedger";
import { closedPeriodErrorResponse } from "../../../../lib/closedPeriodError";

export function registerOrderBaleSwapRoutes(app: Express) {
  // GET /api/factory/bales/:id/order-info — get the order a bale is allocated to (for the confirmation dialog)
  app.get("/api/factory/bales/:id/order-info", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const baleId = parseId(req.params.id);
      if (baleId === null) return res.status(400).json({ message: "Invalid bale id" });

      const [orderBale] = await db.select().from(customerOrderBales).where(eq(customerOrderBales.baleId, baleId));
      if (!orderBale) return res.json(null);

      const [order] = await db
        .select({
          id: customerOrders.id,
          status: customerOrders.status,
          invoiceNumber: customerOrders.invoiceNumber,
          grandTotal: customerOrders.grandTotal,
          customerName: customers.legalName,
          orderDate: customerOrders.orderDate,
          containerNumber: customerOrders.containerNumber,
          totalQtyBales: customerOrders.totalQtyBales,
        })
        .from(customerOrders)
        .leftJoin(customers, eq(customers.id, customerOrders.customerId))
        .where(and(eq(customerOrders.id, orderBale.orderId), eq(customerOrders.companyId, companyId)));

      if (!order) return res.json(null);

      // Count remaining bales so the frontend can warn if this is the last one
      const baleCount = await db
        .select({ count: sql<number>`count(*)` })
        .from(customerOrderBales)
        .where(eq(customerOrderBales.orderId, order.id));
      const remainingCount = Number(baleCount[0]?.count ?? 0);

      res.json({ ...order, totalBalesInOrder: remainingCount });
    } catch (error: unknown) {
      logger.error("Error fetching bale order info:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // POST /api/factory/bales/swap — swap a loaded bale (SOLD/RESERVED) with an IN_STOCK bale by reference number
  // The current bale is returned to stock; the replacement bale takes its place in the order.
  app.post("/api/factory/bales/swap", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { currentBaleRef, replacementBaleRef } = req.body;
      if (!currentBaleRef || !replacementBaleRef) {
        return res.status(400).json({ message: "Both currentBaleRef and replacementBaleRef are required" });
      }
      if (currentBaleRef.trim().toUpperCase() === replacementBaleRef.trim().toUpperCase()) {
        return res.status(400).json({ message: "Replacement bale must be different from the current bale" });
      }

      const userId = req.user?.id ? String(req.user.id) : null;
      const username = req.user?.username || null;

      // 1. Find current bale
      const [currentBale] = await db
        .select()
        .from(factoryBales)
        .where(and(eq(factoryBales.companyId, companyId), ilike(factoryBales.referenceNumber, currentBaleRef.trim())));
      if (!currentBale) return res.status(404).json({ message: `Bale "${currentBaleRef}" not found` });
      if (!["RESERVED_FOR_ORDER", "RESERVED", "SOLD"].includes(currentBale.status)) {
        return res.status(400).json({
          message: `Bale "${currentBaleRef}" is ${currentBale.status} — it must be loaded in an order to be swapped`,
        });
      }

      // 2. Find replacement bale
      const [replacementBale] = await db
        .select()
        .from(factoryBales)
        .where(
          and(eq(factoryBales.companyId, companyId), ilike(factoryBales.referenceNumber, replacementBaleRef.trim()))
        );
      if (!replacementBale)
        return res.status(404).json({ message: `Replacement bale "${replacementBaleRef}" not found` });
      if (replacementBale.status !== "IN_STOCK") {
        return res.status(400).json({
          message: `Replacement bale "${replacementBaleRef}" is ${replacementBale.status} — it must be IN_STOCK to be used as a replacement`,
        });
      }

      // 3. Find the customerOrderBales row for the current bale
      const [orderBale] = await db
        .select()
        .from(customerOrderBales)
        .where(eq(customerOrderBales.baleId, currentBale.id));
      if (!orderBale) {
        // No order link — just flip current back to stock
        await db
          .update(factoryBales)
          .set({ status: "IN_STOCK", updatedAt: new Date() })
          .where(eq(factoryBales.id, currentBale.id));
        return res.status(400).json({ message: "No order link found for the current bale" });
      }

      // 4. Find the order
      const [order] = await db
        .select()
        .from(customerOrders)
        .where(and(eq(customerOrders.id, orderBale.orderId), eq(customerOrders.companyId, companyId)));
      if (!order) return res.status(404).json({ message: "Associated order not found" });

      await db.transaction(async (tx) => {
        // Phase 22 (C), DI7: the order row is locked before the order changes,
        // and both bales are re-read locked so a concurrent swap or scan of the
        // same bale cannot slip in between the checks above and the writes.
        await lockCustomerOrderTx(tx, companyId, order.id);
        const lockedBales = await tx
          .select({ id: factoryBales.id, status: factoryBales.status })
          .from(factoryBales)
          .where(
            and(eq(factoryBales.companyId, companyId), inArray(factoryBales.id, [currentBale.id, replacementBale.id]))
          )
          .for("update");
        const lockedStatus = new Map(lockedBales.map((row) => [row.id, row.status]));
        if (
          lockedStatus.get(currentBale.id) !== currentBale.status ||
          lockedStatus.get(replacementBale.id) !== "IN_STOCK"
        ) {
          throw new Error("The bales changed while the swap was being prepared; reload and try again");
        }

        // 5. Update customerOrderBales to point to the replacement bale (keep priceUsed unchanged)
        await tx
          .update(customerOrderBales)
          .set({
            baleId: replacementBale.id,
            baleReference: replacementBale.referenceNumber,
            weight: replacementBale.weightKg,
            articleCode: replacementBale.articleCode || null,
            baleName: replacementBale.productName || null,
          })
          .where(eq(customerOrderBales.id, orderBale.id));

        // 6. Return current bale to IN_STOCK
        await tx
          .update(factoryBales)
          .set({ status: "IN_STOCK", updatedAt: new Date() })
          .where(eq(factoryBales.id, currentBale.id));

        // 7. Set replacement bale to the same status as the current bale
        await tx
          .update(factoryBales)
          .set({ status: currentBale.status, updatedAt: new Date() })
          .where(eq(factoryBales.id, replacementBale.id));

        // 8. Audit log
        await tx.insert(customerOrderBaleRemovals).values({
          orderId: order.id,
          baleId: currentBale.id,
          referenceNumber: currentBale.referenceNumber,
          articleCode: currentBale.articleCode || null,
          productName: currentBale.productName || null,
          weightKg: currentBale.weightKg,
          removedByUserId: userId,
          removedByUsername: username
            ? `${username} (swapped → ${replacementBale.referenceNumber})`
            : `swap → ${replacementBale.referenceNumber}`,
        });

        // 9. Recalculate order totals
        await recalculateOrderTotals(tx, order.id);

        // 10. The invoice's customer balance (FINALIZED, row locked), the INVOICE /
        // ORDER_VERIFIED daybook row and the invoice journal follow the new total
        // in this transaction (phase 22 C; the balance was read and rewritten
        // with no lock, as a float).
        await syncOrderTotalsTx(tx, companyId, order.id);
      });

      const [finalOrder] = await db.select().from(customerOrders).where(eq(customerOrders.id, order.id));
      res.json({
        message: "Bale swapped successfully",
        orderId: order.id,
        orderStatus: finalOrder?.status,
        invoiceNumber: finalOrder?.invoiceNumber,
        newGrandTotal: finalOrder?.grandTotal,
        replacedRef: currentBale.referenceNumber,
        replacementRef: replacementBale.referenceNumber,
      });
    } catch (error: unknown) {
      if (error instanceof FactoryInvoiceRateRefusalError) return res.status(409).json(error.body);
      const closed = closedPeriodErrorResponse(error);
      if (closed) return res.status(closed.status).json(closed.body);
      logger.error("Error swapping bale:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
