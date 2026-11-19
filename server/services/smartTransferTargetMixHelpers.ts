// Extracted from ./smartTransferTargetMix.ts
import { type SmartTransferBusinessRuleLine, type SmartTransferMixSummaryRow } from "./smartTransferBusinessRules";
import { roundNumber } from "./smartTransferPerformance";

export interface TargetItem {
  stockItemId: number;
  representative: SmartTransferBusinessRuleLine;
  sources: SmartTransferBusinessRuleLine[];
  capacity: number;
  itemCap: number;
  categoryKey: number;
  stockGroupKey: number;
  weight: number;
}

export const UNASSIGNED_KEY = 0;

export function wholeNonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function totalByBucket(
  allocations: Map<number, number>,
  itemsById: Map<number, TargetItem>,
  bucket: "category" | "stockGroup"
): Map<number, number> {
  const totals = new Map<number, number>();
  for (const [stockItemId, quantity] of allocations.entries()) {
    if (quantity <= 0) continue;
    const item = itemsById.get(stockItemId);
    if (!item) continue;
    const key = bucket === "category" ? item.categoryKey : item.stockGroupKey;
    totals.set(key, (totals.get(key) ?? 0) + quantity);
  }
  return totals;
}

export function allocateTarget(input: {
  items: TargetItem[];
  requested: number;
  allocations?: Map<number, number>;
  categoryCaps: Map<number, number>;
  stockGroupCaps: Map<number, number>;
  categoryTargets: Map<number, number>;
  stockGroupTargets: Map<number, number>;
  relaxBucketCaps?: boolean;
  relaxItemCaps?: boolean;
}): Map<number, number> {
  const allocations = new Map<number, number>(input.allocations ?? []);
  const itemsById = new Map(input.items.map((item) => [item.stockItemId, item]));
  let remaining = Math.max(
    0,
    wholeNonNegative(input.requested) - Array.from(allocations.values()).reduce((sum, quantity) => sum + quantity, 0)
  );
  let guard = 0;

  while (remaining > 0 && guard < 100) {
    guard += 1;
    const categoryTotals = totalByBucket(allocations, itemsById, "category");
    const groupTotals = totalByBucket(allocations, itemsById, "stockGroup");
    const eligible = input.items
      .map((item) => {
        const current = allocations.get(item.stockItemId) ?? 0;
        const itemLimit = input.relaxItemCaps ? item.capacity : item.itemCap;
        const itemRoom = Math.max(0, itemLimit - current);
        const categoryRoom = input.relaxBucketCaps
          ? remaining
          : Math.max(
              0,
              (input.categoryCaps.get(item.categoryKey) ?? input.requested) -
                (categoryTotals.get(item.categoryKey) ?? 0)
            );
        const groupRoom = input.relaxBucketCaps
          ? remaining
          : Math.max(
              0,
              (input.stockGroupCaps.get(item.stockGroupKey) ?? input.requested) -
                (groupTotals.get(item.stockGroupKey) ?? 0)
            );
        const room = Math.min(itemRoom, categoryRoom, groupRoom, remaining);
        if (room <= 0) return null;

        const categoryGap = Math.max(
          0,
          (input.categoryTargets.get(item.categoryKey) ?? 0) - (categoryTotals.get(item.categoryKey) ?? 0)
        );
        const groupGap = Math.max(
          0,
          (input.stockGroupTargets.get(item.stockGroupKey) ?? 0) - (groupTotals.get(item.stockGroupKey) ?? 0)
        );
        const weight =
          item.weight * (1 + categoryGap / Math.max(1, input.requested) + groupGap / Math.max(1, input.requested));
        return { item, room, weight };
      })
      .filter((value): value is { item: TargetItem; room: number; weight: number } => value !== null)
      .sort(
        (a, b) =>
          b.weight - a.weight ||
          b.item.representative.businessPriorityScore - a.item.representative.businessPriorityScore ||
          a.item.representative.stockItemName.localeCompare(b.item.representative.stockItemName)
      );

    if (eligible.length === 0) break;
    const totalWeight = eligible.reduce((sum, entry) => sum + Math.max(1, entry.weight), 0);
    const remainingAtStart = remaining;
    let progress = 0;

    for (const entry of eligible) {
      if (remaining <= 0) break;
      const proportional = Math.max(
        1,
        Math.floor((remainingAtStart * Math.max(1, entry.weight)) / Math.max(1, totalWeight))
      );
      const add = Math.min(entry.room, proportional, remaining);
      if (add <= 0) continue;
      allocations.set(entry.item.stockItemId, (allocations.get(entry.item.stockItemId) ?? 0) + add);
      remaining -= add;
      progress += add;
    }

    if (progress <= 0) break;
  }

  return allocations;
}

export function rebuildMix(
  original: SmartTransferMixSummaryRow[],
  totals: Map<number, number>,
  achieved: number
): SmartTransferMixSummaryRow[] {
  return original
    .map((row) => {
      const key = row.id ?? UNASSIGNED_KEY;
      const quantity = totals.get(key) ?? 0;
      return {
        ...row,
        quantity,
        finalSharePct: roundNumber((quantity / Math.max(1, achieved)) * 100, 2),
      };
    })
    .sort((a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name));
}
