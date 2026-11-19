// Extracted from ./smartTransferBusinessRules.ts to keep that module under the source-size cap.
import { parseMoneyInput } from "../lib/money";
import type { SourceOption, BusinessItem, MixTargets } from "./smartTransferBusinessRulesAllocateWithSharedCapsTypes";
export type {
  SmartTransferBusinessRuleOptions,
  SmartTransferBusinessRuleFields,
  SmartTransferBusinessRuleLine,
  SmartTransferMixSummaryRow,
  SmartTransferBusinessRuleResult,
  SourceOption,
  BusinessItem,
} from "./smartTransferBusinessRulesAllocateWithSharedCapsTypes";

export const UNASSIGNED_KEY = 0;

export function parseQuantity(value: unknown): number {
  const parsed = parseMoneyInput(String(value ?? "0"))?.toNumber() ?? NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

export function wholeNonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function uniquePositiveIds(values: number[] | undefined): number[] {
  return Array.from(new Set((values ?? []).map(Number).filter((value) => Number.isInteger(value) && value > 0)));
}

export function isoDaysAgo(asOfDate: string, daysAgo: number): string {
  const date = new Date(`${asOfDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - Math.max(0, daysAgo));
  return date.toISOString().slice(0, 10);
}

export function automaticMinimumItemQty(target: number): number {
  if (target >= 500) return 8;
  if (target >= 200) return 5;
  if (target >= 50) return 2;
  return 1;
}

export function normalizeShare(value: number | undefined, fallback: number, min: number): number {
  if (!Number.isFinite(value)) return fallback;
  return clamp(Math.floor(Number(value)), min, 100);
}

export function buildMixTargets(
  items: Array<{
    key: number;
    historicalSalesQty: number;
    fallbackWeight: number;
  }>,
  preserveDestinationMix: boolean
): MixTargets {
  const historicalQtyByKey = new Map<number, number>();
  const weightByKey = new Map<number, number>();

  for (const item of items) {
    historicalQtyByKey.set(item.key, (historicalQtyByKey.get(item.key) ?? 0) + Math.max(0, item.historicalSalesQty));
    const provenWeight =
      preserveDestinationMix && item.historicalSalesQty > 0
        ? item.historicalSalesQty
        : Math.max(1, item.fallbackWeight);
    weightByKey.set(item.key, (weightByKey.get(item.key) ?? 0) + provenWeight);
  }

  const totalWeight = Array.from(weightByKey.values()).reduce((sum, value) => sum + value, 0);
  const shareByKey = new Map<number, number>();
  for (const [key, weight] of weightByKey.entries()) {
    shareByKey.set(key, totalWeight > 0 ? weight / totalWeight : 0);
  }

  return { shareByKey, historicalQtyByKey };
}

export function totalByBucket(
  allocations: Map<number, number>,
  itemsById: Map<number, BusinessItem>,
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

export function allocateWithSharedCaps(input: {
  items: BusinessItem[];
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
  let allocated = Array.from(allocations.values()).reduce((sum, quantity) => sum + quantity, 0);
  let remaining = Math.max(0, wholeNonNegative(input.requested) - allocated);
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

        const categoryTarget = input.categoryTargets.get(item.categoryKey) ?? 0;
        const groupTarget = input.stockGroupTargets.get(item.stockGroupKey) ?? 0;
        const categoryGap = Math.max(0, categoryTarget - (categoryTotals.get(item.categoryKey) ?? 0));
        const groupGap = Math.max(0, groupTarget - (groupTotals.get(item.stockGroupKey) ?? 0));
        const dynamicWeight =
          item.weight * (1 + categoryGap / Math.max(1, input.requested) + groupGap / Math.max(1, input.requested));

        return { item, room, dynamicWeight };
      })
      .filter((value): value is { item: BusinessItem; room: number; dynamicWeight: number } => value !== null)
      .sort(
        (a, b) =>
          b.dynamicWeight - a.dynamicWeight ||
          b.item.businessPriorityScore - a.item.businessPriorityScore ||
          a.item.representative.stockItemName.localeCompare(b.item.representative.stockItemName)
      );

    if (eligible.length === 0) break;
    const totalWeight = eligible.reduce((sum, value) => sum + Math.max(1, value.dynamicWeight), 0);
    const remainingAtStart = remaining;
    let progress = 0;

    for (const entry of eligible) {
      if (remaining <= 0) break;
      const proportional = Math.max(
        1,
        Math.floor((remainingAtStart * Math.max(1, entry.dynamicWeight)) / Math.max(1, totalWeight))
      );
      const add = Math.min(entry.room, proportional, remaining);
      if (add <= 0) continue;
      allocations.set(entry.item.stockItemId, (allocations.get(entry.item.stockItemId) ?? 0) + add);
      remaining -= add;
      progress += add;
    }

    if (progress <= 0) break;
    allocated += progress;
  }

  return allocations;
}

export function removeTinyItems(
  allocations: Map<number, number>,
  itemsById: Map<number, BusinessItem>,
  minimumQty: number
): { allocations: Map<number, number>; removedQty: number; removedCount: number } {
  const next = new Map(allocations);
  let removedQty = 0;
  let removedCount = 0;

  for (const [stockItemId, quantity] of allocations.entries()) {
    const item = itemsById.get(stockItemId);
    if (!item || quantity <= 0 || quantity >= minimumQty) continue;
    const urgent = item.representative.urgencyBand === "critical" || item.representative.urgencyBand === "high";
    if (urgent) continue;
    next.set(stockItemId, 0);
    removedQty += quantity;
    removedCount += 1;
  }

  return { allocations: next, removedQty, removedCount };
}

export function allocateSourcesWithMinimumSplits(sources: SourceOption[], requested: number): Map<number, number> {
  const result = new Map<number, number>();
  const target = wholeNonNegative(requested);
  if (target <= 0) return result;

  const ordered = sources
    .slice()
    .sort(
      (a, b) =>
        b.line.sourceSelectionScore - a.line.sourceSelectionScore ||
        Number(b.capacity >= target) - Number(a.capacity >= target) ||
        b.capacity - a.capacity ||
        a.line.sourceLocationName.localeCompare(b.line.sourceLocationName)
    );

  const singleSource = ordered.find((source) => source.capacity >= target);
  if (singleSource) {
    result.set(singleSource.line.sourceLocationId, target);
    return result;
  }

  let remaining = target;
  for (const source of ordered) {
    if (remaining <= 0) break;
    const quantity = Math.min(source.capacity, remaining);
    if (quantity <= 0) continue;
    result.set(source.line.sourceLocationId, quantity);
    remaining -= quantity;
  }

  return result;
}
