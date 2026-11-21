import {
  buildSmartTransferBusinessRulePreview,
  type SmartTransferBusinessRuleLine,
  type SmartTransferBusinessRuleOptions,
  type SmartTransferBusinessRuleResult,
} from "./smartTransferBusinessRules";
import type { SmartTransferSourceTotal } from "./smartTransferAllocation";
import { roundNumber } from "./smartTransferPerformance";
import {
  UNASSIGNED_KEY,
  wholeNonNegative,
  totalByBucket,
  allocateTarget,
  rebuildMix,
  type TargetItem,
} from "./smartTransferTargetMixHelpers";

function allocateExistingSources(sources: SmartTransferBusinessRuleLine[], requested: number): Map<number, number> {
  const result = new Map<number, number>();
  const target = wholeNonNegative(requested);
  if (target <= 0) return result;

  const ordered = sources
    .slice()
    .sort(
      (a, b) =>
        b.sourceSelectionScore - a.sourceSelectionScore ||
        Number(b.suggestedQuantity >= target) - Number(a.suggestedQuantity >= target) ||
        b.suggestedQuantity - a.suggestedQuantity ||
        a.sourceLocationName.localeCompare(b.sourceLocationName)
    );
  const single = ordered.find((line) => line.suggestedQuantity >= target);
  if (single) {
    result.set(single.sourceLocationId, target);
    return result;
  }

  let remaining = target;
  for (const line of ordered) {
    if (remaining <= 0) break;
    const quantity = Math.min(wholeNonNegative(line.suggestedQuantity), remaining);
    if (quantity <= 0) continue;
    result.set(line.sourceLocationId, quantity);
    remaining -= quantity;
  }
  return result;
}

/**
 * Manual-target adapter for Phase 3.
 *
 * The full auto-demand pool is generated first, then a smaller explicit target
 * is balanced across that complete pool. This prevents earlier allocation
 * phases from hiding lower-volume categories before assortment rules run.
 */
