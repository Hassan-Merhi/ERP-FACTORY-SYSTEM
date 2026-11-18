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
import { requireAuth, requireRole } from "../../../../auth";
import { recalculateOrderTotals } from "../../_helpers";
import { acquireProformaCapacityTransactionLock } from "../proformaCapacityConcurrency";
import { reversePriorityAllocationForDeletedBaleTx } from "../priorityAutoAllocation";
import { PRIORITY_SCAN_LOCK_NAMESPACE } from "../priorityScanQueue";
import { factoryBales, customerOrders, customerOrderBales, customerOrderBaleRemovals } from "@shared/schema";
import { eq, and, isNull, ne, sql } from "drizzle-orm";
import { FactoryInvoiceRateRefusalError } from "../../../../services/accounting/perpetualInventory/factoryInvoice";
import { lockCustomerOrderTx, syncOrderTotalsTx } from "../orderChargeLedger";
import { closedPeriodErrorResponse } from "../../../../lib/closedPeriodError";
import { registerOrderBaleRemovalRoutesPart1 } from "./registerOrderBaleRemovalRoutesPart1";
import { registerOrderBaleRemovalRoutesPart2 } from "./registerOrderBaleRemovalRoutesPart2";

export function registerOrderBaleRemovalRoutes(app: Express) {
  registerOrderBaleRemovalRoutesPart1(app);
  registerOrderBaleRemovalRoutesPart2(app);
  registerOrderBaleRemovalRoutesPart3(app);
}

