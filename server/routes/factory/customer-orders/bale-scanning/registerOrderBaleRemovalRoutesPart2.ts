// Extracted from ./remove.ts to keep that module under the source-size cap.
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../../lib/httpHandlers";
import { logger } from "../../../../lib/logger";
import { parseId } from "../../../../lib/parseId";
import { resultRows } from "../../../../lib/queryResult";
import { db } from "../../../../db";
import { requireAuth } from "../../../../auth";
import { recalculateOrderTotals } from "../../_helpers";
import { acquireProformaCapacityTransactionLock } from "../proformaCapacityConcurrency";
import { reversePriorityAllocationForDeletedBaleTx } from "../priorityAutoAllocation";
import { PRIORITY_SCAN_LOCK_NAMESPACE } from "../priorityScanQueue";
import {
  customerOrderBaleRemovals,
  customerOrderBales,
  customerOrderCharges,
  customerOrderLines,
  customerOrders,
  factoryBales,
} from "@shared/schema";
import { and, eq, sql } from "drizzle-orm";
import { FactoryInvoiceRateRefusalError } from "../../../../services/accounting/perpetualInventory/factoryInvoice";
import { lockCustomerOrderTx, syncOrderTotalsTx } from "../orderChargeLedger";
import { closedPeriodErrorResponse } from "../../../../lib/closedPeriodError";
import {
  hasLiveFinancialTripTx,
  isPostedDispatchBaleTx,
} from "../../../../services/factory/dispatchTripFinancialGuards";
import { DispatchReconciliationRefusal } from "./registerOrderBaleRemovalRoutesPart1";

