import { and, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { db } from "../db";
import { salesItems, stockCategories, stockGroups, vouchers } from "@shared/schema";
import type { SmartTransferPreviewOptions, SmartTransferSourceTotal } from "./smartTransferAllocation";
import {
  buildSmartTransferSourceOptimizedPreview,
  type SmartTransferSourceOptimizedLine,
  type SmartTransferSourceOptimizedResult,
} from "./smartTransferSourceOptimization";
import { roundNumber } from "./smartTransferPerformance";
import { parseMoneyInput } from "../lib/money";

export interface SmartTransferBusinessRuleOptions extends SmartTransferPreviewOptions {
  maxItemSharePct?: number;
  maxCategorySharePct?: number;
  maxStockGroupSharePct?: number;
  minItemQuantity?: number;
  preserveDestinationMix?: boolean;
  priorityCategoryIds?: number[];
  priorityStockGroupIds?: number[];
}

export interface SmartTransferBusinessRuleFields {
  categoryName: string;
  stockGroupName: string;
  businessPriorityScore: number;
  itemBusinessCapQty: number;
  categoryTargetSharePct: number;
  stockGroupTargetSharePct: number;
  finalCategorySharePct: number;
  finalStockGroupSharePct: number;
  mixAdjustmentReason: string;
}

export type SmartTransferBusinessRuleLine = SmartTransferSourceOptimizedLine & SmartTransferBusinessRuleFields;

export interface SmartTransferMixSummaryRow {
  id: number | null;
  name: string;
  targetSharePct: number;
  finalSharePct: number;
  quantity: number;
  historicalSalesQty: number;
  capped: boolean;
  priority: boolean;
}

export interface SmartTransferBusinessRuleResult extends Omit<SmartTransferSourceOptimizedResult, "lines"> {
  businessRulesVersion: 3;
  lines: SmartTransferBusinessRuleLine[];
  businessRules: {
    maxItemSharePct: number;
    maxCategorySharePct: number;
    maxStockGroupSharePct: number;
    minItemQuantity: number;
    preserveDestinationMix: boolean;
    priorityCategoryIds: number[];
    priorityStockGroupIds: number[];
  };
  businessRulesApplied: string[];
  categoryMix: SmartTransferMixSummaryRow[];
  stockGroupMix: SmartTransferMixSummaryRow[];
}

interface SourceOption {
  line: SmartTransferSourceOptimizedLine;
  capacity: number;
}

interface BusinessItem {
  stockItemId: number;
  representative: SmartTransferSourceOptimizedLine;
  sources: SourceOption[];
  capacity: number;
  itemCap: number;
  categoryKey: number;
  stockGroupKey: number;
  historicalSalesQty: number;
  weight: number;
  businessPriorityScore: number;
}

interface MixTargets {
  shareByKey: Map<number, number>;
  historicalQtyByKey: Map<number, number>;
}

const UNASSIGNED_KEY = 0;

function parseQuantity(value: unknown): number {
  const parsed = parseMoneyInput(String(value ?? "0"))?.toNumber() ?? NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function wholeNonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function uniquePositiveIds(values: number[] | undefined): number[] {
  return Array.from(new Set((values ?? []).map(Number).filter((value) => Number.isInteger(value) && value > 0)));
}

function isoDaysAgo(asOfDate: string, daysAgo: number): string {
  const date = new Date(`${asOfDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - Math.max(0, daysAgo));
  return date.toISOString().slice(0, 10);
}

function automaticMinimumItemQty(target: number): number {
  if (target >= 500) return 8;
  if (target >= 200) return 5;
  if (target >= 50) return 2;
  return 1;
}

function normalizeShare(value: number | undefined, fallback: number, min: number): number {
  if (!Number.isFinite(value)) return fallback;
  return clamp(Math.floor(Number(value)), min, 100);
}

function buildMixTargets(
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

function totalByBucket(
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

function allocateWithSharedCaps(input: {
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

function removeTinyItems(
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

function allocateSourcesWithMinimumSplits(sources: SourceOption[], requested: number): Map<number, number> {
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

function mixReason(input: {
  item: BusinessItem;
  itemQty: number;
  categoryName: string;
  stockGroupName: string;
  categoryTargetShare: number;
  groupTargetShare: number;
  priorityCategory: boolean;
  priorityGroup: boolean;
  minItemQuantity: number;
}): string {
  const parts = [
    `Phase 3 priority ${input.item.businessPriorityScore}/100`,
    `item cap ${input.item.itemCap}`,
    `${input.categoryName} target mix ${roundNumber(input.categoryTargetShare * 100, 1)}%`,
    `${input.stockGroupName} target mix ${roundNumber(input.groupTargetShare * 100, 1)}%`,
    `final item quantity ${input.itemQty}`,
    `minimum meaningful item quantity ${input.minItemQuantity}`,
  ];
  if (input.priorityCategory) parts.push("priority category boost applied");
  if (input.priorityGroup) parts.push("priority stock-group boost applied");
  return parts.join("; ") + ".";
}

export async function buildSmartTransferBusinessRulePreview(
  companyId: number,
  sourceLocationIds: number[],
  destinationLocationId: number,
  targetQuantity: number,
  options: SmartTransferBusinessRuleOptions = {}
): Promise<SmartTransferBusinessRuleResult> {
  const base = await buildSmartTransferSourceOptimizedPreview(
    companyId,
    sourceLocationIds,
    destinationLocationId,
    targetQuantity,
    options
  );

  const requestedTarget = wholeNonNegative(base.targetQuantity);
  const maxItemSharePct = normalizeShare(options.maxItemSharePct, 30, 5);
  const maxCategorySharePct = normalizeShare(options.maxCategorySharePct, 65, 10);
  const maxStockGroupSharePct = normalizeShare(options.maxStockGroupSharePct, 55, 10);
  const preserveDestinationMix = options.preserveDestinationMix !== false;
  const priorityCategoryIds = uniquePositiveIds(options.priorityCategoryIds);
  const priorityStockGroupIds = uniquePositiveIds(options.priorityStockGroupIds);
  const minItemQuantity =
    options.minItemQuantity && options.minItemQuantity > 0
      ? wholeNonNegative(options.minItemQuantity)
      : automaticMinimumItemQty(requestedTarget);

  const normalizedRules = {
    maxItemSharePct,
    maxCategorySharePct,
    maxStockGroupSharePct,
    minItemQuantity,
    preserveDestinationMix,
    priorityCategoryIds,
    priorityStockGroupIds,
  };

  if (base.lines.length === 0 || requestedTarget <= 0) {
    return {
      ...base,
      businessRulesVersion: 3,
      lines: [],
      businessRules: normalizedRules,
      businessRulesApplied: [],
      categoryMix: [],
      stockGroupMix: [],
      summary: `${base.summary} Phase 3 had no quantities to balance.`,
    };
  }

  const asOfDate = options.asOfDate ?? new Date().toISOString().slice(0, 10);
  const salesStart = isoDaysAgo(asOfDate, 179);
  const stockItemIds = Array.from(new Set(base.lines.map((line) => line.stockItemId)));
  const categoryIds = Array.from(
    new Set(
      base.lines.map((line) => line.categoryId).filter((id): id is number => Number.isInteger(id) && Number(id) > 0)
    )
  );
  const stockGroupIds = Array.from(
    new Set(
      base.lines.map((line) => line.stockGroupId).filter((id): id is number => Number.isInteger(id) && Number(id) > 0)
    )
  );

  const [salesRows, categoryRows, stockGroupRows] = await Promise.all([
    db
      .select({
        stockItemId: salesItems.stockItemId,
        quantity: salesItems.quantity,
      })
      .from(salesItems)
      .innerJoin(vouchers, eq(salesItems.voucherId, vouchers.id))
      .where(
        and(
          eq(vouchers.companyId, companyId),
          eq(vouchers.voucherType, "Sales"),
          eq(vouchers.optional, false),
          isNull(vouchers.deletedAt),
          eq(vouchers.locationId, destinationLocationId),
          inArray(salesItems.stockItemId, stockItemIds),
          gte(vouchers.voucherDate, salesStart),
          lte(vouchers.voucherDate, asOfDate)
        )
      ),
    categoryIds.length > 0
      ? db
          .select({ id: stockCategories.id, name: stockCategories.name })
          .from(stockCategories)
          .where(and(eq(stockCategories.companyId, companyId), inArray(stockCategories.id, categoryIds)))
      : Promise.resolve([]),
    stockGroupIds.length > 0
      ? db
          .select({ id: stockGroups.id, name: stockGroups.name })
          .from(stockGroups)
          .where(
            and(
              eq(stockGroups.companyId, companyId),
              isNull(stockGroups.deletedAt),
              inArray(stockGroups.id, stockGroupIds)
            )
          )
      : Promise.resolve([]),
  ]);

  const salesByItem = new Map<number, number>();
  for (const row of salesRows) {
    salesByItem.set(row.stockItemId, (salesByItem.get(row.stockItemId) ?? 0) + parseQuantity(row.quantity));
  }
  const categoryNameById = new Map(categoryRows.map((row) => [row.id, row.name]));
  const stockGroupNameById = new Map(stockGroupRows.map((row) => [row.id, row.name]));

  const linesByItem = new Map<number, SmartTransferSourceOptimizedLine[]>();
  for (const line of base.lines) {
    const list = linesByItem.get(line.stockItemId) ?? [];
    list.push(line);
    linesByItem.set(line.stockItemId, list);
  }

  const rawItems: Array<{
    stockItemId: number;
    representative: SmartTransferSourceOptimizedLine;
    sources: SourceOption[];
    capacity: number;
    categoryKey: number;
    stockGroupKey: number;
    historicalSalesQty: number;
  }> = [];

  for (const [stockItemId, itemLines] of linesByItem.entries()) {
    const representative = itemLines[0];
    const sourceById = new Map<number, SourceOption>();
    for (const line of itemLines) {
      const existing = sourceById.get(line.sourceLocationId);
      const capacity = wholeNonNegative(line.availableAtSource);
      if (!existing || capacity > existing.capacity) sourceById.set(line.sourceLocationId, { line, capacity });
    }
    const sources = Array.from(sourceById.values());
    const totalSourceCapacity = sources.reduce((sum, source) => sum + source.capacity, 0);
    const capacity = Math.min(totalSourceCapacity, wholeNonNegative(representative.calculatedNeed));
    if (capacity <= 0) continue;

    rawItems.push({
      stockItemId,
      representative,
      sources,
      capacity,
      categoryKey: representative.categoryId ?? UNASSIGNED_KEY,
      stockGroupKey: representative.stockGroupId ?? UNASSIGNED_KEY,
      historicalSalesQty: salesByItem.get(stockItemId) ?? 0,
    });
  }

  const categoryTargets = buildMixTargets(
    rawItems.map((item) => ({
      key: item.categoryKey,
      historicalSalesQty: item.historicalSalesQty,
      fallbackWeight: Math.max(1, item.representative.forecastDailyRate * 30),
    })),
    preserveDestinationMix
  );
  const stockGroupTargets = buildMixTargets(
    rawItems.map((item) => ({
      key: item.stockGroupKey,
      historicalSalesQty: item.historicalSalesQty,
      fallbackWeight: Math.max(1, item.representative.forecastDailyRate * 30),
    })),
    preserveDestinationMix
  );

  const uniqueCategoryKeys = new Set(rawItems.map((item) => item.categoryKey));
  const uniqueGroupKeys = new Set(rawItems.map((item) => item.stockGroupKey));
  const itemShareCap = rawItems.length <= 1 ? requestedTarget : Math.ceil((requestedTarget * maxItemSharePct) / 100);
  const categoryShareCap =
    uniqueCategoryKeys.size <= 1 ? requestedTarget : Math.ceil((requestedTarget * maxCategorySharePct) / 100);
  const stockGroupShareCap =
    uniqueGroupKeys.size <= 1 ? requestedTarget : Math.ceil((requestedTarget * maxStockGroupSharePct) / 100);

  const priorityCategorySet = new Set(priorityCategoryIds);
  const priorityStockGroupSet = new Set(priorityStockGroupIds);
  const items: BusinessItem[] = rawItems.map((item) => {
    const categoryTargetShare = categoryTargets.shareByKey.get(item.categoryKey) ?? 0;
    const groupTargetShare = stockGroupTargets.shareByKey.get(item.stockGroupKey) ?? 0;
    const priorityBoost =
      (priorityCategorySet.has(item.categoryKey) ? 12 : 0) + (priorityStockGroupSet.has(item.stockGroupKey) ? 12 : 0);
    const businessPriorityScore = Math.round(
      clamp(item.representative.itemScore + categoryTargetShare * 12 + groupTargetShare * 10 + priorityBoost, 0, 100)
    );
    const mixMultiplier = preserveDestinationMix ? 0.75 + categoryTargetShare + groupTargetShare : 1;
    const weight =
      Math.max(1, businessPriorityScore) * Math.max(1, item.representative.forecastDailyRate * 10) * mixMultiplier;

    return {
      ...item,
      itemCap: Math.min(item.capacity, Math.max(1, itemShareCap)),
      weight,
      businessPriorityScore,
    };
  });

  const itemsById = new Map(items.map((item) => [item.stockItemId, item]));
  const categoryCaps = new Map<number, number>();
  const stockGroupCaps = new Map<number, number>();
  const categoryTargetQty = new Map<number, number>();
  const stockGroupTargetQty = new Map<number, number>();
  for (const key of uniqueCategoryKeys) {
    categoryCaps.set(key, categoryShareCap);
    categoryTargetQty.set(key, Math.round(requestedTarget * (categoryTargets.shareByKey.get(key) ?? 0)));
  }
  for (const key of uniqueGroupKeys) {
    stockGroupCaps.set(key, stockGroupShareCap);
    stockGroupTargetQty.set(key, Math.round(requestedTarget * (stockGroupTargets.shareByKey.get(key) ?? 0)));
  }

  let allocations = allocateWithSharedCaps({
    items,
    requested: requestedTarget,
    categoryCaps,
    stockGroupCaps,
    categoryTargets: categoryTargetQty,
    stockGroupTargets: stockGroupTargetQty,
  });

  const strictTotal = Array.from(allocations.values()).reduce((sum, quantity) => sum + quantity, 0);
  let relaxedBucketCaps = false;
  let relaxedItemCaps = false;

  if (strictTotal < requestedTarget) {
    relaxedBucketCaps = true;
    allocations = allocateWithSharedCaps({
      items,
      requested: requestedTarget,
      allocations,
      categoryCaps,
      stockGroupCaps,
      categoryTargets: categoryTargetQty,
      stockGroupTargets: stockGroupTargetQty,
      relaxBucketCaps: true,
    });
  }

  const totalAfterBucketRelax = Array.from(allocations.values()).reduce((sum, quantity) => sum + quantity, 0);
  if (totalAfterBucketRelax < requestedTarget) {
    relaxedItemCaps = true;
    allocations = allocateWithSharedCaps({
      items,
      requested: requestedTarget,
      allocations,
      categoryCaps,
      stockGroupCaps,
      categoryTargets: categoryTargetQty,
      stockGroupTargets: stockGroupTargetQty,
      relaxBucketCaps: true,
      relaxItemCaps: true,
    });
  }

  const tinyResult = removeTinyItems(allocations, itemsById, minItemQuantity);
  allocations = tinyResult.allocations;
  if (tinyResult.removedQty > 0) {
    allocations = allocateWithSharedCaps({
      items: items.filter(
        (item) =>
          (allocations.get(item.stockItemId) ?? 0) >= minItemQuantity ||
          item.representative.urgencyBand === "critical" ||
          item.representative.urgencyBand === "high"
      ),
      requested: requestedTarget,
      allocations,
      categoryCaps,
      stockGroupCaps,
      categoryTargets: categoryTargetQty,
      stockGroupTargets: stockGroupTargetQty,
      relaxBucketCaps: relaxedBucketCaps,
      relaxItemCaps: relaxedItemCaps,
    });
  }

  const finalCategoryTotals = totalByBucket(allocations, itemsById, "category");
  const finalGroupTotals = totalByBucket(allocations, itemsById, "stockGroup");
  const finalAllocatedTarget = Array.from(allocations.values()).reduce((sum, quantity) => sum + quantity, 0);
  const lines: SmartTransferBusinessRuleLine[] = [];
  let sourceSplitsAvoided = 0;

  for (const item of items) {
    const itemQty = allocations.get(item.stockItemId) ?? 0;
    if (itemQty <= 0) continue;
    const sourceAllocations = allocateSourcesWithMinimumSplits(item.sources, itemQty);
    const previousSourceCount = linesByItem.get(item.stockItemId)?.length ?? 0;
    if (previousSourceCount > sourceAllocations.size)
      sourceSplitsAvoided += previousSourceCount - sourceAllocations.size;

    const categoryName =
      item.categoryKey === UNASSIGNED_KEY
        ? "Unassigned category"
        : (categoryNameById.get(item.categoryKey) ?? `Category #${item.categoryKey}`);
    const stockGroupName =
      item.stockGroupKey === UNASSIGNED_KEY
        ? "Unassigned stock group"
        : (stockGroupNameById.get(item.stockGroupKey) ?? `Stock group #${item.stockGroupKey}`);
    const categoryTargetShare = categoryTargets.shareByKey.get(item.categoryKey) ?? 0;
    const groupTargetShare = stockGroupTargets.shareByKey.get(item.stockGroupKey) ?? 0;
    const categoryFinalShare =
      finalAllocatedTarget > 0 ? (finalCategoryTotals.get(item.categoryKey) ?? 0) / finalAllocatedTarget : 0;
    const groupFinalShare =
      finalAllocatedTarget > 0 ? (finalGroupTotals.get(item.stockGroupKey) ?? 0) / finalAllocatedTarget : 0;
    const adjustmentReason = mixReason({
      item,
      itemQty,
      categoryName,
      stockGroupName,
      categoryTargetShare,
      groupTargetShare,
      priorityCategory: priorityCategorySet.has(item.categoryKey),
      priorityGroup: priorityStockGroupSet.has(item.stockGroupKey),
      minItemQuantity,
    });

    for (const source of item.sources) {
      const suggestedQuantity = sourceAllocations.get(source.line.sourceLocationId) ?? 0;
      if (suggestedQuantity <= 0) continue;
      lines.push({
        ...source.line,
        suggestedQuantity,
        itemSuggestedTotal: itemQty,
        reason: `${source.line.reason} Phase 3 mix rule: ${adjustmentReason}`,
        categoryName,
        stockGroupName,
        businessPriorityScore: item.businessPriorityScore,
        itemBusinessCapQty: item.itemCap,
        categoryTargetSharePct: roundNumber(categoryTargetShare * 100, 2),
        stockGroupTargetSharePct: roundNumber(groupTargetShare * 100, 2),
        finalCategorySharePct: roundNumber(categoryFinalShare * 100, 2),
        finalStockGroupSharePct: roundNumber(groupFinalShare * 100, 2),
        mixAdjustmentReason: adjustmentReason,
      });
    }
  }

  lines.sort(
    (a, b) =>
      b.businessPriorityScore - a.businessPriorityScore ||
      b.itemScore - a.itemScore ||
      b.sourceSelectionScore - a.sourceSelectionScore ||
      a.stockItemName.localeCompare(b.stockItemName)
  );

  const achievedQuantity = lines.reduce((sum, line) => sum + line.suggestedQuantity, 0);
  const shortfallQuantity = Math.max(0, requestedTarget - achievedQuantity);
  const totalsMap = new Map<number, SmartTransferSourceTotal>();
  for (const line of lines) {
    const current = totalsMap.get(line.sourceLocationId) ?? {
      sourceLocationId: line.sourceLocationId,
      sourceLocationName: line.sourceLocationName,
      suggestedQuantity: 0,
      lineCount: 0,
    };
    current.suggestedQuantity += line.suggestedQuantity;
    current.lineCount += 1;
    totalsMap.set(line.sourceLocationId, current);
  }
  const totalsBySource = Array.from(totalsMap.values()).sort(
    (a, b) => b.suggestedQuantity - a.suggestedQuantity || a.sourceLocationName.localeCompare(b.sourceLocationName)
  );

  const categoryMix: SmartTransferMixSummaryRow[] = Array.from(uniqueCategoryKeys)
    .map((key) => {
      const quantity = finalCategoryTotals.get(key) ?? 0;
      const targetShare = categoryTargets.shareByKey.get(key) ?? 0;
      return {
        id: key === UNASSIGNED_KEY ? null : key,
        name: key === UNASSIGNED_KEY ? "Unassigned category" : (categoryNameById.get(key) ?? `Category #${key}`),
        targetSharePct: roundNumber(targetShare * 100, 2),
        finalSharePct: roundNumber((quantity / Math.max(1, achievedQuantity)) * 100, 2),
        quantity,
        historicalSalesQty: roundNumber(categoryTargets.historicalQtyByKey.get(key) ?? 0, 3),
        capped: !relaxedBucketCaps && quantity >= (categoryCaps.get(key) ?? requestedTarget),
        priority: priorityCategorySet.has(key),
      };
    })
    .sort((a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name));

  const stockGroupMix: SmartTransferMixSummaryRow[] = Array.from(uniqueGroupKeys)
    .map((key) => {
      const quantity = finalGroupTotals.get(key) ?? 0;
      const targetShare = stockGroupTargets.shareByKey.get(key) ?? 0;
      return {
        id: key === UNASSIGNED_KEY ? null : key,
        name:
          key === UNASSIGNED_KEY ? "Unassigned stock group" : (stockGroupNameById.get(key) ?? `Stock group #${key}`),
        targetSharePct: roundNumber(targetShare * 100, 2),
        finalSharePct: roundNumber((quantity / Math.max(1, achievedQuantity)) * 100, 2),
        quantity,
        historicalSalesQty: roundNumber(stockGroupTargets.historicalQtyByKey.get(key) ?? 0, 3),
        capped: !relaxedBucketCaps && quantity >= (stockGroupCaps.get(key) ?? requestedTarget),
        priority: priorityStockGroupSet.has(key),
      };
    })
    .sort((a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name));

  const businessRulesApplied = [
    `Maximum ${maxItemSharePct}% per item`,
    `Maximum ${maxCategorySharePct}% per category while sufficient alternatives exist`,
    `Maximum ${maxStockGroupSharePct}% per stock group while sufficient alternatives exist`,
    `Minimum ${minItemQuantity} unit(s) for non-urgent suggested items`,
    preserveDestinationMix
      ? "Destination's 180-day proven sales mix used as the assortment target"
      : "Current forecast demand used as the assortment target",
  ];
  if (priorityCategoryIds.length > 0) businessRulesApplied.push("Priority-category boosts applied");
  if (priorityStockGroupIds.length > 0) businessRulesApplied.push("Priority stock-group boosts applied");

  const warnings = base.warnings.filter(
    (warning) => !/phase 2 is short by|removed .* unnecessary source split/i.test(warning)
  );
  if (relaxedBucketCaps) {
    warnings.push(
      "Phase 3 relaxed category/stock-group concentration caps because strict caps could not fill the requested target from the eligible assortment."
    );
  }
  if (relaxedItemCaps) {
    warnings.push(
      "Phase 3 relaxed the per-item concentration cap because the remaining eligible items could not fill the requested target."
    );
  }
  if (tinyResult.removedCount > 0) {
    warnings.push(
      `Phase 3 removed ${tinyResult.removedCount} non-urgent tiny item suggestion(s) below ${minItemQuantity} unit(s) and reallocated their quantity where possible.`
    );
  }
  if (sourceSplitsAvoided > 0) {
    warnings.push(
      `Phase 3 preserved minimum-split source allocation and avoided ${sourceSplitsAvoided} unnecessary source split(s) after mix balancing.`
    );
  }
  if (shortfallQuantity > 0) {
    warnings.push(
      `Phase 3 is short by ${shortfallQuantity} whole unit(s) because eligible item demand and protected source capacity were insufficient.`
    );
  }

  return {
    ...base,
    businessRulesVersion: 3,
    targetQuantity: requestedTarget,
    achievedQuantity,
    shortfallQuantity,
    shortfall: shortfallQuantity > 0,
    lines,
    totalsBySource,
    warnings,
    businessRules: normalizedRules,
    businessRulesApplied,
    categoryMix,
    stockGroupMix,
    summary: `Phase 3 balanced ${achievedQuantity} of ${requestedTarget} unit(s) across ${categoryMix.filter((row) => row.quantity > 0).length} category mix(es) and ${stockGroupMix.filter((row) => row.quantity > 0).length} stock-group mix(es), while preserving Phase 1 demand forecasting and Phase 2 source protection.`,
  };
}
