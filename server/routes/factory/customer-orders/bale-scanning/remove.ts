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
import { resultRows } from "../../../../lib/queryResult";
import { db } from "../../../../db";
import { requireAuth, requireRole } from "../../../../auth";
import { recalculateOrderTotals } from "../../_helpers";
import { acquireProformaCapacityTransactionLock } from "../proformaCapacityConcurrency";
import { reversePriorityAllocationForDeletedBaleTx } from "../priorityAutoAllocation";
import { PRIORITY_SCAN_LOCK_NAMESPACE, reactivateAutoCompletedPriorityLoadingsLockedTx } from "../priorityScanQueue";
import {
  factoryBales,
  customerOrders,
  customerOrderLines,
  customerOrderBales,
  customerOrderCharges,
  customerOrderBaleRemovals,
} from "@shared/schema";
import { eq, and, inArray, isNull, ne, sql } from "drizzle-orm";
import { FactoryInvoiceRateRefusalError } from "../../../../services/accounting/perpetualInventory/factoryInvoice";
import { lockCustomerOrderTx, syncOrderTotalsTx } from "../orderChargeLedger";
import { closedPeriodErrorResponse } from "../../../../lib/closedPeriodError";
import { getFactoryAccessState } from "../../../../lib/factoryAccessControl";
import {
  hasLiveFinancialTripTx,
  isPostedDispatchBaleTx,
} from "../../../../services/factory/dispatchTripFinancialGuards";
import { canEmptyFactoryLoadingContainer } from "@shared/factoryPermissionCatalog";

class DispatchReconciliationRefusal extends Error {
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message);
  }
}

