import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";

import { db } from "../../../db";
import { customerOrderPriorityScanConfigs, customerOrders } from "@shared/schema";
import { getProformaCapacitySnapshot } from "./proformaCapacity";
import { acquireProformaCapacityTransactionLock } from "./proformaCapacityConcurrency";
import { evaluateProformaArticleCapacity, getLoadingProformaProgress } from "./proformaCapacityEnforcement";

export const PRIORITY_SCAN_LOCK_NAMESPACE = 73202;
export const PRIORITY_AUTO_COMPLETED_MARKER = "system:auto-completed";
export const PRIORITY_REOPENED_MARKER = "system:reopened-after-deletion";

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

    const satisfied = getLoadingProformaProgress(snapshot).satisfied;
    if (!satisfied) continue;

    completedIds.add(row.id);
    completedOrderIds.push(row.orderId);

    await tx
      .update(customerOrderPriorityScanConfigs)
      .set({
        enabled: false,
        updatedBy: null,
        updatedByName: PRIORITY_AUTO_COMPLETED_MARKER,
        updatedAt: sql`now()`,
      })
      .where(
        and(eq(customerOrderPriorityScanConfigs.companyId, companyId), eq(customerOrderPriorityScanConfigs.id, row.id))
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

export interface PriorityReopenedLoading {
  orderId: number;
  priority: number;
  color: string;
  colorChanged: boolean;
}

// Use an existing factory-approved color when possible. A formerly completed
// loading's color may have been given to a later loading; two simultaneously
// active queue rows cannot share it. Old bale color snapshots NEVER change.
const RECOVERY_COLOR_PRESETS = [
  "#dc2626",
  "#2563eb",
  "#16a34a",
  "#f59e0b",
  "#7c3aed",
  "#0891b2",
  "#db2777",
  "#111827",
  "#eab308",
  "#64748b",
] as const;

const RECOVERY_COLOR_ALIASES: Record<string, string> = {
  red: "#dc2626",
  blue: "#2563eb",
  green: "#16a34a",
  orange: "#f97316",
  yellow: "#eab308",
  purple: "#7c3aed",
  pink: "#db2777",
  black: "#111827",
  white: "#ffffff",
  gray: "#6b7280",
  grey: "#6b7280",
  navy: "#000080",
  lime: "#00ff00",
  cyan: "#0891b2",
  gold: "#b8860b",
};

function canonicalPriorityColorKey(value: string): string {
  const key = value.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(key)) {
    const [, r, g, b] = key;
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return RECOVERY_COLOR_ALIASES[key] ?? key;
}

function recoveryColor(original: string, used: Set<string>, configId: number): string {
  if (!used.has(canonicalPriorityColorKey(original))) return original;
  const preset = RECOVERY_COLOR_PRESETS.find((color) => !used.has(canonicalPriorityColorKey(color)));
  if (preset) return preset;
  // In unusual queues where every standard color is already used, generate
  // a stable safe hex code instead of blocking an otherwise valid deletion.
  for (let offset = 0; offset < 0x1000000; offset++) {
    const value = (Math.imul(configId, 2654435761) + offset) & 0xffffff;
    const color = `#${value.toString(16).padStart(6, "0")}`;
    if (!used.has(color)) return color;
  }
  throw new Error("No unique Priority Scan colors remain");
}

/**
 * Reopen only orders auto-completed by the system, still editable (LOADING)
 * and again needing at least one bale according to THEIR own proforma usage.
 *
 * Caller holds the company Priority Scan lock. The queue is rewritten ONCE,
 * with all affected candidates ordered by their original configuration
 * creation sequence. Thus a batch deleting both Red and Blue does not make
 * the last processed bale arbitrarily become #1.
 *
 * Manual OFF, manually cleared, cancelled, verified or finalized configs
 * are never silently reactivated. No existing bale allocations are edited.
 */
export async function reactivateAutoCompletedPriorityLoadingsLockedTx(
  tx: PriorityScanTransaction,
  companyId: number,
  affectedOrderIds: number[]
): Promise<PriorityReopenedLoading[]> {
  const orderIds = [...new Set(affectedOrderIds.filter((id) => Number.isSafeInteger(id) && id > 0))];
  if (!orderIds.length) return [];

  const candidates = await tx
    .select({
      id: customerOrderPriorityScanConfigs.id,
      orderId: customerOrderPriorityScanConfigs.orderId,
      color: customerOrderPriorityScanConfigs.color,
      colorKey: customerOrderPriorityScanConfigs.colorKey,
      createdAt: customerOrderPriorityScanConfigs.createdAt,
      proformaId: customerOrders.proformaIdUsed,
    })
    .from(customerOrderPriorityScanConfigs)
    .innerJoin(customerOrders, eq(customerOrders.id, customerOrderPriorityScanConfigs.orderId))
    .where(
      and(
        eq(customerOrderPriorityScanConfigs.companyId, companyId),
        eq(customerOrders.companyId, companyId),
        inArray(customerOrderPriorityScanConfigs.orderId, orderIds),
        eq(customerOrderPriorityScanConfigs.enabled, false),
        eq(customerOrderPriorityScanConfigs.updatedByName, PRIORITY_AUTO_COMPLETED_MARKER),
        eq(customerOrders.status, "LOADING"),
        isNull(customerOrders.deletedAt),
        isNotNull(customerOrders.proformaIdUsed)
      )
    );
  if (!candidates.length) return [];

  // Maintain queue -> proforma -> order locking discipline.
  for (const proformaId of [
    ...new Set(candidates.map((row) => row.proformaId).filter((id): id is number => id != null)),
  ].sort((a, b) => a - b)) {
    await acquireProformaCapacityTransactionLock(tx, { companyId, proformaId });
  }
  const eligible: typeof candidates = [];
  for (const row of candidates) {
    if (!row.proformaId) continue;
    const [lockedOrder] = await tx
      .select({ status: customerOrders.status })
      .from(customerOrders)
      .where(
        and(
          eq(customerOrders.id, row.orderId),
          eq(customerOrders.companyId, companyId),
          isNull(customerOrders.deletedAt)
        )
      )
      .for("update");
    if (lockedOrder?.status !== "LOADING") continue;
    const snapshot = await getProformaCapacitySnapshot(tx, {
      companyId,
      proformaId: row.proformaId,
      currentOrderId: row.orderId,
    });
    if (snapshot) {
      const progress = getLoadingProformaProgress(snapshot);
      if (progress.requestedQty > 0 && progress.remainingQty > 0) eligible.push(row);
    }
  }
  if (!eligible.length) return [];
  eligible.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.orderId - b.orderId);

  const active = await loadActivePriorityRows(tx, companyId);
  const usedColors = new Set(active.map((row) => canonicalPriorityColorKey(row.color)));
  const reopened: PriorityReopenedLoading[] = [];
  for (const row of eligible) {
    const color = recoveryColor(row.color, usedColors, row.id);
    usedColors.add(canonicalPriorityColorKey(color));
    if (color !== row.color) {
      await tx
        .update(customerOrderPriorityScanConfigs)
        .set({
          color,
          colorKey: color.toLowerCase(),
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(customerOrderPriorityScanConfigs.companyId, companyId),
            eq(customerOrderPriorityScanConfigs.id, row.id),
            eq(customerOrderPriorityScanConfigs.enabled, false)
          )
        );
    }
    reopened.push({
      orderId: row.orderId,
      priority: reopened.length + 1,
      color,
      colorChanged: color !== row.color,
    });
  }
  const freshActive = await loadActivePriorityRows(tx, companyId);
  await rewriteActivePriorityQueue(
    tx,
    companyId,
    [...eligible.map((row) => row.id), ...freshActive.map((row) => row.id)],
    null,
    PRIORITY_REOPENED_MARKER
  );

  return reopened;
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
