/**
 * The guards and the delete path of the generic bale status / delete routes
 * (balesCrudRoutes.ts): accounting audit phase 19 C (F3) value-neutral policy,
 * combined at the merge of main #2134 with its physical-deletion service,
 * Priority Scan lock and live-loading check.
 */
import type { Request, Response } from "express";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { customerOrderBales, customerOrders, factoryBales } from "@shared/schema";
import type { DbTransaction } from "../../../db";
import { getClientDate } from "../../../lib/dateUtils";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { writeAuditEvent } from "../../../services/audit/auditService";
import {
  BaleStatusChangeRefusal,
  FACTORY_BALE_DELETE_CHANGES_VALUE_MESSAGE,
  isValueNeutralBaleDelete,
  KNOWN_BALE_STATUSES,
} from "../../../services/factory/baleStatusPolicy";
import { deletePhysicalFactoryBalesTx, PhysicalBaleDeletionError } from "../stock/physicalBaleDeletion";
import { PRIORITY_SCAN_LOCK_NAMESPACE } from "../customer-orders/priorityScanQueue";

/** The status vocabulary the routes accept (an unknown status is 400). */
export const ALLOWED = KNOWN_BALE_STATUSES;

const BALE_ON_FINALIZED_ORDER_MESSAGE =
  "Cannot set status to IN_STOCK: this bale is on a finalized order. Use the Return to Stock action to remove it from the order first.";

class BaleOnFinalizedOrderError extends Error {}

/**
 * A bale on a finalized, dispatched or sold order is not set back to IN_STOCK
 * here (the valuation does not count it as stock); the Return to Stock action
 * takes it off the order first.
 */
export async function assertNotOnFinalizedOrderTx(
  tx: DbTransaction,
  companyId: number,
  status: string,
  baleIds: number[]
): Promise<void> {
  if (status !== "IN_STOCK" || baleIds.length === 0) return;
  const [onOrder] = await tx
    .select({ baleId: customerOrderBales.baleId })
    .from(customerOrderBales)
    .innerJoin(customerOrders, eq(customerOrders.id, customerOrderBales.orderId))
    .where(
      and(
        inArray(customerOrderBales.baleId, baleIds),
        eq(customerOrders.companyId, companyId),
        inArray(customerOrders.status, ["FINALIZED", "VERIFIED", "DISPATCHED", "SOLD"])
      )
    )
    .limit(1);
  if (onOrder) throw new BaleOnFinalizedOrderError(BALE_ON_FINALIZED_ORDER_MESSAGE);
}

const LIVE_LOADING_STATUS_MESSAGE =
  "This bale is on an open customer loading. Remove it from the loading (or delete the bale) instead of changing its status.";

class BaleOnLiveLoadingError extends Error {}

/**
 * A bale on a DRAFT/LOADING loading may only carry the statuses the loading
 * flow itself uses. Any other status edit would detach it from stock or
 * inventory without reversing its loading link, totals and Priority Scan state.
 */
export async function assertNoLiveLoadingLinkOutsideLoadingStatusTx(
  tx: DbTransaction,
  companyId: number,
  baleIds: number[],
  status: string
): Promise<void> {
  if (["IN_STOCK", "RESERVED_FOR_ORDER"].includes(status) || baleIds.length === 0) return;
  const [linked] = await tx
    .select({ id: customerOrderBales.id })
    .from(customerOrderBales)
    .innerJoin(customerOrders, eq(customerOrders.id, customerOrderBales.orderId))
    .where(
      and(
        inArray(customerOrderBales.baleId, baleIds),
        eq(customerOrders.companyId, companyId),
        inArray(customerOrders.status, ["DRAFT", "LOADING"]),
        isNull(customerOrders.deletedAt)
      )
    )
    .limit(1);
  if (linked) throw new BaleOnLiveLoadingError(LIVE_LOADING_STATUS_MESSAGE);
}

/** The company's Priority Scan queue lock (main #2134): bale writers serialise with loading scans. */
export const lockPriorityScanQueueTx = (tx: DbTransaction, companyId: number) =>
  tx.execute(sql`SELECT pg_advisory_xact_lock(${PRIORITY_SCAN_LOCK_NAMESPACE}, ${companyId})`);

/**
 * Deletes bales through the one physical-deletion service (loading links,
 * Priority Scan reversals, daily scans, deletion record, daybook), but only
 * pre-stock bales (Phase 19 C, F3): a valued bale is removed or written off
 * through Stock Removal. The caller holds the Priority Scan lock. One audit
 * row per bale (the bale as it was) in the same transaction. A bale that is
 * not this company's, or already deleted, is 404 (nothing written).
 */
export async function deletePreStockBalesTx(
  tx: DbTransaction,
  req: Request,
  companyId: number,
  baleIds: number[],
  reason: string
): Promise<(typeof factoryBales.$inferSelect)[]> {
  const bales = await tx
    .select()
    .from(factoryBales)
    .where(and(eq(factoryBales.companyId, companyId), inArray(factoryBales.id, baleIds)));
  // An already deleted bale is not found here, as in the physical-deletion service.
  if (bales.length !== baleIds.length || bales.some((bale) => bale.deletedAt)) {
    throw new PhysicalBaleDeletionError("Bale not found", 404);
  }
  const refused = bales
    .filter((bale) => !isValueNeutralBaleDelete(bale.status, bale.deletedAt))
    .map((bale) => ({ id: bale.id, from: bale.status, to: "DELETED" }));
  if (refused.length > 0) throw new BaleStatusChangeRefusal(FACTORY_BALE_DELETE_CHANGES_VALUE_MESSAGE, refused);
  const userId = req.session.userId == null ? null : String(req.session.userId);
  const actorName = String(req.session.username || req.session.userId || "unknown");
  const deleted = await deletePhysicalFactoryBalesTx(tx, {
    companyId,
    baleIds,
    actorId: userId,
    actorName,
    reason,
    businessDate: getClientDate(req),
  });
  for (const bale of bales) {
    await writeAuditEvent(
      {
        userId: userId ?? "unknown",
        username: actorName,
        companyId,
        action: "delete",
        tableName: "factory_bales",
        recordId: bale.id,
        recordIdentifier: bale.referenceNumber || `Bale #${bale.id}`,
        changes: { status: { old: bale.status, new: "DELETED" }, bale: { old: bale }, reason: { new: reason } },
      },
      tx
    );
  }
  return deleted;
}

/** The status-route errors that answer a client status (anything else is 500). */
export function baleWriteErrorResponse(res: Response, error: unknown) {
  if (error instanceof BaleStatusChangeRefusal) return res.status(409).json(error.body);
  if (error instanceof BaleOnFinalizedOrderError || error instanceof BaleOnLiveLoadingError)
    return res.status(409).json({ message: error.message });
  if (error instanceof PhysicalBaleDeletionError) return res.status(error.status).json({ message: error.message });
  return res.status(500).json({ message: getErrorMessage(error) });
}
