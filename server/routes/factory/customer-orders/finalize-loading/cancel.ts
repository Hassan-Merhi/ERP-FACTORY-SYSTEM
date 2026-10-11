/**
 * orderFinalizeLoadingRoutes: OrderCancel endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../../lib/httpHandlers";
import { logger } from "../../../../lib/logger";
import { parseId } from "../../../../lib/parseId";
import { getClientDate } from "../../../../lib/dateUtils";
import { db, type DbTransaction } from "../../../../db";
import { requireAuth } from "../../../../auth";
import { writeDaybookEntry, recalculateOrderTotals } from "../../_helpers";
import { acquireProformaCapacityTransactionLock } from "../proformaCapacityConcurrency";
import { logAudit } from "../../../helpers/auditHelpers";
import { factoryBales, customerOrders, customerOrderBales, customers, factoryDaybookEntries } from "@shared/schema";
import { eq, and, sql, inArray } from "drizzle-orm";

type CustomerOrder = typeof customerOrders.$inferSelect;
const ORDER_CANCEL_CONFLICT = "ORDER_CANCEL_CONFLICT";

function getOrderIdentifier(order: CustomerOrder, orderId: number): string {
  const orderNumber = (order as CustomerOrder & { orderNumber?: string | null }).orderNumber;
  return orderNumber || `Order #${orderId}`;
}

async function releaseOrderBalesInBulk(tx: DbTransaction, baleIds: number[]): Promise<void> {
  const uniqueBaleIds = [...new Set(baleIds)];
  if (uniqueBaleIds.length === 0) return;

  await tx
    .update(factoryBales)
    .set({ status: "IN_STOCK", updatedAt: new Date() })
    .where(inArray(factoryBales.id, uniqueBaleIds));
}

// Phase 21 (B): written on the cancel's transaction, so a failed audit rolls
// the cancel back (it used to run after commit and be non-fatal).
async function writeCancelAuditTx(
  tx: DbTransaction,
  req: Request,
  companyId: number,
  orderId: number,
  order: CustomerOrder
): Promise<void> {
  await logAudit(
    {
      userId: req.session.userId!,
      username: req.session.username || req.session.userId!,
      companyId,
      action: "update",
      tableName: "factory_customer_orders",
      recordId: orderId,
      recordIdentifier: getOrderIdentifier(order, orderId),
      changes: { status: { old: order.status, new: "CANCELLED" } },
    },
    tx
  );
}

export function registerOrderCancelRoutes(app: Express) {
  app.post("/api/factory/customer-orders/:id/cancel", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const orderId = parseId(req.params.id);
      if (orderId === null) return res.status(400).json({ message: "Invalid id" });

      const [order] = await db
        .select()
        .from(customerOrders)
        .where(and(eq(customerOrders.id, orderId), eq(customerOrders.companyId, companyId)));
      if (!order) return res.status(404).json({ message: "Order not found" });

      if (order.proformaIdUsed && ["PENDING_VERIFICATION", "VERIFIED", "FINALIZED"].includes(order.status)) {
        return res.status(400).json({
          message:
            "V5 containers at or beyond PENDING_VERIFICATION cannot be cancelled. Contact admin for a reversal workflow.",
        });
      }

      if (!["DRAFT", "LOADING"].includes(order.status)) {
        return res.status(400).json({ message: "Only DRAFT or LOADING orders can be cancelled" });
      }

      const isV5Loading = Boolean(order.proformaIdUsed && order.status === "LOADING");
      const cancelToday = req.body?.txDate || getClientDate(req);
      const cancelledBy = req.session?.username || "user";

      const updated = await db.transaction(async (tx) => {
        // Same ordering as every other capacity-changing writer: proforma lock
        // first, then order/bale row locks. Cancelling releases this order's
        // bales back to the proforma, so a scan or import racing this cancel
        // must wait and re-read capacity rather than measure it mid-release.
        if (order.proformaIdUsed) {
          await acquireProformaCapacityTransactionLock(tx, {
            companyId,
            proformaId: order.proformaIdUsed,
          });
        }

        const orderBales = await tx
          .select({ baleId: customerOrderBales.baleId })
          .from(customerOrderBales)
          .where(eq(customerOrderBales.orderId, orderId));
        const baleIds = orderBales.map((row) => row.baleId);

        if (isV5Loading) {
          await tx.execute(
            sql`INSERT INTO customer_order_bales_history
                  (original_id, order_id, bale_id, bale_reference, location_id,
                   weight, article_code, bale_name, price_used, scanned_by)
                SELECT id, order_id, bale_id, bale_reference, location_id,
                       weight, article_code, bale_name, price_used, scanned_by
                FROM customer_order_bales
                WHERE order_id = ${orderId}`
          );
        }

        await releaseOrderBalesInBulk(tx, baleIds);

        if (isV5Loading) {
          await tx.delete(customerOrderBales).where(eq(customerOrderBales.orderId, orderId));
          await recalculateOrderTotals(tx, orderId);
        }

        const [cancelledOrder] = await tx
          .update(customerOrders)
          .set({ status: "CANCELLED", updatedAt: new Date() })
          .where(
            and(
              eq(customerOrders.id, orderId),
              eq(customerOrders.companyId, companyId),
              eq(customerOrders.status, order.status)
            )
          )
          .returning();

        if (!cancelledOrder) {
          throw new Error(ORDER_CANCEL_CONFLICT);
        }

        const [cancelCustomer] = await tx
          .select({ legalName: customers.legalName })
          .from(customers)
          .where(eq(customers.id, order.customerId));

        await tx
          .delete(factoryDaybookEntries)
          .where(
            and(
              eq(factoryDaybookEntries.companyId, companyId),
              eq(factoryDaybookEntries.txType, "ORDER_CANCELLED"),
              eq(factoryDaybookEntries.referenceId, orderId)
            )
          );

        await writeDaybookEntry(tx, {
          companyId,
          txDate: cancelToday,
          txType: "ORDER_CANCELLED",
          referenceId: orderId,
          description: isV5Loading
            ? `V5 container cancelled: ${cancelCustomer?.legalName || "Customer"}, ${orderBales.length} bale link${orderBales.length !== 1 ? "s" : ""} removed. Cancelled by: ${cancelledBy}.`
            : `Order cancelled: ${cancelCustomer?.legalName || "Customer"}, ${orderBales.length} bale${orderBales.length !== 1 ? "s" : ""} released`,
        });

        await writeCancelAuditTx(tx, req, companyId, orderId, order);
        return cancelledOrder;
      });

      return res.json(updated);
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      if (message === ORDER_CANCEL_CONFLICT) {
        return res.status(409).json({ message: "Only DRAFT or LOADING orders can be cancelled" });
      }
      logger.error("Error cancelling order:", { error });
      return res.status(500).json({ message });
    }
  });

  // Restore a recently-cancelled LOADING order back to LOADING status
  app.post("/api/factory/customer-orders/:id/restore-loading", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const orderId = parseId(req.params.id);
      if (orderId === null) return res.status(400).json({ message: "Invalid id" });

      const [order] = await db
        .select()
        .from(customerOrders)
        .where(and(eq(customerOrders.id, orderId), eq(customerOrders.companyId, companyId)));
      if (!order) return res.status(404).json({ message: "Order not found" });
      if (order.status !== "CANCELLED")
        return res.status(400).json({ message: "Only CANCELLED orders can be restored" });
      if (!order.loadingStartedAt) return res.status(400).json({ message: "This order was not a loading order" });

      // Phase 21 (B): the restore and its audit commit together (it ran
      // statement by statement with an after-commit, non-fatal audit).
      const restored = await db.transaction(async (tx) => {
        const orderBales = await tx.select().from(customerOrderBales).where(eq(customerOrderBales.orderId, orderId));
        if (!order.proformaIdUsed) {
          for (const ob of orderBales) {
            await tx
              .update(factoryBales)
              .set({ status: "RESERVED_FOR_ORDER", updatedAt: new Date() })
              .where(and(eq(factoryBales.id, ob.baleId), eq(factoryBales.status, "IN_STOCK")));
          }
        }

        const [restoredOrder] = await tx
          .update(customerOrders)
          .set({ status: "LOADING", updatedAt: new Date() })
          .where(eq(customerOrders.id, orderId))
          .returning();

        await tx
          .delete(factoryDaybookEntries)
          .where(
            and(
              eq(factoryDaybookEntries.companyId, companyId),
              eq(factoryDaybookEntries.txType, "ORDER_CANCELLED"),
              eq(factoryDaybookEntries.referenceId, orderId)
            )
          );

        await logAudit(
          {
            userId: req.session.userId!,
            username: req.session.username || req.session.userId!,
            companyId,
            action: "update",
            tableName: "factory_customer_orders",
            recordId: orderId,
            recordIdentifier: getOrderIdentifier(order, orderId),
            changes: { status: { old: "CANCELLED", new: "LOADING" } },
          },
          tx
        );
        return restoredOrder;
      });

      return res.json(restored);
    } catch (error: unknown) {
      logger.error("Error restoring loading order:", { error });
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ───────────────────────────────────────────────
  // CONTAINER LOADING WORKFLOW
  // ───────────────────────────────────────────────
}
