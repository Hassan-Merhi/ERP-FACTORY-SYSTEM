// Extracted from ./remove.ts
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
import { closedPeriodErrorResponse } from "../../../../lib/closedPeriodError";
import {
  emptyBody,
  emptyQuery,
  stringIdParams,
  validateRequest,
  type RequestSchemas,
} from "../../../../lib/validateRequest";

// Takes only the bale id (parseId in the handler); the Bale Explorer posts {}.
const baleActionInput = { params: stringIdParams, query: emptyQuery, body: emptyBody } satisfies RequestSchemas;

export function registerOrderBaleRemovalRoutesPart4(app: Express) {
  // POST /api/factory/bales/:id/release-from-loading
  // Bale Explorer: detach one bale from an OPEN outbound loading without visiting the loading page.
  // V5 bales remain IN_STOCK while linked, so check the order link rather than the bale status alone.
  // Never edit finalized/verified orders or their accounting entries through this shortcut.
  app.post(
    "/api/factory/bales/:id/release-from-loading",
    requireAuth,
    requireRole("Admin", "Owner"),
    validateRequest(baleActionInput),
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
}
