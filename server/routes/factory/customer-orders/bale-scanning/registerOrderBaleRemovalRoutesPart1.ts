// Extracted from ./remove.ts to keep that module under the source-size cap.
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../../lib/httpHandlers";
import { logger } from "../../../../lib/logger";
import { db } from "../../../../db";
import { requireAuth } from "../../../../auth";
import { recalculateOrderTotals } from "../../_helpers";
import { acquireProformaCapacityTransactionLock } from "../proformaCapacityConcurrency";
import { reversePriorityAllocationForDeletedBaleTx } from "../priorityAutoAllocation";
import { PRIORITY_SCAN_LOCK_NAMESPACE, reactivateAutoCompletedPriorityLoadingsLockedTx } from "../priorityScanQueue";
import { customerOrderBaleRemovals, customerOrderBales, customerOrders, factoryBales } from "@shared/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { lockCustomerOrderTx } from "../orderChargeLedger";
import { getFactoryAccessState } from "../../../../lib/factoryAccessControl";
import { hasLiveFinancialTripTx } from "../../../../services/factory/dispatchTripFinancialGuards";
import { canEmptyFactoryLoadingContainer } from "@shared/factoryPermissionCatalog";
import {
  emptyBody,
  emptyQuery,
  idParams,
  validateRequest,
  validatedInput,
  type RequestSchemas,
} from "../../../../lib/validateRequest";

const emptyContainerInput = { params: idParams, query: emptyQuery, body: emptyBody } satisfies RequestSchemas;

export class DispatchReconciliationRefusal extends Error {
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message);
  }
}

export function registerOrderBaleRemovalRoutesPart1(app: Express) {
  // POST /api/factory/customer-orders/:id/bales/empty — return every scanned bale to stock
  // without cancelling the loading order, so the loader can start the container again from zero.
  app.post(
    "/api/factory/customer-orders/:id/bales/empty",
    requireAuth,
    validateRequest(emptyContainerInput),
    async (req: Request, res: Response) => {
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

        const orderId = validatedInput(req, emptyContainerInput).params.id;

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
    }
  );
}
