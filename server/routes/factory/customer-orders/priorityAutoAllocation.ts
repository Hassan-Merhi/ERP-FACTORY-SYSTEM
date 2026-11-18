import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { db } from "../../../db";
import { customerOrderBales, customerOrders, factoryBales } from "@shared/schema";
import { recalculateOrderTotals } from "../_helpers";
import { acquireProformaCapacityTransactionLock } from "./proformaCapacityConcurrency";
import {
  PRIORITY_SCAN_LOCK_NAMESPACE,
  reactivateAutoCompletedPriorityLoadingsLockedTx,
  type PriorityScanTransaction,
} from "./priorityScanQueue";
import { allocateAutomaticPriorityBaleTx, type AutomaticPriorityAllocation } from "./allocateAutomaticPriorityBaleTx";
export {
  allocateAutomaticPriorityBaleTx,
  automaticPriorityModeEnabled,
  isNonBalePriorityProductTx,
} from "./allocateAutomaticPriorityBaleTx";
export type { AutomaticPriorityAllocation } from "./allocateAutomaticPriorityBaleTx";

/** Caller holds the company queue lock. Keep historical evidence, remove only active links. */
export async function reversePriorityAllocationForDeletedBaleTx(
  tx: PriorityScanTransaction,
  args: {
    companyId: number;
    baleId: number;
    actor: string;
    actorId?: string | null;
    reason: string;
    detachedOrderId?: number;
    deferQueueRecovery?: boolean;
  }
): Promise<number[]> {
  const { companyId, baleId, actor, reason } = args;
  const rows = await tx
    .select({
      id: customerOrderBales.id,
      orderId: customerOrderBales.orderId,
      status: customerOrders.status,
      proformaIdUsed: customerOrders.proformaIdUsed,
    })
    .from(customerOrderBales)
    .innerJoin(customerOrders, eq(customerOrderBales.orderId, customerOrders.id))
    // Cancelled or soft-deleted orders no longer own the bale; their links are
    // kept as their own history and are never touched here.
    .where(
      and(
        eq(customerOrderBales.baleId, baleId),
        eq(customerOrders.companyId, companyId),
        ne(customerOrders.status, "CANCELLED"),
        isNull(customerOrders.deletedAt)
      )
    );
  // Do not silently bypass invoicing or finalized-order accounting.
  if (rows.some((row) => !["DRAFT", "LOADING"].includes(row.status))) {
    throw new Error("Cannot delete a bale in a verified/finalized loading. Reverse the order financially first.");
  }
  const affected = [
    ...new Set([...rows.map((r) => r.orderId), ...(args.detachedOrderId ? [args.detachedOrderId] : [])]),
  ];
  // Respect the existing priority -> proforma lock order.
  for (const id of [...new Set(rows.map((r) => r.proformaIdUsed).filter((id): id is number => id != null))].sort(
    (a, b) => a - b
  )) {
    await acquireProformaCapacityTransactionLock(tx, { companyId, proformaId: id });
  }

  // Verification/finalization may be happening outside the priority queue
  // lock. Lock the affected orders AFTER their proforma locks and recheck
  // their current status before removing any active bale/order links.
  for (const orderId of [...new Set(rows.map((r) => r.orderId))].sort((a, b) => a - b)) {
    const [lockedOrder] = await tx
      .select({ status: customerOrders.status })
      .from(customerOrders)
      .where(and(eq(customerOrders.id, orderId), eq(customerOrders.companyId, companyId)))
      .for("update");
    if (!lockedOrder || !["DRAFT", "LOADING"].includes(lockedOrder.status)) {
      throw new Error("Cannot delete a bale while its loading is verified, finalized or changing status.");
    }
  }

  if (rows.length) {
    await tx.delete(customerOrderBales).where(
      inArray(
        customerOrderBales.id,
        rows.map((row) => row.id)
      )
    );
    for (const orderId of affected) await recalculateOrderTotals(tx, orderId);
  }
  await tx.execute(sql`
    UPDATE factory_priority_auto_allocations SET reversed_at = now(),
      reversed_by = ${actor}, reversed_by_user_id = ${args.actorId ?? null},
      reversal_reason = ${reason}
    WHERE company_id = ${companyId} AND bale_id = ${baleId} AND reversed_at IS NULL
  `);
  await tx.execute(sql`
    UPDATE factory_priority_scan_history
       SET reversed_at = now(), reversed_by = ${actor},
           reversed_by_user_id = ${args.actorId ?? null},
           reversal_reason = ${reason}
    WHERE company_id = ${companyId} AND bale_id = ${baleId} AND reversed_at IS NULL
  `);

  // Bulk removal callers defer recovery until ALL selected links are detached.
  // This guarantees input iteration order cannot decide which old loading
  // gets priority #1 when several auto-completed loadings reopen together.
  if (!args.deferQueueRecovery && affected.length > 0) {
    await reactivateAutoCompletedPriorityLoadingsLockedTx(tx, companyId, affected);
  }
  return affected;
}