export function registerOrderBaleRemovalRoutes(app: Express) {
  // POST /api/factory/customer-orders/:id/bales/empty — return every scanned bale to stock
  // without cancelling the loading order, so the loader can start the container again from zero.
  app.post("/api/factory/customer-orders/:id/bales/empty", requireAuth, async (req: Request, res: Response) => {
    try {
      // Resolve the live company membership; a stale pinned factory id
      // cannot widen this per-company destructive-action grant.
      const access = await getFactoryAccessState(req);
      if (
        !access ||
        !canEmptyFactoryLoadingContainer({
          role: access.role,
          hasFactoryAccess: access.hasFactoryAccess,
          pageKeys: access.pageKeys,
          hiddenCostFields: access.hiddenTabs,
        })
      ) {
        return res.status(403).json({ message: "You do not have permission to empty this container" });
      }
      const companyId = access.companyId;

      const orderId = parseId(req.params.id);
      if (orderId === null) return res.status(400).json({ message: "Invalid id" });

      const [order] = await db
        .select()
        .from(customerOrders)
        .where(and(eq(customerOrders.id, orderId), eq(customerOrders.companyId, companyId)));
      if (!order) return res.status(404).json({ message: "Order not found" });

      if (!["DRAFT", "LOADING"].includes(order.status)) {
        return res.status(400).json({
          message: "Can only empty a container while the loading order is in DRAFT or LOADING",
        });
      }

      const userId = req.user?.id ? String(req.user.id) : null;
      const username = req.user?.username || null;

      const removedCount = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${PRIORITY_SCAN_LOCK_NAMESPACE}, ${companyId})`);
        // Emptied containers would release shipped goods to stock. Serialize
        // with the same parent lock as trip financial posting and reject that.
        await lockCustomerOrderTx(tx, companyId, orderId);
        if (await hasLiveFinancialTripTx(tx, companyId, orderId)) {
          throw new DispatchReconciliationRefusal(
            409,
            "Financially posted dispatch trips cannot be emptied. Reverse their accounting first."
          );
        }
        if (order.proformaIdUsed) {
          await acquireProformaCapacityTransactionLock(tx, {
            companyId,
            proformaId: order.proformaIdUsed,
          });
        }

        // Delete the order links first and use RETURNING so concurrent requests
        // cannot both claim the same scanned bales.
        const removedLinks = await tx
          .delete(customerOrderBales)
          .where(eq(customerOrderBales.orderId, orderId))
          .returning({
            id: customerOrderBales.id,
            baleId: customerOrderBales.baleId,
          });

        if (removedLinks.length === 0) {
          await recalculateOrderTotals(tx, orderId);
          return 0;
        }

        const baleIds = removedLinks.map((row) => row.baleId);
        const baleDetails = await tx
          .select()
          .from(factoryBales)
          .where(and(inArray(factoryBales.id, baleIds), eq(factoryBales.companyId, companyId)));

        await tx
          .update(factoryBales)
          .set({ status: "IN_STOCK", updatedAt: new Date() })
          .where(and(inArray(factoryBales.id, baleIds), eq(factoryBales.companyId, companyId)));

        if (baleDetails.length > 0) {
          await tx.insert(customerOrderBaleRemovals).values(
            baleDetails.map((bale) => ({
              orderId,
              baleId: bale.id,
              referenceNumber: bale.referenceNumber,
              articleCode: bale.articleCode || null,
              productName: bale.productName || null,
              weightKg: bale.weightKg,
              removedByUserId: userId,
              removedByUsername: username,
            }))
          );
        }

        await recalculateOrderTotals(tx, orderId);
        for (const row of removedLinks) {
          await reversePriorityAllocationForDeletedBaleTx(tx, {
            companyId,
            baleId: row.baleId,
            detachedOrderId: orderId,
            actor: String(username || userId || "unknown"),
            actorId: userId,
            reason: "Loading emptied",
            deferQueueRecovery: true,
          });
        }
        await reactivateAutoCompletedPriorityLoadingsLockedTx(tx, companyId, [orderId]);
        return removedLinks.length;
      });

      const [updatedOrder] = await db
        .select({
          status: customerOrders.status,
          totalQtyBales: customerOrders.totalQtyBales,
          totalWeightKg: sql<string>`COALESCE(
            (SELECT SUM(cob.weight) FROM customer_order_bales cob WHERE cob.order_id = ${customerOrders.id}),
            0
          )::text`,
        })
        .from(customerOrders)
        .where(eq(customerOrders.id, orderId));
      res.json({
        message: removedCount === 0 ? "Container is already empty" : "Container emptied and bales returned to stock",
        removed: removedCount,
        orderId,
        status: updatedOrder?.status,
        totalQtyBales: updatedOrder?.totalQtyBales,
        totalWeightKg: updatedOrder?.totalWeightKg ?? "0",
      });
    } catch (error: unknown) {
      logger.error("Error emptying loading container:", { error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

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
      const access = reconciliation ? await getFactoryAccessState(req) : null;
      if (reconciliation && (!access || !["admin", "owner", "developer"].includes(access.role.toLowerCase()))) {
        return res.status(403).json({ message: "Only Admin, Owner or Developer can reconcile missing dispatch bales" });
      }
      const companyId = reconciliation
        ? access!.companyId
        : req.session.factoryCompanyId || req.session.currentCompanyId;
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
        if (reconciliation) {
          // This check is inside the same order lock used by physical scanners.
          // A bale cannot be removed if it was scanned or if a trip is still open.
          const currentRows = await tx.execute(sql`
            SELECT status FROM customer_orders
             WHERE company_id = ${companyId} AND id = ${orderId}
               AND deleted_at IS NULL
          `);
          const status = resultRows(currentRows)[0]?.status;
          if (!["LOADING", "PENDING_VERIFICATION"].includes(typeof status === "string" ? status : "")) {
            throw new DispatchReconciliationRefusal(409, "Only active Pending Loading orders can be reconciled");
          }
          const tripRows = await tx.execute(sql`
            SELECT COUNT(*)::integer AS "totalTrips",
                   COUNT(*) FILTER (WHERE status = 'OPEN')::integer AS "openTrips"
              FROM factory_loading_dispatches
             WHERE status <> 'CANCELLED' AND company_id = ${companyId} AND order_id = ${orderId}
          `);
          const tripCounts = resultRows(tripRows)[0];
          if (Number(tripCounts?.totalTrips ?? 0) === 0 || Number(tripCounts?.openTrips ?? 0) > 0) {
            throw new DispatchReconciliationRefusal(409, "Finish all dispatch trips before removing missing bales");
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

        if (reconciliation) {
          if (!orderBale) {
            throw new DispatchReconciliationRefusal(409, "Bale is no longer in this loading. Refresh comparison.");
          }
          const scanned = await tx.execute(sql`
            SELECT id FROM factory_loading_dispatch_scans
             WHERE company_id = ${companyId} AND order_id = ${orderId}
               AND bale_id = ${orderBale.baleId} AND removed_at IS NULL
             LIMIT 1
          `);
          if (resultRows(scanned).length > 0) {
            throw new DispatchReconciliationRefusal(
              409,
              "This bale was verified on a trip and cannot be removed as missing"
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
