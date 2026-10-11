import { and, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { db } from "../db";
import { inventory, salesItems, stockItems, vouchers } from "@shared/schema";
import { loadOtwStockByItem, type OtwContainerDetail } from "./stockTransferAnalysis";
import {
  analyzeLastTwoMultiSourceTransfers,
  type HistoricalTransferItemPerformance,
  type SmartTransferHistoryResult,
} from "./smartTransferHistoryAnalysis";
import { roundNumber, type TransferPerformanceClassification } from "./smartTransferPerformance";
import { parseMoneyInput } from "../lib/money";

export interface SmartTransferPreviewOptions {
  asOfDate?: string;
  includeOtw?: boolean;
  stockGroupIds?: number[];
  categoryIds?: number[];
  targetCoverageDays?: number;
}

export interface SmartTransferSourceStock {
  sourceLocationId: number;
  sourceLocationName: string;
  currentStock: number;
  reserveQty: number;
  availableQty: number;
  averageRate: number;
}

export interface SmartTransferPreviewLine {
  stockItemId: number;
  stockItemName: string;
  stockItemCode: string;
  uom: string;
  stockGroupId: number | null;
  categoryId: number | null;
  sourceLocationId: number;
  sourceLocationName: string;
  availableAtSource: number;
  sourceCurrentStock: number;
  sourceReserveQty: number;
  sourceAverageRate: number;
  destinationStock: number;
  otwQty: number;
  effectiveDestinationStock: number;
  olderTransferQty: number;
  newerTransferQty: number;
  salesAfterOlderTransfer: number;
  salesAfterNewerTransfer: number;
  totalSalesSinceOlderTransfer: number;
  olderSellThroughPercentage: number;
  newerSellThroughPercentage: number;
  overallSellThroughPercentage: number;
  averageSalesPerDay: number;
  latestSalesPerDay: number;
  estimatedDaysOfStockRemaining: number | null;
  classification: TransferPerformanceClassification;
  classificationLabel: string;
  suggestedQuantity: number;
  itemSuggestedTotal: number;
  calculatedNeed: number;
  confidence: number;
  reason: string;
}

export interface SmartTransferExcludedItem {
  stockItemId: number;
  stockItemName: string;
  stockItemCode: string;
  classification: TransferPerformanceClassification;
  classificationLabel: string;
  destinationStock: number;
  otwQty: number;
  totalAvailableAcrossSources: number;
  reason: string;
}

export interface SmartTransferSourceTotal {
  sourceLocationId: number;
  sourceLocationName: string;
  suggestedQuantity: number;
  lineCount: number;
}

export interface SmartTransferPreviewResult {
  readOnly: true;
  generatedAt: string;
  companyId: number;
  destinationLocationId: number;
  destinationLocationName: string;
  sourceLocationIds: number[];
  sourceLocationNames: string[];
  targetQuantity: number;
  achievedQuantity: number;
  shortfallQuantity: number;
  shortfall: boolean;
  includeOtw: boolean;
  targetCoverageDays: number;
  stockGroupIds: number[];
  categoryIds: number[];
  lines: SmartTransferPreviewLine[];
  excludedItems: SmartTransferExcludedItem[];
  totalsBySource: SmartTransferSourceTotal[];
  history: SmartTransferHistoryResult;
  warnings: string[];
  summary: string;
}

export interface WholeUnitAllocationInput {
  id: string;
  capacity: number;
  weight: number;
  priority?: number;
}

interface SmartTransferItemCandidate {
  performance: HistoricalTransferItemPerformance;
  stockItemName: string;
  stockItemCode: string;
  uom: string;
  stockGroupId: number | null;
  categoryId: number | null;
  sourceStocks: SmartTransferSourceStock[];
  totalAvailable: number;
  otwQty: number;
  otwDetails: OtwContainerDetail[];
  effectiveDestinationStock: number;
  calculatedNeed: number;
  allocationCapacity: number;
  weight: number;
  priority: number;
  confidence: number;
}

function parseQuantity(value: unknown): number {
  const parsed = parseMoneyInput(String(value ?? "0"))?.toNumber() ?? NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function wholeNonNegative(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

function uniquePositiveIds(values: number[] | undefined): number[] {
  return Array.from(new Set((values ?? []).map(Number).filter((value) => Number.isInteger(value) && value > 0)));
}

/**
 * Deterministically allocate whole units across weighted capacities.
 * It never exceeds a capacity and never allocates more than the requested target.
 */
export function allocateWholeUnitsByWeight(
  inputs: WholeUnitAllocationInput[],
  requestedTarget: number
): Map<string, number> {
  const normalized = inputs
    .map((input) => ({
      id: input.id,
      capacity: wholeNonNegative(input.capacity),
      weight: Number.isFinite(input.weight) && input.weight > 0 ? input.weight : 0,
      priority: Number.isFinite(input.priority) ? Number(input.priority) : 999,
    }))
    .filter((input) => input.capacity > 0);

  const result = new Map<string, number>();
  for (const input of normalized) result.set(input.id, 0);

  const totalCapacity = normalized.reduce((sum, input) => sum + input.capacity, 0);
  let remaining = Math.min(wholeNonNegative(requestedTarget), totalCapacity);
  if (remaining <= 0 || normalized.length === 0) return result;

  while (remaining > 0) {
    const eligible = normalized.filter((input) => (result.get(input.id) ?? 0) < input.capacity);
    if (eligible.length === 0) break;

    const totalWeight = eligible.reduce((sum, input) => sum + input.weight, 0);
    let progress = 0;

    if (totalWeight > 0) {
      const remainingAtStart = remaining;
      for (const input of eligible) {
        const already = result.get(input.id) ?? 0;
        const room = input.capacity - already;
        const proportionalShare = Math.floor((remainingAtStart * input.weight) / totalWeight);
        const add = Math.min(room, proportionalShare, remaining);
        if (add <= 0) continue;
        result.set(input.id, already + add);
        remaining -= add;
        progress += add;
        if (remaining <= 0) break;
      }
    }

    if (remaining <= 0) break;

    if (progress === 0) {
      const ordered = eligible
        .slice()
        .sort(
          (a, b) =>
            a.priority - b.priority || b.weight - a.weight || b.capacity - a.capacity || a.id.localeCompare(b.id)
        );
      for (const input of ordered) {
        if (remaining <= 0) break;
        const already = result.get(input.id) ?? 0;
        if (already >= input.capacity) continue;
        result.set(input.id, already + 1);
        remaining -= 1;
      }
    }
  }

  return result;
}

function classificationPriority(classification: TransferPerformanceClassification): number {
  switch (classification) {
    case "strong_seller":
      return 0;
    case "good_seller":
      return 1;
    case "normal_seller":
      return 2;
    case "slow_seller":
      return 3;
    case "overstocked":
      return 4;
    case "no_recent_sales":
    default:
      return 5;
  }
}

function classificationMultiplier(classification: TransferPerformanceClassification): number {
  switch (classification) {
    case "strong_seller":
      return 1.25;
    case "good_seller":
      return 1;
    case "normal_seller":
      return 0.75;
    case "slow_seller":
      return 0.35;
    case "overstocked":
    case "no_recent_sales":
    default:
      return 0;
  }
}

function confidenceForPerformance(performance: HistoricalTransferItemPerformance): number {
  let confidence = 0.5;
  switch (performance.classification) {
    case "strong_seller":
      confidence = 0.92;
      break;
    case "good_seller":
      confidence = 0.82;
      break;
    case "normal_seller":
      confidence = 0.68;
      break;
    case "slow_seller":
      confidence = 0.48;
      break;
    case "overstocked":
      confidence = 0.3;
      break;
    case "no_recent_sales":
      confidence = 0.2;
      break;
  }
  if (performance.olderTransferQty > 0 && performance.newerTransferQty > 0) confidence += 0.03;
  return Math.min(0.95, roundNumber(confidence, 2));
}

function buildLineReason(
  candidate: SmartTransferItemCandidate,
  source: SmartTransferSourceStock,
  sourceQty: number,
  itemSuggestedTotal: number
): string {
  const perf = candidate.performance;
  const parts = [
    `${perf.classificationLabel}: ${roundNumber(perf.totalSalesSinceOlderTransfer, 0)} sold after ${roundNumber(
      perf.totalTransferredQty,
      0
    )} transferred across the last ${perf.olderTransferQty > 0 ? "4" : "1"} qualifying order(s)`,
    `destination stock ${roundNumber(perf.currentDestinationQty, 0)}`,
  ];
  if (candidate.otwQty > 0) parts.push(`OTW ${roundNumber(candidate.otwQty, 0)} included`);
  parts.push(
    `calculated need ${candidate.calculatedNeed}`,
    `${source.sourceLocationName} has ${source.availableQty} available after reserving ${source.reserveQty}`,
    `${sourceQty} allocated here (${itemSuggestedTotal} total for this item)`
  );
  return parts.join("; ") + ".";
}

/**
 * Build a fully read-only smart transfer preview from the last two completed
 * transfer orders, destination sales, live inventory and optional OTW stock.
 */
export async function buildSmartTransferPreview(
  companyId: number,
  sourceLocationIds: number[],
  destinationLocationId: number,
  targetQuantity: number,
  options: SmartTransferPreviewOptions = {}
): Promise<SmartTransferPreviewResult> {
  const autoTarget = !targetQuantity || targetQuantity <= 0;
  let requestedTarget = wholeNonNegative(targetQuantity);
  if (!Number.isInteger(companyId) || companyId <= 0) throw new Error("A valid company is required");

  const includeOtw = options.includeOtw !== false;
  const targetCoverageDays = Math.min(180, Math.max(1, wholeNonNegative(options.targetCoverageDays ?? 21)));
  const asOfDate = options.asOfDate ?? new Date().toISOString().slice(0, 10);
  const stockGroupIds = uniquePositiveIds(options.stockGroupIds);
  const categoryIds = uniquePositiveIds(options.categoryIds);

  const history = await analyzeLastTwoMultiSourceTransfers(companyId, sourceLocationIds, destinationLocationId, {
    asOfDate,
  });

  const warnings: string[] = [];
  if (!history.olderTransfer) {
    warnings.push("Only one completed historical transfer was found; the preview uses that transfer and later sales.");
  } else if (history.newerTransfer && history.olderTransfer.transferId === history.newerTransfer.transferId) {
    warnings.push("Fewer than 4 completed transfers were found; the preview uses all available history.");
  }

  if (history.items.length === 0) {
    return {
      readOnly: true,
      generatedAt: new Date().toISOString(),
      companyId,
      destinationLocationId,
      destinationLocationName: history.destinationLocationName,
      sourceLocationIds: history.selectedSourceLocationIds,
      sourceLocationNames: history.selectedSourceLocationNames,
      targetQuantity: requestedTarget,
      achievedQuantity: 0,
      shortfallQuantity: requestedTarget,
      shortfall: true,
      includeOtw,
      targetCoverageDays,
      stockGroupIds,
      categoryIds,
      lines: [],
      excludedItems: [],
      totalsBySource: [],
      history,
      warnings: [...warnings, "No qualifying historical transfer items were available for allocation."],
      summary: `No smart transfer preview could be generated for ${history.destinationLocationName}.`,
    };
  }

  const stockItemIds = history.items.map((item) => item.stockItemId);
  const [itemRows, sourceInventoryRows, otwResult] = await Promise.all([
    db
      .select({
        id: stockItems.id,
        name: stockItems.name,
        code: stockItems.code,
        uom: stockItems.uom,
        stockGroupId: stockItems.stockGroupId,
        categoryId: stockItems.categoryId,
      })
      .from(stockItems)
      .where(
        and(
          eq(stockItems.companyId, companyId),
          inArray(stockItems.id, stockItemIds),
          eq(stockItems.active, true),
          isNull(stockItems.deletedAt)
        )
      ),
    db
      .select({
        stockItemId: inventory.stockItemId,
        locationId: inventory.locationId,
        quantity: inventory.quantity,
        averageRate: inventory.averageRate,
      })
      .from(inventory)
      .where(
        and(
          eq(inventory.companyId, companyId),
          inArray(inventory.stockItemId, stockItemIds),
          inArray(inventory.locationId, history.selectedSourceLocationIds)
        )
      ),
    includeOtw
      ? loadOtwStockByItem(companyId, destinationLocationId)
      : Promise.resolve({
          otwQtyByItem: new Map<number, number>(),
          otwDetailsByItem: new Map<number, OtwContainerDetail[]>(),
        }),
  ]);

  const itemMetaById = new Map(itemRows.map((item) => [item.id, item]));
  const sourceNameById = new Map(
    history.selectedSourceLocationIds.map((id, index) => [id, history.selectedSourceLocationNames[index]])
  );
  const sourceStocksByItem = new Map<number, SmartTransferSourceStock[]>();

  // Fetch recent sales at source locations (last 30 days) to reserve stock for
  // items actively selling at the warehouse itself so we don't drain it.
  const thirtyDaysAgo = (() => {
    const d = new Date(`${asOfDate}T00:00:00.000Z`);
    d.setDate(d.getDate() - 30);
    return d.toISOString().slice(0, 10);
  })();
  const sourceSalesRows =
    stockItemIds.length > 0
      ? await db
          .select({
            stockItemId: salesItems.stockItemId,
            locationId: vouchers.locationId,
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
              inArray(vouchers.locationId, history.selectedSourceLocationIds),
              inArray(salesItems.stockItemId, stockItemIds),
              gte(vouchers.voucherDate, thirtyDaysAgo),
              lte(vouchers.voucherDate, asOfDate)
            )
          )
      : [];

  // Build a map of (stockItemId, locationId) → total units sold in last 30 days at source
  const sourceSalesMap = new Map<string, number>();
  for (const row of sourceSalesRows) {
    const key = `${row.stockItemId}:${row.locationId}`;
    sourceSalesMap.set(key, (sourceSalesMap.get(key) ?? 0) + parseQuantity(row.quantity));
  }

  for (const row of sourceInventoryRows) {
    const currentStock = wholeNonNegative(parseQuantity(row.quantity));
    // Reserve stock for local source sales: keep enough for the next coverage period
    const sourceSalesQty = sourceSalesMap.get(`${row.stockItemId}:${row.locationId}`) ?? 0;
    const sourceDailyRate = sourceSalesQty / 30;
    const localReserve = sourceDailyRate > 0.1 ? Math.ceil(sourceDailyRate * Math.min(targetCoverageDays, 14)) : 0;
    const availableQty = Math.max(0, currentStock - localReserve);
    const list = sourceStocksByItem.get(row.stockItemId) ?? [];
    list.push({
      sourceLocationId: row.locationId,
      sourceLocationName: sourceNameById.get(row.locationId) ?? `Location #${row.locationId}`,
      currentStock,
      reserveQty: localReserve,
      availableQty,
      averageRate: roundNumber(parseQuantity(row.averageRate), 2),
    });
    sourceStocksByItem.set(row.stockItemId, list);
  }

  const candidates: SmartTransferItemCandidate[] = [];
  const excludedItems: SmartTransferExcludedItem[] = [];
  const stockGroupFilter = new Set(stockGroupIds);
  const categoryFilter = new Set(categoryIds);

  for (const performance of history.items) {
    const meta = itemMetaById.get(performance.stockItemId);
    const otwQty = wholeNonNegative(otwResult.otwQtyByItem.get(performance.stockItemId) ?? 0);
    const sourceStocks = (sourceStocksByItem.get(performance.stockItemId) ?? [])
      .filter((source) => source.availableQty > 0)
      .sort(
        (a, b) =>
          b.availableQty - a.availableQty ||
          a.sourceLocationName.localeCompare(b.sourceLocationName) ||
          a.sourceLocationId - b.sourceLocationId
      );
    const totalAvailable = sourceStocks.reduce((sum, source) => sum + source.availableQty, 0);

    const exclude = (reason: string) => {
      excludedItems.push({
        stockItemId: performance.stockItemId,
        stockItemName: meta?.name ?? performance.stockItemName,
        stockItemCode: meta?.code ?? performance.stockItemCode,
        classification: performance.classification,
        classificationLabel: performance.classificationLabel,
        destinationStock: performance.currentDestinationQty,
        otwQty,
        totalAvailableAcrossSources: totalAvailable,
        reason,
      });
    };

    if (!meta) {
      exclude("The stock item is inactive, deleted or unavailable in the current company.");
      continue;
    }
    if (stockGroupFilter.size > 0 && (!meta.stockGroupId || !stockGroupFilter.has(meta.stockGroupId))) {
      exclude("Excluded by the selected stock-group filter.");
      continue;
    }
    if (categoryFilter.size > 0 && (!meta.categoryId || !categoryFilter.has(meta.categoryId))) {
      exclude("Excluded by the selected category filter.");
      continue;
    }
    if (totalAvailable <= 0) {
      exclude(
        "No whole units remain across the selected sources (sources may be reserved for local sales or out of stock)."
      );
      continue;
    }
    if (performance.classification === "overstocked") {
      exclude("Destination stock is already high compared with recent sales.");
      continue;
    }
    if (performance.classification === "no_recent_sales") {
      exclude("No qualifying sales were recorded after the recent transfer order(s).");
      continue;
    }

    const effectiveDestinationStock = wholeNonNegative(performance.currentDestinationQty) + otwQty;
    const recentRate =
      performance.latestSalesPerDay > 0 ? performance.latestSalesPerDay : performance.averageSalesPerDay;
    const coverageNeed = Math.max(0, Math.ceil(recentRate * targetCoverageDays - effectiveDestinationStock));
    const historicalReferenceQty =
      performance.newerTransferQty > 0 ? performance.newerTransferQty : performance.olderTransferQty;
    const historicalNeed = Math.max(
      0,
      Math.ceil(
        historicalReferenceQty * classificationMultiplier(performance.classification) - effectiveDestinationStock
      )
    );

    let calculatedNeed = Math.max(coverageNeed, historicalNeed);
    if (performance.classification === "slow_seller") {
      const lowCoverage =
        performance.estimatedDaysOfStockRemaining === null || performance.estimatedDaysOfStockRemaining < 14;
      calculatedNeed = lowCoverage ? coverageNeed : 0;
    }

    // If the destination already has enough stock to cover the target period AND
    // is actively selling the item, it's self-sufficient — skip it.
    const hasActiveSales = performance.latestSalesPerDay > 0.1;
    const coverageDaysRemaining = performance.estimatedDaysOfStockRemaining;
    if (hasActiveSales && coverageDaysRemaining !== null && coverageDaysRemaining >= targetCoverageDays) {
      exclude(`Destination has ${Math.floor(coverageDaysRemaining)} days of stock remaining and is actively selling.`);
      continue;
    }

    if (calculatedNeed <= 0) {
      exclude("Current destination stock and OTW already cover the calculated demand.");
      continue;
    }

    const allocationCapacity = Math.min(totalAvailable, wholeNonNegative(calculatedNeed));
    if (allocationCapacity <= 0) {
      exclude("No transferable whole-unit capacity remains for the calculated need.");
      continue;
    }

    const priority = classificationPriority(performance.classification);
    const performanceWeight = Math.max(1, 6 - priority);
    const weight = allocationCapacity * performanceWeight + Math.max(0, recentRate * targetCoverageDays);

    candidates.push({
      performance,
      stockItemName: meta.name,
      stockItemCode: meta.code,
      uom: meta.uom,
      stockGroupId: meta.stockGroupId,
      categoryId: meta.categoryId,
      sourceStocks,
      totalAvailable,
      otwQty,
      otwDetails: otwResult.otwDetailsByItem.get(performance.stockItemId) ?? [],
      effectiveDestinationStock,
      calculatedNeed: wholeNonNegative(calculatedNeed),
      allocationCapacity,
      weight,
      priority,
      confidence: confidenceForPerformance(performance),
    });
  }

  candidates.sort(
    (a, b) =>
      a.priority - b.priority ||
      b.performance.latestSalesPerDay - a.performance.latestSalesPerDay ||
      b.performance.overallSellThroughPercentage - a.performance.overallSellThroughPercentage ||
      a.stockItemName.localeCompare(b.stockItemName)
  );

  // Auto-target: when no explicit target was supplied, use the sum of each
  // candidate's calculated need so the order covers exactly what sales data
  // says the destination requires.
  if (autoTarget) {
    requestedTarget = candidates.reduce((sum, c) => sum + c.calculatedNeed, 0);
  }

  // Fair-share cap: prevent a single item from consuming too large a share when
  // there are many candidates. Set at 3× proportional share to still allow
  // strong sellers to take significantly more than average while keeping some
  // balance. Items whose calculatedNeed is below the cap are naturally bounded
  // by that need, so in practice the cap only constrains runaway strong sellers.
  const fairShareCap = candidates.length > 0 ? Math.ceil((requestedTarget / candidates.length) * 3) : requestedTarget;

  const itemAllocations = allocateWholeUnitsByWeight(
    candidates.map((candidate) => ({
      id: String(candidate.performance.stockItemId),
      capacity: Math.min(candidate.allocationCapacity, fairShareCap),
      weight: candidate.weight,
      priority: candidate.priority,
    })),
    requestedTarget
  );

  const lines: SmartTransferPreviewLine[] = [];
  for (const candidate of candidates) {
    const itemSuggestedTotal = itemAllocations.get(String(candidate.performance.stockItemId)) ?? 0;
    if (itemSuggestedTotal <= 0) continue;

    const sourceAllocations = allocateWholeUnitsByWeight(
      candidate.sourceStocks.map((source) => ({
        id: String(source.sourceLocationId),
        capacity: source.availableQty,
        weight: source.availableQty,
        priority: 0,
      })),
      itemSuggestedTotal
    );

    for (const source of candidate.sourceStocks) {
      const suggestedQuantity = sourceAllocations.get(String(source.sourceLocationId)) ?? 0;
      if (suggestedQuantity <= 0) continue;
      const perf = candidate.performance;
      lines.push({
        stockItemId: perf.stockItemId,
        stockItemName: candidate.stockItemName,
        stockItemCode: candidate.stockItemCode,
        uom: candidate.uom,
        stockGroupId: candidate.stockGroupId,
        categoryId: candidate.categoryId,
        sourceLocationId: source.sourceLocationId,
        sourceLocationName: source.sourceLocationName,
        availableAtSource: source.availableQty,
        sourceCurrentStock: source.currentStock,
        sourceReserveQty: source.reserveQty,
        sourceAverageRate: source.averageRate,
        destinationStock: perf.currentDestinationQty,
        otwQty: candidate.otwQty,
        effectiveDestinationStock: candidate.effectiveDestinationStock,
        olderTransferQty: perf.olderTransferQty,
        newerTransferQty: perf.newerTransferQty,
        salesAfterOlderTransfer: perf.salesAfterOlderTransfer,
        salesAfterNewerTransfer: perf.salesAfterNewerTransfer,
        totalSalesSinceOlderTransfer: perf.totalSalesSinceOlderTransfer,
        olderSellThroughPercentage: perf.olderSellThroughPercentage,
        newerSellThroughPercentage: perf.newerSellThroughPercentage,
        overallSellThroughPercentage: perf.overallSellThroughPercentage,
        averageSalesPerDay: perf.averageSalesPerDay,
        latestSalesPerDay: perf.latestSalesPerDay,
        estimatedDaysOfStockRemaining: perf.estimatedDaysOfStockRemaining,
        classification: perf.classification,
        classificationLabel: perf.classificationLabel,
        suggestedQuantity,
        itemSuggestedTotal,
        calculatedNeed: candidate.calculatedNeed,
        confidence: candidate.confidence,
        reason: buildLineReason(candidate, source, suggestedQuantity, itemSuggestedTotal),
      });
    }
  }

  lines.sort(
    (a, b) =>
      classificationPriority(a.classification) - classificationPriority(b.classification) ||
      b.latestSalesPerDay - a.latestSalesPerDay ||
      a.stockItemName.localeCompare(b.stockItemName) ||
      a.sourceLocationName.localeCompare(b.sourceLocationName)
  );

  const achievedQuantity = lines.reduce((sum, line) => sum + line.suggestedQuantity, 0);
  const shortfallQuantity = Math.max(0, requestedTarget - achievedQuantity);
  if (shortfallQuantity > 0) {
    warnings.push(
      `The preview is short by ${shortfallQuantity} whole unit(s) because suitable calculated demand or source stock was insufficient.`
    );
  }

  if (includeOtw) {
    const unknownOtwCount = candidates.reduce(
      (sum, candidate) => sum + candidate.otwDetails.filter((detail) => detail.matchType === "unknown").length,
      0
    );
    if (unknownOtwCount > 0) {
      warnings.push(
        `${unknownOtwCount} OTW item allocation(s) had no saved shop name and were conservatively counted toward destination stock.`
      );
    }
  }

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

  return {
    readOnly: true,
    generatedAt: new Date().toISOString(),
    companyId,
    destinationLocationId,
    destinationLocationName: history.destinationLocationName,
    sourceLocationIds: history.selectedSourceLocationIds,
    sourceLocationNames: history.selectedSourceLocationNames,
    targetQuantity: requestedTarget,
    achievedQuantity,
    shortfallQuantity,
    shortfall: shortfallQuantity > 0,
    includeOtw,
    targetCoverageDays,
    stockGroupIds,
    categoryIds,
    lines,
    excludedItems,
    totalsBySource,
    history,
    warnings,
    summary: `Generated a read-only smart transfer preview for ${achievedQuantity} of ${requestedTarget} requested whole unit(s) to ${history.destinationLocationName} from ${history.selectedSourceLocationIds.length} selected source location(s).`,
  };
}