export function registerOrderBaleRemovalRoutesPart2(app: Express) {
  app.delete("/api/factory/customer-orders/:id/bales/:baleId", requireAuth, async (req: Request, res: Response) => {
    try {
      const reconciliation = req.query.source === "dispatch-reconciliation";
      // Phase 7 supersedes the old per-bale loop. This path has no approval
      // fingerprint and can leave the order partially reconciled; refuse it.
      // All shortages now use the atomic order-wide POST/remove-unshipped API.
      if (reconciliation) {
        return res.status(409).json({
          code: "USE_ATOMIC_DISPATCH_RECONCILIATION",
          message:
            "Use Compare All Trips → approve a batch of unshipped bales with a reason. Individual dispatch-reconciliation deletes are disabled.",
        });
      }
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

      const updatedPayload = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${PRIORITY_SCAN_LOCK_NAMESPACE}, ${companyId})`);
        if (order.proformaIdUsed) {
          await acquireProformaCapacityTransactionLock(tx, {
            companyId,
            proformaId: order.proformaIdUsed,
          });
        }

        // Serialize with trip financial posting and physical scanner updates.
        // Posted trips lock their own shipped bales, not every unshipped item
        // still waiting in the parent loading.
        await lockCustomerOrderTx(tx, companyId, orderId);
        const postedTrips = await hasLiveFinancialTripTx(tx, companyId, orderId);
        if (postedTrips) {
          const [currentOrder] = await tx
            .select({ status: customerOrders.status, invoiceNumber: customerOrders.invoiceNumber })
            .from(customerOrders)
            .where(and(eq(customerOrders.id, orderId), eq(customerOrders.companyId, companyId)));
          if (!currentOrder || !["DRAFT", "LOADING"].includes(currentOrder.status) || currentOrder.invoiceNumber) {
            throw new DispatchReconciliationRefusal(
              409,
              "This loading has posted trips and is no longer open. Use the approved dispatch reconciliation workflow."
            );
          }
        }
        const [orderBale] = await tx
          .select()
          .from(customerOrderBales)
          .where(and(eq(customerOrderBales.orderId, orderId), eq(customerOrderBales.id, baleId)));

        // A shipped/financially posted physical bale must NEVER be returned
        // to stock, even through a normal (non-reconciliation) remove action.
        if (orderBale && (await isPostedDispatchBaleTx(tx, companyId, orderId, orderBale.baleId))) {
          throw new DispatchReconciliationRefusal(
            409,
            "This bale belongs to a financially posted truck. Reverse that trip before removing it."
          );
        }
        if (postedTrips && !orderBale) {
          throw new DispatchReconciliationRefusal(409, "This item is no longer in the loading. Refresh and try again.");
        }

        // A bale physically scanned into ANY active truck cannot be released
        // from the parent loading, whether or not that truck has posted yet.
        // Use the dedicated dispatch workflow to correct its scans instead.
        if (orderBale) {
          const scanned = resultRows(
            await tx.execute(sql`
            SELECT 1
              FROM factory_loading_dispatch_scans s
              JOIN factory_loading_dispatches d
                ON d.id = s.dispatch_id AND d.company_id = s.company_id AND d.order_id = s.order_id
             WHERE s.company_id = ${companyId} AND s.order_id = ${orderId}
               AND s.bale_id = ${orderBale.baleId} AND s.removed_at IS NULL
               AND d.status <> 'CANCELLED'
             LIMIT 1
          `)
          );
          if (scanned.length > 0) {
            throw new DispatchReconciliationRefusal(
              409,
              "This item is scanned on a dispatch trip. Remove the scan through Dispatch Management first."
            );
          }
        }

        let baleDetails: typeof factoryBales.$inferSelect | undefined;
        if (orderBale) {
          const [found] = await tx
            .select()
            .from(factoryBales)
            .where(and(eq(factoryBales.id, orderBale.baleId), eq(factoryBales.companyId, companyId)))
            .for("update");
          baleDetails = found;
        }
        if (
          postedTrips &&
          orderBale &&
          (!baleDetails || !["IN_STOCK", "RESERVED_FOR_ORDER"].includes(baleDetails.status))
        ) {
          throw new DispatchReconciliationRefusal(
            409,
            "This unshipped item's stock ownership has changed. Refresh and inspect its dispatch history."
          );
        }

        await tx
          .delete(customerOrderBales)
          .where(and(eq(customerOrderBales.orderId, orderId), eq(customerOrderBales.id, baleId)));

        if (orderBale && baleDetails) {
          await tx
            .update(factoryBales)
            .set({ status: "IN_STOCK", updatedAt: new Date() })
            .where(eq(factoryBales.id, orderBale.baleId));

          const userId = req.user?.id ? String(req.user.id) : null;
          const username = req.user?.username || null;
          await tx.insert(customerOrderBaleRemovals).values({
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
          await tx
            .update(factoryBales)
            .set({ status: "IN_STOCK", updatedAt: new Date() })
            .where(eq(factoryBales.id, orderBale.baleId));
        }

        await recalculateOrderTotals(tx, orderId);
        // Existing posted trips already own their immutable receivables and
        // vouchers. Recompute only the still-open loading; never run the legacy
        // full-invoice sync against a partially posted dispatch order.
        if (!postedTrips) {
          await syncOrderTotalsTx(tx, companyId, orderId);
        }
        if (orderBale) {
          await reversePriorityAllocationForDeletedBaleTx(tx, {
            companyId,
            baleId: orderBale.baleId,
            detachedOrderId: orderId,
            actor: String(req.session.username || req.session.userId || "unknown"),
            actorId: req.session.userId == null ? null : String(req.session.userId),
            reason: "Bale removed from loading",
          });
        }

        const [updatedOrder] = await tx.select().from(customerOrders).where(eq(customerOrders.id, orderId));
        const updatedBales = await tx.select().from(customerOrderBales).where(eq(customerOrderBales.orderId, orderId));
        const updatedLines = await tx.select().from(customerOrderLines).where(eq(customerOrderLines.orderId, orderId));
        const updatedCharges = await tx
          .select()
          .from(customerOrderCharges)
          .where(eq(customerOrderCharges.orderId, orderId));

        return { ...updatedOrder, bales: updatedBales, lines: updatedLines, charges: updatedCharges };
      });

      res.json(updatedPayload);
    } catch (error: unknown) {
      if (error instanceof DispatchReconciliationRefusal) {
        return res.status(error.statusCode).json({ message: error.message });
      }
      if (error instanceof FactoryInvoiceRateRefusalError) return res.status(409).json(error.body);
      const closed = closedPeriodErrorResponse(error);
      if (closed) return res.status(closed.status).json(closed.body);
      logger.error("Error removing bale from order:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
