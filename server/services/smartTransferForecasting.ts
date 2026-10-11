import { and, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { db } from "../db";
import { inventory, salesItems, vouchers } from "@shared/schema";
import {
  allocateWholeUnitsByWeight,
  buildSmartTransferPreview,
  type SmartTransferPreviewLine,
  type SmartTransferPreviewOptions,
  type SmartTransferPreviewResult,
  type SmartTransferSourceStock,
  type SmartTransferSourceTotal,
} from "./smartTransferAllocation";
import { loadOtwStockByItem, type OtwContainerDetail } from "./stockTransferAnalysis";
import { roundNumber } from "./smartTransferPerformance";
import { parseMoneyInput } from "../lib/money";

export type SmartTransferDemandTrend = "accelerating" | "stable" | "declining" | "insufficient_data";
export type SmartTransferUrgencyBand = "critical" | "high" | "medium" | "low";

export interface SmartTransferScoreBreakdown {
  stockoutUrgency: number;
  forecastDemand: number;
  salesAcceleration: number;
  historicalSellThrough: number;
  sourceAvailability: number;
  otwTimingRisk: number;
  assortmentStrength: number;
  dataQuality: number;
}

export interface SmartTransferForecastFields {
  forecastSales7Days: number;
  forecastSales30Days: number;
  forecastSales90Days: number;
  forecastRate7Days: number;
  forecastRate30Days: number;
  forecastRate90Days: number;
  forecastDailyRate: number;
  forecastTrend: SmartTransferDemandTrend;
  forecastTrendRatio: number | null;
  weightedOtwQty: number;
  reliableOtwBeforeStockoutQty: number;
  daysUntilStockout: number | null;
  itemScore: number;
  urgencyBand: SmartTransferUrgencyBand;
  scoreBreakdown: SmartTransferScoreBreakdown;
}

export type SmartTransferForecastPreviewLine = SmartTransferPreviewLine & SmartTransferForecastFields;

export interface SmartTransferForecastPreviewResult extends Omit<SmartTransferPreviewResult, "lines"> {
  forecastingVersion: 1;
  lines: SmartTransferForecastPreviewLine[];
}

interface SalesWindowMetrics {
  sales7: number;
  sales30: number;
  sales90: number;
  rate7: number;
  rate30: number;
  rate90: number;
  forecastRate: number;
  trend: SmartTransferDemandTrend;
  trendRatio: number | null;
}

interface OtwForecastMetrics {
  rawQty: number;
  weightedQty: number;
  reliableBeforeStockoutQty: number;
  uncertainQty: number;
}

interface ForecastCandidate {
  representative: SmartTransferPreviewLine;
  sourceStocks: SmartTransferSourceStock[];
  totalAvailable: number;
  sales: SalesWindowMetrics;
  otw: OtwForecastMetrics;
  daysUntilStockout: number | null;
  weightedEffectiveDestinationStock: number;
  calculatedNeed: number;
  allocationCapacity: number;
  scoreBreakdown: SmartTransferScoreBreakdown;
  itemScore: number;
  urgencyBand: SmartTransferUrgencyBand;
  confidence: number;
  weight: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function parseQuantity(value: unknown): number {
  const parsed = parseMoneyInput(String(value ?? "0"))?.toNumber() ?? NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function wholeNonNegative(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isoDaysAgo(asOfDate: string, daysAgo: number): string {
  const date = new Date(`${asOfDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - Math.max(0, daysAgo));
  return date.toISOString().slice(0, 10);
}

function daysBetween(fromDate: string, toDate: string): number | null {
  const from = new Date(`${fromDate}T00:00:00.000Z`).getTime();
  const to = /^\d{4}-\d{2}-\d{2}$/.test(toDate)
    ? new Date(`${toDate}T00:00:00.000Z`).getTime()
    : new Date(toDate).getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.ceil((to - from) / DAY_MS);
}

function classifyTrend(sales7: number, sales30: number): { trend: SmartTransferDemandTrend; ratio: number | null } {
  if (sales30 < 3) return { trend: "insufficient_data", ratio: null };
  const prior23Sales = Math.max(0, sales30 - sales7);
  const recentRate = sales7 / 7;
  const priorRate = prior23Sales / 23;
  if (priorRate <= 0.01) {
    return recentRate > 0.15 ? { trend: "accelerating", ratio: null } : { trend: "stable", ratio: null };
  }
  const ratio = recentRate / priorRate;
  if (ratio >= 1.25) return { trend: "accelerating", ratio: roundNumber(ratio, 2) };
  if (ratio <= 0.75) return { trend: "declining", ratio: roundNumber(ratio, 2) };
  return { trend: "stable", ratio: roundNumber(ratio, 2) };
}

function calculateWeightedForecastRate(
  sales7: number,
  sales30: number,
  sales90: number,
  historicalLatestRate: number,
  historicalAverageRate: number
): SalesWindowMetrics {
  const rate7 = sales7 / 7;
  const rate30 = sales30 / 30;
  const rate90 = sales90 / 90;
  const { trend, ratio } = classifyTrend(sales7, sales30);

  let weight7 = 0.45;
  let weight30 = 0.35;
  let weight90 = 0.2;
  if (sales7 < 3) {
    weight7 = 0.25;
    weight30 = 0.45;
    weight90 = 0.3;
  }
  if (sales30 < 5) {
    weight7 = 0.15;
    weight30 = 0.35;
    weight90 = 0.5;
  }

  const windowRate = rate7 * weight7 + rate30 * weight30 + rate90 * weight90;
  const historicalRate = Math.max(0, historicalLatestRate || historicalAverageRate || 0);
  let forecastRate = windowRate * 0.85 + historicalRate * 0.15;
  if (trend === "accelerating") forecastRate *= 1.08;
  if (trend === "declining") forecastRate *= 0.92;

  return {
    sales7: roundNumber(sales7, 3),
    sales30: roundNumber(sales30, 3),
    sales90: roundNumber(sales90, 3),
    rate7: roundNumber(rate7, 3),
    rate30: roundNumber(rate30, 3),
    rate90: roundNumber(rate90, 3),
    forecastRate: roundNumber(Math.max(0, forecastRate), 3),
    trend,
    trendRatio: ratio,
  };
}

function otwReliabilityWeight(
  detail: OtwContainerDetail,
  asOfDate: string,
  daysUntilStockout: number | null,
  targetCoverageDays: number
): { weight: number; reliableBeforeStockout: boolean } {
  if (detail.matchType === "other") return { weight: 0, reliableBeforeStockout: false };

  const status = `${detail.trackingStatus ?? ""}`.toLowerCase();
  const appearsArrived = /arrived|discharged|offload|delivered|available for pickup/.test(status);
  if (appearsArrived) return { weight: 1, reliableBeforeStockout: true };

  const etaDays = detail.eta ? daysBetween(asOfDate, detail.eta) : null;
  const stockoutHorizon = daysUntilStockout === null ? targetCoverageDays : Math.max(0, daysUntilStockout);
  const arrivesBeforeStockout = etaDays !== null && etaDays >= 0 && etaDays <= stockoutHorizon;
  const overdueWithoutArrival = etaDays !== null && etaDays < -3;

  if (detail.matchType === "unknown") {
    if (overdueWithoutArrival) return { weight: 0.1, reliableBeforeStockout: false };
    if (arrivesBeforeStockout) return { weight: 0.35, reliableBeforeStockout: false };
    return { weight: 0.15, reliableBeforeStockout: false };
  }

  if (overdueWithoutArrival) return { weight: 0.2, reliableBeforeStockout: false };
  if (arrivesBeforeStockout) return { weight: 0.95, reliableBeforeStockout: true };
  if (etaDays !== null && etaDays <= targetCoverageDays) return { weight: 0.65, reliableBeforeStockout: false };
  return { weight: 0.25, reliableBeforeStockout: false };
}

function calculateOtwMetrics(
  details: OtwContainerDetail[],
  asOfDate: string,
  daysUntilStockout: number | null,
  targetCoverageDays: number
): OtwForecastMetrics {
  let rawQty = 0;
  let weightedQty = 0;
  let reliableBeforeStockoutQty = 0;

  for (const detail of details) {
    if (detail.matchType === "other") continue;
    const qty = Math.max(0, parseQuantity(detail.quantity));
    if (qty <= 0) continue;
    rawQty += qty;
    const reliability = otwReliabilityWeight(detail, asOfDate, daysUntilStockout, targetCoverageDays);
    weightedQty += qty * reliability.weight;
    if (reliability.reliableBeforeStockout) reliableBeforeStockoutQty += qty * reliability.weight;
  }

  return {
    rawQty: roundNumber(rawQty, 3),
    weightedQty: roundNumber(weightedQty, 3),
    reliableBeforeStockoutQty: roundNumber(reliableBeforeStockoutQty, 3),
    uncertainQty: roundNumber(Math.max(0, rawQty - weightedQty), 3),
  };
}

function stockoutUrgencyScore(daysUntilStockout: number | null, targetCoverageDays: number): number {
  if (daysUntilStockout === null) return 0;
  if (daysUntilStockout <= 3) return 25;
  if (daysUntilStockout <= 7) return 22;
  if (daysUntilStockout <= 14) return 18;
  if (daysUntilStockout <= 21) return 13;
  if (daysUntilStockout < targetCoverageDays) return 8;
  return 2;
}

function accelerationScore(trend: SmartTransferDemandTrend, ratio: number | null): number {
  if (trend === "accelerating") {
    if (ratio !== null && ratio >= 1.75) return 10;
    if (ratio !== null && ratio >= 1.4) return 9;
    return 8;
  }
  if (trend === "stable") return 5;
  if (trend === "declining") return 1;
  return 3;
}

function historicalSellThroughScore(line: SmartTransferPreviewLine): number {
  const sellThrough = clamp(line.overallSellThroughPercentage || 0, 0, 120);
  if (sellThrough >= 95) return 15;
  if (sellThrough >= 80) return 13;
  if (sellThrough >= 60) return 10;
  if (sellThrough >= 40) return 7;
  if (sellThrough > 0) return 4;
  return line.totalSalesSinceOlderTransfer > 0 ? 3 : 0;
}

function sourceAvailabilityScore(totalAvailable: number, calculatedNeed: number): number {
  if (calculatedNeed <= 0 || totalAvailable <= 0) return 0;
  const ratio = totalAvailable / calculatedNeed;
  if (ratio >= 1.5) return 10;
  if (ratio >= 1) return 8;
  if (ratio >= 0.75) return 6;
  if (ratio >= 0.5) return 4;
  return 2;
}

function otwTimingRiskScore(otw: OtwForecastMetrics): number {
  if (otw.rawQty <= 0) return 10;
  const reliableShare = otw.reliableBeforeStockoutQty / Math.max(1, otw.rawQty);
  const weightedShare = otw.weightedQty / Math.max(1, otw.rawQty);
  if (reliableShare >= 0.75) return 1;
  if (reliableShare >= 0.4) return 3;
  if (weightedShare >= 0.6) return 5;
  return 8;
}

function assortmentStrengthScore(line: SmartTransferPreviewLine): number {
  switch (line.classification) {
    case "strong_seller":
      return 5;
    case "good_seller":
      return 4;
    case "normal_seller":
      return 3;
    case "slow_seller":
      return 1;
    default:
      return 0;
  }
}

function dataQualityScore(sales90: number, line: SmartTransferPreviewLine): number {
  let score = 0;
  if (sales90 >= 20) score = 4;
  else if (sales90 >= 10) score = 3;
  else if (sales90 >= 3) score = 2;
  else if (sales90 > 0) score = 1;
  if (line.olderTransferQty > 0 && line.newerTransferQty > 0) score += 1;
  return Math.min(5, score);
}

function urgencyBand(score: number): SmartTransferUrgencyBand {
  if (score >= 80) return "critical";
  if (score >= 65) return "high";
  if (score >= 45) return "medium";
  return "low";
}

function historicalNeedFloor(
  line: SmartTransferPreviewLine,
  trend: SmartTransferDemandTrend,
  coverageIsAlreadyEnough: boolean
): number {
  if (coverageIsAlreadyEnough) return 0;
  let multiplier: number;
  switch (line.classification) {
    case "strong_seller":
      multiplier = 0.75;
      break;
    case "good_seller":
      multiplier = 0.6;
      break;
    case "normal_seller":
      multiplier = 0.4;
      break;
    case "slow_seller":
    default:
      multiplier = 0;
      break;
  }
  if (trend === "declining") multiplier *= 0.7;
  return wholeNonNegative(Math.ceil(line.calculatedNeed * multiplier));
}

function buildForecastReason(
  candidate: ForecastCandidate,
  source: SmartTransferSourceStock,
  sourceQty: number,
  itemTotal: number
): string {
  const score = candidate.itemScore;
  const urgency = candidate.urgencyBand.charAt(0).toUpperCase() + candidate.urgencyBand.slice(1);
  const stockoutText =
    candidate.daysUntilStockout === null
      ? "stockout timing unavailable"
      : `${roundNumber(candidate.daysUntilStockout, 1)} days of destination stock remain before weighted OTW`;
  const otwText =
    candidate.otw.rawQty > 0
      ? `${roundNumber(candidate.otw.rawQty, 0)} OTW recorded, ${roundNumber(candidate.otw.weightedQty, 0)} counted after ETA/shop reliability weighting`
      : "no destination OTW recorded";
  const trendText = candidate.sales.trend.replace("_", " ");

  return (
    [
      `Priority ${score}/100 (${urgency})`,
      `forecast ${roundNumber(candidate.sales.forecastRate, 2)}/day from 7/30/90-day sales (${roundNumber(candidate.sales.sales7, 0)}/${roundNumber(candidate.sales.sales30, 0)}/${roundNumber(candidate.sales.sales90, 0)})`,
      `trend ${trendText}`,
      stockoutText,
      otwText,
      `calculated need ${candidate.calculatedNeed}`,
      `${source.sourceLocationName} has ${source.availableQty} available after reserving ${source.reserveQty}`,
      `${sourceQty} allocated here (${itemTotal} total for this item)`,
    ].join("; ") + "."
  );
}

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