export async function runAutomaticPriorityReprint(
  companyId: number,
  baleId: number,
  username: string | null,
  userId: string | null
): Promise<AutomaticPriorityAllocation | null> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${PRIORITY_SCAN_LOCK_NAMESPACE}, ${companyId})`);
    return allocateAutomaticPriorityBaleTx(tx, { companyId, baleId, username, userId, source: "reprint" });
  });
}

/** Prepare an entire print batch under ONE company lock and transaction.
 *  Invalid/deleted/foreign bales fail the batch instead of silently printing
 *  unallocated labels. Original assignments are returned when mode is OFF.
 *  The caller must not print if this operation fails.
 */
export interface AutomaticPriorityPrintCandidate {
  baleId?: number;
  referenceNumber?: string;
}
export interface AutomaticPriorityPrintResult {
  baleId: number;
  referenceNumber: string;
  priorityAllocation: AutomaticPriorityAllocation | null;
}
export async function runAutomaticPriorityPrintBatch(
  companyId: number,
  items: AutomaticPriorityPrintCandidate[],
  username: string | null,
  userId: string | null
): Promise<AutomaticPriorityPrintResult[]> {
  // Public client preflight is capped at 200 by its route, while legacy
  // /api/bale-label-prints can legitimately contain larger printing batches.
  if (!Array.isArray(items) || items.length === 0 || items.length > 5000) {
    throw new Error("Print batch must contain 1 to 5000 physical bales");
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${PRIORITY_SCAN_LOCK_NAMESPACE}, ${companyId})`);
    return prepareAutomaticPriorityPrintBatchTx(tx, companyId, items, username, userId);
  });
}

/** Same as runAutomaticPriorityPrintBatch, inside the caller's transaction.
 *  The caller must already hold PRIORITY_SCAN_LOCK_NAMESPACE/companyId. */
export async function prepareAutomaticPriorityPrintBatchTx(
  tx: PriorityScanTransaction,
  companyId: number,
  items: AutomaticPriorityPrintCandidate[],
  username: string | null,
  userId: string | null
): Promise<AutomaticPriorityPrintResult[]> {
  const seen = new Set<number>();
  const out: AutomaticPriorityPrintResult[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") throw new Error("Invalid print batch item");
    const baleId = item.baleId;
    if (item.referenceNumber !== undefined && typeof item.referenceNumber !== "string") {
      throw new Error("Invalid bale reference");
    }
    const ref = item.referenceNumber?.trim();
    if (baleId === undefined && !ref) throw new Error("Each print requires a physical bale ID or exact reference");
    if (baleId !== undefined && (!Number.isSafeInteger(baleId) || baleId < 1)) {
      throw new Error("Invalid physical bale ID");
    }
    if (ref && ref.length > 100) throw new Error("Invalid bale reference");
    const [bale] = await tx
      .select({
        id: factoryBales.id,
        referenceNumber: factoryBales.referenceNumber,
      })
      .from(factoryBales)
      .where(
        and(
          eq(factoryBales.companyId, companyId),
          isNull(factoryBales.deletedAt),
          ...(baleId !== undefined
            ? [eq(factoryBales.id, baleId)]
            : [sql`LOWER(${factoryBales.referenceNumber}) = ${ref!.toLowerCase()}`])
        )
      )
      .limit(1);
    if (!bale) throw new Error("Bale not found or already deleted in this company");
    if (baleId !== undefined && ref && bale.referenceNumber.toLowerCase() !== ref.toLowerCase()) {
      throw new Error("Print reference does not match bale ID");
    }
    if (!seen.has(bale.id)) {
      seen.add(bale.id);
      const priorityAllocation = await allocateAutomaticPriorityBaleTx(tx, {
        companyId,
        baleId: bale.id,
        username,
        userId,
        source: "reprint",
      });
      out.push({ baleId: bale.id, referenceNumber: bale.referenceNumber, priorityAllocation });
    }
  }
  return out;
}
