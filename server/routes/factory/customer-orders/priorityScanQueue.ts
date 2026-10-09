import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";

import { db } from "../../../db";
import { customerOrderPriorityScanConfigs, customerOrders } from "@shared/schema";
import { getProformaCapacitySnapshot } from "./proformaCapacity";
import { acquireProformaCapacityTransactionLock } from "./proformaCapacityConcurrency";
import { evaluateProformaArticleCapacity } from "./proformaCapacityEnforcement";

export const PRIORITY_SCAN_LOCK_NAMESPACE = 73202;

export type PriorityScanTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface PriorityScanAdvanceResult {
  completedOrderIds: number[];
  activeOrderId: number | null;
  activePriority: number | null;
}

export async function loadActivePriorityRows(tx: PriorityScanTransaction, companyId: number) {
  return tx
    .select({
      id: customerOrderPriorityScanConfigs.id,
      orderId: customerOrderPriorityScanConfigs.orderId,
      color: customerOrderPriorityScanConfigs.color,
      colorKey: customerOrderPriorityScanConfigs.colorKey,
      priority: customerOrderPriorityScanConfigs.priority,
      proformaIdUsed: customerOrders.proformaIdUsed,
    })
    .from(customerOrderPriorityScanConfigs)
    .innerJoin(customerOrders, eq(customerOrders.id, customerOrderPriorityScanConfigs.orderId))
    .where(
      and(
        eq(customerOrderPriorityScanConfigs.companyId, companyId),
        eq(customerOrderPriorityScanConfigs.enabled, true),
        eq(customerOrders.companyId, companyId),
        eq(customerOrders.status, "LOADING"),
        isNull(customerOrders.deletedAt),
        isNotNull(customerOrders.proformaIdUsed)
      )
    )
    .orderBy(asc(customerOrderPriorityScanConfigs.priority), asc(customerOrderPriorityScanConfigs.orderId));
}

export async function rewriteActivePriorityQueue(
  tx: PriorityScanTransaction,
  companyId: number,
  orderedIds: number[],
  actorId: string | null,
  actorName: string
): Promise<void> {
  await tx
    .update(customerOrderPriorityScanConfigs)
    .set({ enabled: false })
    .where(
      and(eq(customerOrderPriorityScanConfigs.companyId, companyId), eq(customerOrderPriorityScanConfigs.enabled, true))
    );

  for (let index = 0; index < orderedIds.length; index += 1) {
    await tx
      .update(customerOrderPriorityScanConfigs)
      .set({
        priority: index + 1,
        enabled: true,
        updatedBy: actorId,
        updatedByName: actorName,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(customerOrderPriorityScanConfigs.companyId, companyId),
          eq(customerOrderPriorityScanConfigs.id, orderedIds[index])
        )
      );
  }
}

export interface PriorityScanArticleTarget {
  orderId: number;
  priority: number;
  color: string;
  proformaId: number;
  remainingQty: number;
}

/**
 * Resolve the authoritative Priority Scan target while the caller holds the
 * company Priority Scan advisory lock. Proforma capacity locks are acquired in
 * queue order, so concurrent Priority Scan writers cannot cross or reorder one
 * another and config edits use the same priority->proforma lock order.
 */
export async function resolvePriorityScanArticleTarget(
  tx: PriorityScanTransaction,
  companyId: number,
  articleCode: string
): Promise<PriorityScanArticleTarget | null> {
  const activeRows = await loadActivePriorityRows(tx, companyId);

  for (const row of activeRows) {
    if (!row.proformaIdUsed) continue;

    await acquireProformaCapacityTransactionLock(tx, {
      companyId,
      proformaId: row.proformaIdUsed,
    });

    const snapshot = await getProformaCapacitySnapshot(tx, {
      companyId,
      proformaId: row.proformaIdUsed,
      currentOrderId: row.orderId,
    });
    if (!snapshot) continue;

    const decision = evaluateProformaArticleCapacity(snapshot, articleCode, 1, "per_loading");
    if (!decision.allowed) continue;

    return {
      orderId: row.orderId,
      priority: row.priority,
      color: row.color,
      proformaId: row.proformaIdUsed,
      remainingQty: decision.remainingQty,
    };
  }

  return null;
}

/**
 * Remove fully satisfied loadings from the active Priority Scan queue and
 * compact the remaining priorities. A loading is complete only when its linked
 * proforma has at least one requested bale and this loading itself has consumed
 * every requested quantity.
 */
/**
 * Called by automatic Stock Entry and reprint allocations while the caller holds
 * the company-scoped queue lock. Runs in the same transaction as bale assignment.
 */
export async function advanceSatisfiedPriorityScanConfigsLockedTx(
  tx: PriorityScanTransaction,
  companyId: number,
  triggerOrderId?: number
): Promise<PriorityScanAdvanceResult> {
    const activeRows = await loadActivePriorityRows(tx, companyId);
    if (activeRows.length === 0) {
      return { completedOrderIds: [], activeOrderId: null, activePriority: null };
    }
    if (triggerOrderId != null && !activeRows.some((row) => row.orderId === triggerOrderId)) {
      return {
        completedOrderIds: [],
        activeOrderId: activeRows[0]?.orderId ?? null,
        activePriority: activeRows.length > 0 ? 1 : null,
      };
    }

    const completedIds = new Set<number>();
    const completedOrderIds: number[] = [];

    for (const row of activeRows) {
      if (!row.proformaIdUsed) continue;

      await acquireProformaCapacityTransactionLock(tx, {
        companyId,
        proformaId: row.proformaIdUsed,
      });
      const snapshot = await getProformaCapacitySnapshot(tx, {
        companyId,
        proformaId: row.proformaIdUsed,
        currentOrderId: row.orderId,
      });
      if (!snapshot) continue;

      const satisfied = snapshot.requestedTotalQty > 0 && snapshot.remainingTotalQty <= 0;
      if (!satisfied) continue;

      completedIds.add(row.id);
      completedOrderIds.push(row.orderId);

      await tx
        .update(customerOrderPriorityScanConfigs)
        .set({
          enabled: false,
          updatedBy: null,
          updatedByName: "system:auto-completed",
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(customerOrderPriorityScanConfigs.companyId, companyId),
            eq(customerOrderPriorityScanConfigs.id, row.id)
          )
        );
    }

    const remainingRows = activeRows.filter((row) => !completedIds.has(row.id));
    const remainingIds = remainingRows.map((row) => row.id);
    const queueHasGaps = remainingRows.some((row, index) => row.priority !== index + 1);
    if (completedIds.size > 0 || queueHasGaps) {
      await rewriteActivePriorityQueue(tx, companyId, remainingIds, null, "system:auto-advance");
    }

    const activeOrderId =
      remainingIds.length > 0 ? (activeRows.find((row) => row.id === remainingIds[0])?.orderId ?? null) : null;

    return {
      completedOrderIds,
      activeOrderId,
      activePriority: activeOrderId == null ? null : 1,
    };
}

/** Existing standalone path for manual Priority Scan and queue reads. */
export async function advanceSatisfiedPriorityScanConfigs(
  companyId: number,
  triggerOrderId?: number
): Promise<PriorityScanAdvanceResult> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${PRIORITY_SCAN_LOCK_NAMESPACE}, ${companyId})`);
    return advanceSatisfiedPriorityScanConfigsLockedTx(tx, companyId, triggerOrderId);
  });
}