function registerOrderBaleRemovalRoutesPart3(app: Express) {
  // POST /api/factory/bales/:id/release-from-loading
  // Bale Explorer: detach one bale from an OPEN outbound loading without visiting the loading page.
  // V5 bales remain IN_STOCK while linked, so check the order link rather than the bale status alone.
  // Never edit finalized/verified orders or their accounting entries through this shortcut.
  app.post(
    "/api/factory/bales/:id/release-from-loading",
    requireAuth,
    requireRole("Admin", "Owner"),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const baleId = parseId(req.params.id);
        if (baleId === null) return res.status(400).json({ message: "Invalid bale id" });

        const [bale] = await db
          .select()
          .from(factoryBales)
          .where(and(eq(factoryBales.id, baleId), eq(factoryBales.companyId, companyId)));
        if (!bale) return res.status(404).json({ message: "Bale not found" });

        // Read the current assignment to determine the proforma lock. All of these
        // checks are repeated inside the transaction after acquiring the locks.
        const activeLinks = await db
          .select({
            id: customerOrderBales.id,
            orderId: customerOrders.id,
            orderStatus: customerOrders.status,
            proformaId: customerOrders.proformaIdUsed,
          })
          .from(customerOrderBales)
          .innerJoin(customerOrders, eq(customerOrderBales.orderId, customerOrders.id))
          .where(
            and(
              eq(customerOrderBales.baleId, baleId),
              eq(customerOrders.companyId, companyId),
              isNull(customerOrders.deletedAt),
              ne(customerOrders.status, "CANCELLED")
            )
          );

        if (activeLinks.length !== 1) {
          return res
            .status(409)
            .json({ message: "Bale has no unique active loading assignment. Refresh its details." });
        }
        const assignment = activeLinks[0];
        if (!["DRAFT", "LOADING"].includes(assignment.orderStatus)) {
          return res.status(409).json({
            message: "This loading is verified or finalized. Use the authorized order correction workflow instead.",
          });
        }

        const userId = req.user?.id ? String(req.user.id) : null;
        const username = req.user?.username || req.session.username || null;
        const result = await db.transaction(async (tx) => {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(${PRIORITY_SCAN_LOCK_NAMESPACE}, ${companyId})`);
          if (assignment.proformaId) {
            await acquireProformaCapacityTransactionLock(tx, {
              companyId,
              proformaId: assignment.proformaId,
            });
          }
          const [order] = await tx
            .select()
            .from(customerOrders)
            .where(and(eq(customerOrders.id, assignment.orderId), eq(customerOrders.companyId, companyId)))
            .for("update");
          if (
            !order ||
            !["DRAFT", "LOADING"].includes(order.status) ||
            order.proformaIdUsed !== assignment.proformaId
          ) {
            return { ok: false as const, message: "Loading changed or was finalized. Refresh and try again." };
          }

          const [lockedBale] = await tx
            .select()
            .from(factoryBales)
            .where(and(eq(factoryBales.id, baleId), eq(factoryBales.companyId, companyId)))
            .for("update");
          if (!lockedBale || !["IN_STOCK", "RESERVED_FOR_ORDER", "RESERVED"].includes(lockedBale.status)) {
            return { ok: false as const, message: "Bale is no longer available to release from this loading." };
          }

          const currentLinks = await tx
            .select({
              id: customerOrderBales.id,
              orderId: customerOrders.id,
              status: customerOrders.status,
            })
            .from(customerOrderBales)
            .innerJoin(customerOrders, eq(customerOrderBales.orderId, customerOrders.id))
            .where(
              and(
                eq(customerOrderBales.baleId, baleId),
                eq(customerOrders.companyId, companyId),
                isNull(customerOrders.deletedAt),
                ne(customerOrders.status, "CANCELLED")
              )
            );
          if (
            currentLinks.length !== 1 ||
            currentLinks[0].id !== assignment.id ||
            currentLinks[0].orderId !== order.id ||
            !["DRAFT", "LOADING"].includes(currentLinks[0].status)
          ) {
            return { ok: false as const, message: "Bale assignment changed. Refresh before releasing it." };
          }

          const removed = await tx
            .delete(customerOrderBales)
            .where(
              and(
                eq(customerOrderBales.id, assignment.id),
                eq(customerOrderBales.baleId, baleId),
                eq(customerOrderBales.orderId, order.id)
              )
            )
            .returning({ id: customerOrderBales.id });
          if (removed.length !== 1) {
            return { ok: false as const, message: "Bale has already been removed from this loading." };
          }

          // Do not create another stock record. Restore the original physical
          // bale; V5 normally already has IN_STOCK status before release.
          await tx
            .update(factoryBales)
            .set({ status: "IN_STOCK", updatedAt: new Date() })
            .where(and(eq(factoryBales.id, baleId), eq(factoryBales.companyId, companyId)));
          await tx.insert(customerOrderBaleRemovals).values({
            orderId: order.id,
            baleId,
            referenceNumber: lockedBale.referenceNumber,
            articleCode: lockedBale.articleCode || null,
            productName: lockedBale.productName || null,
            weightKg: lockedBale.weightKg,
            removedByUserId: userId,
            removedByUsername: username,
          });

          // This also supports removing the LAST bale from an open loading.
          // Leave the loading itself intact and eligible for the next scan.
          await recalculateOrderTotals(tx, order.id);
          await reversePriorityAllocationForDeletedBaleTx(tx, {
            companyId,
            baleId,
            detachedOrderId: order.id,
            actor: String(username || userId || "unknown"),
            actorId: userId,
            reason: "Bale Explorer: returned to stock from open loading",
          });

          const [updated] = await tx
            .select({
              totalQtyBales: customerOrders.totalQtyBales,
              grandTotal: customerOrders.grandTotal,
              status: customerOrders.status,
            })
            .from(customerOrders)
            .where(eq(customerOrders.id, order.id));
          return {
            ok: true as const,
            orderId: order.id,
            orderStatus: updated?.status,
            totalQtyBales: updated?.totalQtyBales,
            newGrandTotal: updated?.grandTotal,
          };
        });

        if (!result.ok) return res.status(409).json({ message: result.message });
        return res.json({ message: "Bale returned to stock and removed from loading", ...result });
      } catch (error: unknown) {
        const closed = closedPeriodErrorResponse(error);
        if (closed) return res.status(closed.status).json(closed.body);
        logger.error("Error releasing bale from open loading:", { error });
        return res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

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
  });
}
