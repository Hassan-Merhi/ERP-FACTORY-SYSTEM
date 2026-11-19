// Extracted from ./priorityScanQueue.ts
import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import { db } from "../../../db";
import { customerOrderPriorityScanConfigs, customerOrders } from "@shared/schema";
import { getProformaCapacitySnapshot } from "./proformaCapacity";
import { acquireProformaCapacityTransactionLock } from "./proformaCapacityConcurrency";
import { evaluateProformaArticleCapacity } from "./proformaCapacityEnforcement";

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

export function canonicalPriorityColorKey(value: string): string {
  const key = value.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(key)) {
    const [, r, g, b] = key;
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return RECOVERY_COLOR_ALIASES[key] ?? key;
}

export function recoveryColor(original: string, used: Set<string>, configId: number): string {
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
