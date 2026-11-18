// Extracted from ./smartTransferForecasting.ts to keep that module under the source-size cap.
import type {
  SmartTransferPreviewLine,
  SmartTransferPreviewResult,
  SmartTransferSourceStock,
} from "./smartTransferAllocation";
import type { OtwContainerDetail } from "./stockTransferAnalysis";
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

export interface SalesWindowMetrics {
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

export interface OtwForecastMetrics {
  rawQty: number;
  weightedQty: number;
  reliableBeforeStockoutQty: number;
  uncertainQty: number;
}

export interface ForecastCandidate {
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

export function parseQuantity(value: unknown): number {
  const parsed = parseMoneyInput(String(value ?? "0"))?.toNumber() ?? NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

export function wholeNonNegative(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function isoDaysAgo(asOfDate: string, daysAgo: number): string {
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

export function calculateWeightedForecastRate(
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

export function calculateOtwMetrics(
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

export function stockoutUrgencyScore(daysUntilStockout: number | null, targetCoverageDays: number): number {
  if (daysUntilStockout === null) return 0;
  if (daysUntilStockout <= 3) return 25;
  if (daysUntilStockout <= 7) return 22;
  if (daysUntilStockout <= 14) return 18;
  if (daysUntilStockout <= 21) return 13;
  if (daysUntilStockout < targetCoverageDays) return 8;
  return 2;
}

export function accelerationScore(trend: SmartTransferDemandTrend, ratio: number | null): number {
  if (trend === "accelerating") {
    if (ratio !== null && ratio >= 1.75) return 10;
    if (ratio !== null && ratio >= 1.4) return 9;
    return 8;
  }
  if (trend === "stable") return 5;
  if (trend === "declining") return 1;
  return 3;
}

export function historicalSellThroughScore(line: SmartTransferPreviewLine): number {
  const sellThrough = clamp(line.overallSellThroughPercentage || 0, 0, 120);
  if (sellThrough >= 95) return 15;
  if (sellThrough >= 80) return 13;
  if (sellThrough >= 60) return 10;
  if (sellThrough >= 40) return 7;
  if (sellThrough > 0) return 4;
  return line.totalSalesSinceOlderTransfer > 0 ? 3 : 0;
}

export function sourceAvailabilityScore(totalAvailable: number, calculatedNeed: number): number {
  if (calculatedNeed <= 0 || totalAvailable <= 0) return 0;
  const ratio = totalAvailable / calculatedNeed;
  if (ratio >= 1.5) return 10;
  if (ratio >= 1) return 8;
  if (ratio >= 0.75) return 6;
  if (ratio >= 0.5) return 4;
  return 2;
}

export function otwTimingRiskScore(otw: OtwForecastMetrics): number {
  if (otw.rawQty <= 0) return 10;
  const reliableShare = otw.reliableBeforeStockoutQty / Math.max(1, otw.rawQty);
  const weightedShare = otw.weightedQty / Math.max(1, otw.rawQty);
  if (reliableShare >= 0.75) return 1;
  if (reliableShare >= 0.4) return 3;
  if (weightedShare >= 0.6) return 5;
  return 8;
}
