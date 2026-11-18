// Extracted from ./smartTransferForecasting.ts to keep that module under the source-size cap.
import { and, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { db } from "../db";
import { inventory, salesItems, vouchers } from "@shared/schema";
import {
  allocateWholeUnitsByWeight,
  buildSmartTransferPreview,
  type SmartTransferPreviewLine,
  type SmartTransferPreviewOptions,
  type SmartTransferSourceStock,
  type SmartTransferSourceTotal,
} from "./smartTransferAllocation";
import { loadOtwStockByItem, type OtwContainerDetail } from "./stockTransferAnalysis";
import { roundNumber } from "./smartTransferPerformance";
import {
  accelerationScore,
  calculateOtwMetrics,
  calculateWeightedForecastRate,
  clamp,
  historicalSellThroughScore,
  isoDaysAgo,
  otwTimingRiskScore,
  parseQuantity,
  sourceAvailabilityScore,
  stockoutUrgencyScore,
  wholeNonNegative,
  type ForecastCandidate,
  type OtwForecastMetrics,
  type SalesWindowMetrics,
  type SmartTransferForecastPreviewLine,
  type SmartTransferForecastPreviewResult,
  type SmartTransferScoreBreakdown,
} from "./calculateWeightedForecastRate";
import {
  assortmentStrengthScore,
  buildForecastReason,
  dataQualityScore,
  historicalNeedFloor,
  urgencyBand,
} from "./smartTransferForecastingBuildForecastReason";

/**
 * Phase 1 forecasting layer for the smart transfer generator.
 *
 * It preserves the existing read-only preview and stock-safety rules, then
 * re-ranks and reallocates its qualifying candidates using:
 * - weighted 7/30/90-day destination sales,
 * - recent acceleration/decline,
 * - days-to-stockout urgency,
 * - ETA/shop-reliability-weighted OTW,
 * - historical sell-through and current source availability.
 *
 * It never creates vouchers, reserves stock, posts accounting entries or moves inventory.
 */
export async function buildSmartTransferForecastPreview(
  companyId: number,
  sourceLocationIds: number[],
  destinationLocationId: number,
  targetQuantity: number,
  options: SmartTransferPreviewOptions = {}
): Promise<SmartTransferForecastPreviewResult> {
  const autoTarget = !targetQuantity || targetQuantity <= 0;
  // Ask the existing engine for its full auto-sized candidate set first. This
  // prevents an explicit target from hiding lower-ranked candidates before the
  // Phase 1 score has a chance to compare and re-rank them.
  const base = await buildSmartTransferPreview(companyId, sourceLocationIds, destinationLocationId, 0, options);

  if (base.lines.length === 0) {
    const requestedTarget = autoTarget ? base.targetQuantity : wholeNonNegative(targetQuantity);
    return {
      ...base,
      forecastingVersion: 1,
      targetQuantity: requestedTarget,
      achievedQuantity: 0,
      shortfallQuantity: requestedTarget,
      shortfall: requestedTarget > 0,
      lines: [],
      summary: `${base.summary} Phase 1 forecasting found no allocated lines to re-rank.`,
    };
  }

  const asOfDate = options.asOfDate ?? new Date().toISOString().slice(0, 10);
  const targetCoverageDays = base.targetCoverageDays;
  const representativeByItem = new Map<number, SmartTransferPreviewLine>();
  for (const line of base.lines) {
    if (!representativeByItem.has(line.stockItemId)) representativeByItem.set(line.stockItemId, line);
  }
  const stockItemIds = Array.from(representativeByItem.keys());
  const selectedSourceIds = base.sourceLocationIds;
  const sourceNameById = new Map(
    base.sourceLocationIds.map((id, index) => [id, base.sourceLocationNames[index] ?? `Location #${id}`])
  );

  const ninetyDayStart = isoDaysAgo(asOfDate, 89);
  const thirtyDayStart = isoDaysAgo(asOfDate, 29);
  const sevenDayStart = isoDaysAgo(asOfDate, 6);

  const [destinationSalesRows, sourceInventoryRows, sourceSalesRows, otwResult] = await Promise.all([
    db
      .select({
        stockItemId: salesItems.stockItemId,
        voucherDate: vouchers.voucherDate,
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
          gte(vouchers.voucherDate, ninetyDayStart),
          lte(vouchers.voucherDate, asOfDate)
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
          inArray(inventory.locationId, selectedSourceIds)
        )
      ),
    db
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
          inArray(vouchers.locationId, selectedSourceIds),
          inArray(salesItems.stockItemId, stockItemIds),
          gte(vouchers.voucherDate, thirtyDayStart),
          lte(vouchers.voucherDate, asOfDate)
        )
      ),
    options.includeOtw === false
      ? Promise.resolve({
          otwQtyByItem: new Map<number, number>(),
          otwDetailsByItem: new Map<number, OtwContainerDetail[]>(),
        })
      : loadOtwStockByItem(companyId, destinationLocationId),
  ]);

  const salesByItem = new Map<number, Array<{ date: string; quantity: number }>>();
  for (const row of destinationSalesRows) {
    const list = salesByItem.get(row.stockItemId) ?? [];
    list.push({ date: row.voucherDate, quantity: parseQuantity(row.quantity) });
    salesByItem.set(row.stockItemId, list);
  }

  const sourceSalesMap = new Map<string, number>();
  for (const row of sourceSalesRows) {
    if (!row.locationId) continue;
    const key = `${row.stockItemId}:${row.locationId}`;
    sourceSalesMap.set(key, (sourceSalesMap.get(key) ?? 0) + parseQuantity(row.quantity));
  }

  const sourceStocksByItem = new Map<number, SmartTransferSourceStock[]>();
  for (const row of sourceInventoryRows) {
    const currentStock = wholeNonNegative(parseQuantity(row.quantity));
    if (currentStock <= 0) continue;
    const sourceSalesQty = sourceSalesMap.get(`${row.stockItemId}:${row.locationId}`) ?? 0;
    const sourceDailyRate = sourceSalesQty / 30;
    const reserveQty = sourceDailyRate > 0.1 ? Math.ceil(sourceDailyRate * Math.min(targetCoverageDays, 14)) : 0;
    const availableQty = Math.max(0, currentStock - reserveQty);
    if (availableQty <= 0) continue;
    const list = sourceStocksByItem.get(row.stockItemId) ?? [];
    list.push({
      sourceLocationId: row.locationId,
      sourceLocationName: sourceNameById.get(row.locationId) ?? `Location #${row.locationId}`,
      currentStock,
      reserveQty,
      availableQty,
      averageRate: roundNumber(parseQuantity(row.averageRate), 2),
    });
    sourceStocksByItem.set(row.stockItemId, list);
  }

  const preliminary: Array<{
    representative: SmartTransferPreviewLine;
    sourceStocks: SmartTransferSourceStock[];
    totalAvailable: number;
    sales: SalesWindowMetrics;
    otw: OtwForecastMetrics;
    daysUntilStockout: number | null;
    weightedEffectiveDestinationStock: number;
    calculatedNeed: number;
  }> = [];

  for (const [stockItemId, representative] of representativeByItem.entries()) {
    const itemSales = salesByItem.get(stockItemId) ?? [];
    const sales7 = itemSales.filter((sale) => sale.date >= sevenDayStart).reduce((sum, sale) => sum + sale.quantity, 0);
    const sales30 = itemSales
      .filter((sale) => sale.date >= thirtyDayStart)
      .reduce((sum, sale) => sum + sale.quantity, 0);
    const sales90 = itemSales.reduce((sum, sale) => sum + sale.quantity, 0);
    const sales = calculateWeightedForecastRate(
      sales7,
      sales30,
      sales90,
      representative.latestSalesPerDay,
      representative.averageSalesPerDay
    );

    const daysUntilStockout = sales.forecastRate > 0 ? representative.destinationStock / sales.forecastRate : null;
    const otw = calculateOtwMetrics(
      otwResult.otwDetailsByItem.get(stockItemId) ?? [],
      asOfDate,
      daysUntilStockout,
      targetCoverageDays
    );
    const weightedEffectiveDestinationStock = Math.max(0, representative.destinationStock + otw.weightedQty);
    const forecastCoverageDays = sales.forecastRate > 0 ? weightedEffectiveDestinationStock / sales.forecastRate : null;
    const forecastNeed =
      sales.forecastRate > 0
        ? Math.max(0, Math.ceil(sales.forecastRate * targetCoverageDays - weightedEffectiveDestinationStock))
        : 0;
    const historicalFloor = historicalNeedFloor(
      representative,
      sales.trend,
      forecastCoverageDays !== null && forecastCoverageDays >= targetCoverageDays
    );
    const calculatedNeed = Math.max(forecastNeed, historicalFloor);
    const sourceStocks = (sourceStocksByItem.get(stockItemId) ?? [])
      .slice()
      .sort(
        (a, b) =>
          b.availableQty - a.availableQty ||
          a.sourceLocationName.localeCompare(b.sourceLocationName) ||
          a.sourceLocationId - b.sourceLocationId
      );
    const totalAvailable = sourceStocks.reduce((sum, source) => sum + source.availableQty, 0);

    if (calculatedNeed <= 0 || totalAvailable <= 0) continue;
    preliminary.push({
      representative,
      sourceStocks,
      totalAvailable,
      sales,
      otw,
      daysUntilStockout,
      weightedEffectiveDestinationStock,
      calculatedNeed,
    });
  }

  const maxForecastRate = Math.max(0.001, ...preliminary.map((candidate) => candidate.sales.forecastRate));
  const candidates: ForecastCandidate[] = preliminary.map((candidate) => {
    const demandScore = Math.round(20 * Math.sqrt(candidate.sales.forecastRate / maxForecastRate));
    const scoreBreakdown: SmartTransferScoreBreakdown = {
      stockoutUrgency: stockoutUrgencyScore(candidate.daysUntilStockout, targetCoverageDays),
      forecastDemand: clamp(demandScore, 0, 20),
      salesAcceleration: accelerationScore(candidate.sales.trend, candidate.sales.trendRatio),
      historicalSellThrough: historicalSellThroughScore(candidate.representative),
      sourceAvailability: sourceAvailabilityScore(candidate.totalAvailable, candidate.calculatedNeed),
      otwTimingRisk: otwTimingRiskScore(candidate.otw),
      assortmentStrength: assortmentStrengthScore(candidate.representative),
      dataQuality: dataQualityScore(candidate.sales.sales90, candidate.representative),
    };
    const itemScore = clamp(
      Math.round(Object.values(scoreBreakdown).reduce((sum, component) => sum + component, 0)),
      0,
      100
    );
    const allocationCapacity = Math.min(candidate.totalAvailable, wholeNonNegative(candidate.calculatedNeed));
    return {
      ...candidate,
      allocationCapacity,
      scoreBreakdown,
      itemScore,
      urgencyBand: urgencyBand(itemScore),
      confidence: roundNumber(clamp(0.35 + itemScore / 150, 0.35, 0.97), 2),
      weight: Math.max(1, itemScore) * Math.max(1, candidate.sales.forecastRate * 10),
    };
  });

  candidates.sort(
    (a, b) =>
      b.itemScore - a.itemScore ||
      b.sales.forecastRate - a.sales.forecastRate ||
      b.representative.overallSellThroughPercentage - a.representative.overallSellThroughPercentage ||
      a.representative.stockItemName.localeCompare(b.representative.stockItemName)
  );

  let requestedTarget = autoTarget
    ? candidates.reduce((sum, candidate) => sum + candidate.calculatedNeed, 0)
    : wholeNonNegative(targetQuantity);
  const totalCapacity = candidates.reduce((sum, candidate) => sum + candidate.allocationCapacity, 0);
  requestedTarget = Math.max(0, requestedTarget);
  const fairShareCap = candidates.length > 0 ? Math.ceil((requestedTarget / candidates.length) * 3) : requestedTarget;

  const itemAllocations = allocateWholeUnitsByWeight(
    candidates.map((candidate) => ({
      id: String(candidate.representative.stockItemId),
      capacity: Math.min(candidate.allocationCapacity, Math.max(1, fairShareCap)),
      weight: candidate.weight,
      priority: 100 - candidate.itemScore,
    })),
    Math.min(requestedTarget, totalCapacity)
  );

  const lines: SmartTransferForecastPreviewLine[] = [];
  for (const candidate of candidates) {
    const itemSuggestedTotal = itemAllocations.get(String(candidate.representative.stockItemId)) ?? 0;
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
      const representative = candidate.representative;
      lines.push({
        ...representative,
        sourceLocationId: source.sourceLocationId,
        sourceLocationName: source.sourceLocationName,
        availableAtSource: source.availableQty,
        sourceCurrentStock: source.currentStock,
        sourceReserveQty: source.reserveQty,
        sourceAverageRate: source.averageRate,
        otwQty: wholeNonNegative(candidate.otw.rawQty),
        effectiveDestinationStock: wholeNonNegative(candidate.weightedEffectiveDestinationStock),
        suggestedQuantity,
        itemSuggestedTotal,
        calculatedNeed: candidate.calculatedNeed,
        confidence: candidate.confidence,
        classificationLabel: `${representative.classificationLabel} · ${candidate.itemScore}/100`,
        reason: buildForecastReason(candidate, source, suggestedQuantity, itemSuggestedTotal),
        forecastSales7Days: candidate.sales.sales7,
        forecastSales30Days: candidate.sales.sales30,
        forecastSales90Days: candidate.sales.sales90,
        forecastRate7Days: candidate.sales.rate7,
        forecastRate30Days: candidate.sales.rate30,
        forecastRate90Days: candidate.sales.rate90,
        forecastDailyRate: candidate.sales.forecastRate,
        forecastTrend: candidate.sales.trend,
        forecastTrendRatio: candidate.sales.trendRatio,
        weightedOtwQty: candidate.otw.weightedQty,
        reliableOtwBeforeStockoutQty: candidate.otw.reliableBeforeStockoutQty,
        daysUntilStockout: candidate.daysUntilStockout === null ? null : roundNumber(candidate.daysUntilStockout, 1),
        itemScore: candidate.itemScore,
        urgencyBand: candidate.urgencyBand,
        scoreBreakdown: candidate.scoreBreakdown,
      });
    }
  }

  lines.sort(
    (a, b) =>
      b.itemScore - a.itemScore ||
      b.forecastDailyRate - a.forecastDailyRate ||
      a.stockItemName.localeCompare(b.stockItemName) ||
      a.sourceLocationName.localeCompare(b.sourceLocationName)
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

  const uncertainOtwItems = candidates.filter((candidate) => candidate.otw.uncertainQty >= 1).length;
  const lowDataItems = candidates.filter((candidate) => candidate.sales.sales90 < 3).length;
  const warnings = base.warnings.filter((warning) => !/short by .* suitable calculated demand/i.test(warning));
  if (shortfallQuantity > 0) {
    warnings.push(
      `The forecast preview is short by ${shortfallQuantity} whole unit(s) because source stock after reserve was insufficient.`
    );
  }
  if (uncertainOtwItems > 0) {
    warnings.push(
      `${uncertainOtwItems} item(s) had OTW quantities discounted because destination assignment, ETA or tracking status was uncertain.`
    );
  }
  if (lowDataItems > 0) {
    warnings.push(`${lowDataItems} item(s) had limited 90-day sales history, so their forecast confidence is lower.`);
  }

  return {
    ...base,
    forecastingVersion: 1,
    targetQuantity: requestedTarget,
    achievedQuantity,
    shortfallQuantity,
    shortfall: shortfallQuantity > 0,
    lines,
    totalsBySource,
    warnings,
    summary: `Phase 1 forecast generated ${achievedQuantity} of ${requestedTarget} whole unit(s) for ${base.destinationLocationName} using weighted 7/30/90-day demand, sales trend, stockout urgency and ETA/shop-reliability-weighted OTW.`,
  };
}