export async function buildSmartTransferTargetBalancedPreview(
  companyId: number,
  sourceLocationIds: number[],
  destinationLocationId: number,
  targetQuantity: number,
  options: SmartTransferBusinessRuleOptions = {}
): Promise<SmartTransferBusinessRuleResult> {
  const autoTarget = !targetQuantity || targetQuantity <= 0;
  const full = await buildSmartTransferBusinessRulePreview(
    companyId,
    sourceLocationIds,
    destinationLocationId,
    0,
    options
  );
  if (autoTarget || full.lines.length === 0) return full;

  const requestedTarget = wholeNonNegative(targetQuantity);
  if (requestedTarget >= full.achievedQuantity) {
    const shortfallQuantity = Math.max(0, requestedTarget - full.achievedQuantity);
    return {
      ...full,
      targetQuantity: requestedTarget,
      shortfallQuantity,
      shortfall: shortfallQuantity > 0,
      warnings:
        shortfallQuantity > 0
          ? [
              ...full.warnings,
              `The manual target exceeds the full Phase 3 calculated demand pool by ${shortfallQuantity} unit(s); the generator did not invent extra demand.`,
            ]
          : full.warnings,
      summary: `Phase 3 evaluated the full candidate pool and produced ${full.achievedQuantity} of ${requestedTarget} manually requested unit(s).`,
    };
  }

  const linesByItem = new Map<number, SmartTransferBusinessRuleLine[]>();
  for (const line of full.lines) {
    const list = linesByItem.get(line.stockItemId) ?? [];
    list.push(line);
    linesByItem.set(line.stockItemId, list);
  }

  const itemShareCap =
    linesByItem.size <= 1 ? requestedTarget : Math.ceil((requestedTarget * full.businessRules.maxItemSharePct) / 100);
  const categoryKeys = new Set(full.lines.map((line) => line.categoryId ?? UNASSIGNED_KEY));
  const groupKeys = new Set(full.lines.map((line) => line.stockGroupId ?? UNASSIGNED_KEY));
  const categoryShareCap =
    categoryKeys.size <= 1
      ? requestedTarget
      : Math.ceil((requestedTarget * full.businessRules.maxCategorySharePct) / 100);
  const groupShareCap =
    groupKeys.size <= 1
      ? requestedTarget
      : Math.ceil((requestedTarget * full.businessRules.maxStockGroupSharePct) / 100);

  const items: TargetItem[] = [];
  for (const [stockItemId, itemLines] of linesByItem.entries()) {
    const representative = itemLines[0];
    const capacity = itemLines.reduce((sum, line) => sum + wholeNonNegative(line.suggestedQuantity), 0);
    if (capacity <= 0) continue;
    items.push({
      stockItemId,
      representative,
      sources: itemLines,
      capacity,
      itemCap: Math.min(capacity, Math.max(1, itemShareCap)),
      categoryKey: representative.categoryId ?? UNASSIGNED_KEY,
      stockGroupKey: representative.stockGroupId ?? UNASSIGNED_KEY,
      weight:
        Math.max(1, representative.businessPriorityScore) *
        Math.max(1, representative.forecastDailyRate * 10) *
        Math.max(1, capacity),
    });
  }

  const categoryTargetShare = new Map<number, number>();
  for (const row of full.categoryMix) categoryTargetShare.set(row.id ?? UNASSIGNED_KEY, row.targetSharePct / 100);
  const groupTargetShare = new Map<number, number>();
  for (const row of full.stockGroupMix) groupTargetShare.set(row.id ?? UNASSIGNED_KEY, row.targetSharePct / 100);

  const categoryCaps = new Map<number, number>();
  const groupCaps = new Map<number, number>();
  const categoryTargets = new Map<number, number>();
  const groupTargets = new Map<number, number>();
  for (const key of categoryKeys) {
    categoryCaps.set(key, categoryShareCap);
    categoryTargets.set(key, Math.round(requestedTarget * (categoryTargetShare.get(key) ?? 0)));
  }
  for (const key of groupKeys) {
    groupCaps.set(key, groupShareCap);
    groupTargets.set(key, Math.round(requestedTarget * (groupTargetShare.get(key) ?? 0)));
  }

  let allocations = allocateTarget({
    items,
    requested: requestedTarget,
    categoryCaps,
    stockGroupCaps: groupCaps,
    categoryTargets,
    stockGroupTargets: groupTargets,
  });
  let achieved = Array.from(allocations.values()).reduce((sum, quantity) => sum + quantity, 0);
  let relaxedBucketCaps = false;
  let relaxedItemCaps = false;

  if (achieved < requestedTarget) {
    relaxedBucketCaps = true;
    allocations = allocateTarget({
      items,
      requested: requestedTarget,
      allocations,
      categoryCaps,
      stockGroupCaps: groupCaps,
      categoryTargets,
      stockGroupTargets: groupTargets,
      relaxBucketCaps: true,
    });
    achieved = Array.from(allocations.values()).reduce((sum, quantity) => sum + quantity, 0);
  }
  if (achieved < requestedTarget) {
    relaxedItemCaps = true;
    allocations = allocateTarget({
      items,
      requested: requestedTarget,
      allocations,
      categoryCaps,
      stockGroupCaps: groupCaps,
      categoryTargets,
      stockGroupTargets: groupTargets,
      relaxBucketCaps: true,
      relaxItemCaps: true,
    });
  }

  const itemsById = new Map(items.map((item) => [item.stockItemId, item]));
  const categoryTotals = totalByBucket(allocations, itemsById, "category");
  const groupTotals = totalByBucket(allocations, itemsById, "stockGroup");
  const finalTotal = Array.from(allocations.values()).reduce((sum, quantity) => sum + quantity, 0);
  const lines: SmartTransferBusinessRuleLine[] = [];

  for (const item of items) {
    const itemQty = allocations.get(item.stockItemId) ?? 0;
    if (itemQty <= 0) continue;
    const sourceAllocations = allocateExistingSources(item.sources, itemQty);
    const categoryShare = (categoryTotals.get(item.categoryKey) ?? 0) / Math.max(1, finalTotal);
    const groupShare = (groupTotals.get(item.stockGroupKey) ?? 0) / Math.max(1, finalTotal);

    for (const sourceLine of item.sources) {
      const suggestedQuantity = sourceAllocations.get(sourceLine.sourceLocationId) ?? 0;
      if (suggestedQuantity <= 0) continue;
      lines.push({
        ...sourceLine,
        suggestedQuantity,
        itemSuggestedTotal: itemQty,
        itemBusinessCapQty: item.itemCap,
        finalCategorySharePct: roundNumber(categoryShare * 100, 2),
        finalStockGroupSharePct: roundNumber(groupShare * 100, 2),
        mixAdjustmentReason: `${sourceLine.mixAdjustmentReason} Manual target was rebalanced against the complete eligible candidate pool.`,
        reason: `${sourceLine.reason} Manual target adjustment: rebalanced against the complete eligible candidate pool before source allocation.`,
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

  const warnings = [...full.warnings];
  if (relaxedBucketCaps) {
    warnings.push(
      "Manual-target balancing relaxed category/stock-group caps only because strict caps could not fill the entered target."
    );
  }
  if (relaxedItemCaps) {
    warnings.push(
      "Manual-target balancing relaxed the per-item cap only because the remaining eligible assortment could not fill the entered target."
    );
  }
  if (shortfallQuantity > 0) {
    warnings.push(
      `The manually entered target remains short by ${shortfallQuantity} unit(s) after evaluating the complete Phase 3 demand pool.`
    );
  }

  return {
    ...full,
    targetQuantity: requestedTarget,
    achievedQuantity,
    shortfallQuantity,
    shortfall: shortfallQuantity > 0,
    lines,
    totalsBySource,
    warnings,
    categoryMix: rebuildMix(full.categoryMix, categoryTotals, achievedQuantity),
    stockGroupMix: rebuildMix(full.stockGroupMix, groupTotals, achievedQuantity),
    summary: `Phase 3 balanced ${achievedQuantity} of ${requestedTarget} manually requested unit(s) against the complete eligible candidate pool before applying source allocations.`,
  };
}
