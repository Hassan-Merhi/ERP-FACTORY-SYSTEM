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
import { reversePriorityAllocationForDeletedBaleTx } from "../priorityAutoAllocation";
import { PRIORITY_SCAN_LOCK_NAMESPACE } from "../priorityScanQueue";
import { factoryBales, customerOrders, customerOrderBales, customerOrderBaleRemovals } from "@shared/schema";
import { eq, and, sql } from "drizzle-orm";
import { FactoryInvoiceRateRefusalError } from "../../../../services/accounting/perpetualInventory/factoryInvoice";
import { lockCustomerOrderTx, syncOrderTotalsTx } from "../orderChargeLedger";
import { closedPeriodErrorResponse } from "../../../../lib/closedPeriodError";
import { registerOrderBaleRemovalRoutesPart1 } from "./registerOrderBaleRemovalRoutesPart1";
import { registerOrderBaleRemovalRoutesPart2 } from "./registerOrderBaleRemovalRoutesPart2";
import { registerOrderBaleRemovalRoutesPart4 } from "./registerOrderBaleRemovalRoutesPart4";
import {
  emptyBody,
  emptyQuery,
  stringIdParams,
  validateRequest,
  type RequestSchemas,
} from "../../../../lib/validateRequest";

// Takes only the bale id (parseId in the handler); the Bale Explorer and
// Bales History screens post {}.
const baleActionInput = { params: stringIdParams, query: emptyQuery, body: emptyBody } satisfies RequestSchemas;

export function registerOrderBaleRemovalRoutes(app: Express) {
  registerOrderBaleRemovalRoutesPart1(app);
  registerOrderBaleRemovalRoutesPart2(app);
  registerOrderBaleRemovalRoutesPart3(app);
}

function registerOrderBaleRemovalRoutesPart3(app: Express) {
  registerOrderBaleRemovalRoutesPart4(app);

  // POST /api/factory/bales/:id/return-to-stock — remove a bale from its order and return it to stock
  // Works for any order status. For FINALIZED orders: updates customer_balances + daybook. Admin-gated.
  app.post(
    "/api/factory/bales/:id/return-to-stock",
    requireAuth,
    validateRequest(baleActionInput),
    async (req: Request, res: Response) => {
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
            message:
              "This is the last bale in the order. Cancel the entire order instead of removing individual bales.",
            isLastBale: true,
          });
        }

        await db.transaction(async (tx) => {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(${PRIORITY_SCAN_LOCK_NAMESPACE}, ${companyId})`);
          // Phase 22 (C), DI7: the order row is locked before it changes.
          await lockCustomerOrderTx(tx, companyId, orderId);
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
          await reversePriorityAllocationForDeletedBaleTx(tx, {
            companyId,
            baleId,
            detachedOrderId: orderId,
            actor: String(username || userId || "unknown"),
            actorId: userId,
            reason: "Bale returned to stock",
          });

          // 9. The invoice's customer balance (FINALIZED, row locked), the INVOICE /
          // ORDER_VERIFIED daybook row and the invoice journal follow the new total
          // in this transaction (phase 22 C; was an unlocked float rewrite).
          await syncOrderTotalsTx(tx, companyId, orderId);
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
        if (error instanceof FactoryInvoiceRateRefusalError) return res.status(409).json(error.body);
        const closed = closedPeriodErrorResponse(error);
        if (closed) return res.status(closed.status).json(closed.body);
        logger.error("Error returning bale to stock:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}
