// Extracted from ./smartTransferBusinessRules.ts to keep that module under the source-size cap.
import { and, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { db } from "../db";
import { salesItems, stockCategories, stockGroups, vouchers } from "@shared/schema";
import type { SmartTransferSourceTotal } from "./smartTransferAllocation";
import {
  buildSmartTransferSourceOptimizedPreview,
  type SmartTransferSourceOptimizedLine,
} from "./smartTransferSourceOptimization";
import { roundNumber } from "./smartTransferPerformance";
import {
  UNASSIGNED_KEY,
  allocateSourcesWithMinimumSplits,
  allocateWithSharedCaps,
  automaticMinimumItemQty,
  buildMixTargets,
  clamp,
  isoDaysAgo,
  normalizeShare,
  parseQuantity,
  removeTinyItems,
  totalByBucket,
  uniquePositiveIds,
  wholeNonNegative,
  type BusinessItem,
  type SmartTransferBusinessRuleLine,
  type SmartTransferBusinessRuleOptions,
  type SmartTransferBusinessRuleResult,
  type SmartTransferMixSummaryRow,
  type SourceOption,
} from "./smartTransferBusinessRulesAllocateWithSharedCaps";
import { mixReason } from "./smartTransferBusinessRulesMixReason";

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
