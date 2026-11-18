// Extracted from ./smartTransferSourceOptimization.ts to keep that module under the source-size cap.
import type { SmartTransferForecastPreviewLine, SmartTransferForecastPreviewResult } from "./smartTransferForecasting";
import { roundNumber } from "./smartTransferPerformance";
import { parseMoneyInput } from "../lib/money";

export interface SmartTransferSourceOptimizationFields {
  sourceForecastDailyRate: number;
  sourceReserveDays: number;
  sourceDynamicReserveQty: number;
  sourcePendingCommitmentQty: number;
  sourceCoverageDaysAfterCommitments: number | null;
  sourceHistoricalRouteCount: number;
  sourceHistoricalRouteQty: number;
  sourceCanCoverWholeItem: boolean;
  sourceSelectionScore: number;
  sourceRank: number;
  sourceSelectionReason: string;
}

export type SmartTransferSourceOptimizedLine = SmartTransferForecastPreviewLine & SmartTransferSourceOptimizationFields;

export interface SmartTransferSourceOptimizedResult extends Omit<SmartTransferForecastPreviewResult, "lines"> {
  sourceOptimizationVersion: 2;
  lines: SmartTransferSourceOptimizedLine[];
}

interface SourceSalesMetrics {
  sales7: number;
  sales30: number;
  sales90: number;
  rate7: number;
  rate30: number;
  rate90: number;
  forecastRate: number;
}

export interface SourceCandidate {
  stockItemId: number;
  sourceLocationId: number;
  sourceLocationName: string;
  currentStock: number;
  averageRate: number;
  sales: SourceSalesMetrics;
  reserveDays: number;
  dynamicReserveQty: number;
  pendingCommitmentQty: number;
  availableQty: number;
  coverageDaysAfterCommitments: number | null;
  historicalRouteCount: number;
  historicalRouteQty: number;
  canCoverWholeItem: boolean;
  selectionScore: number;
  rank: number;
  selectionReason: string;
}

export function parseQuantity(value: unknown): number {
  const parsed = parseMoneyInput(String(value ?? "0"))?.toNumber() ?? NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

export function wholeNonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function isoDaysAgo(asOfDate: string, daysAgo: number): string {
  const date = new Date(`${asOfDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - Math.max(0, daysAgo));
  return date.toISOString().slice(0, 10);
}

export function calculateSourceSales(
  rows: Array<{ date: string; quantity: number }>,
  sevenDayStart: string,
  thirtyDayStart: string
): SourceSalesMetrics {
  const sales7 = rows.filter((row) => row.date >= sevenDayStart).reduce((sum, row) => sum + row.quantity, 0);
  const sales30 = rows.filter((row) => row.date >= thirtyDayStart).reduce((sum, row) => sum + row.quantity, 0);
  const sales90 = rows.reduce((sum, row) => sum + row.quantity, 0);
  const rate7 = sales7 / 7;
  const rate30 = sales30 / 30;
  const rate90 = sales90 / 90;

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

  let forecastRate = rate7 * weight7 + rate30 * weight30 + rate90 * weight90;
  const prior23Rate = Math.max(0, sales30 - sales7) / 23;
  if (prior23Rate > 0.01) {
    const trendRatio = rate7 / prior23Rate;
    if (trendRatio >= 1.25) forecastRate *= 1.08;
    if (trendRatio <= 0.75) forecastRate *= 0.92;
  }

  return {
    sales7: roundNumber(sales7, 3),
    sales30: roundNumber(sales30, 3),
    sales90: roundNumber(sales90, 3),
    rate7: roundNumber(rate7, 3),
    rate30: roundNumber(rate30, 3),
    rate90: roundNumber(rate90, 3),
    forecastRate: roundNumber(Math.max(0, forecastRate), 3),
  };
}

export function calculateReserveDays(sales: SourceSalesMetrics, targetCoverageDays: number): number {
  if (sales.forecastRate <= 0.02 && sales.sales90 < 2) return 0;
  if (sales.forecastRate >= 1 || sales.sales7 >= 7) {
    return Math.min(30, Math.max(14, Math.min(targetCoverageDays, 21)));
  }
  if (sales.forecastRate >= 0.25 || sales.sales30 >= 5) {
    return Math.min(21, Math.max(10, Math.ceil(targetCoverageDays * 0.67)));
  }
  return 7;
}

export function calculateReserveQty(currentStock: number, sales: SourceSalesMetrics, reserveDays: number): number {
  if (currentStock <= 0 || reserveDays <= 0) return 0;
  const baseReserve = Math.ceil(sales.forecastRate * reserveDays);
  const accelerationBuffer = Math.ceil(Math.max(0, sales.rate7 - sales.rate30) * 7);
  const minimumFloor = sales.sales90 > 0 ? 1 : 0;
  return Math.min(currentStock, Math.max(minimumFloor, baseReserve + accelerationBuffer));
}

export function calculateSourceScore(input: {
  currentStock: number;
  availableQty: number;
  pendingCommitmentQty: number;
  forecastRate: number;
  coverageDaysAfterCommitments: number | null;
  historicalRouteCount: number;
  historicalRouteQty: number;
  itemTotal: number;
}): number {
  const availableRatio = input.currentStock > 0 ? input.availableQty / input.currentStock : 0;
  let overstockScore = 0;
  if (availableRatio >= 0.6) overstockScore = 35;
  else if (availableRatio >= 0.4) overstockScore = 28;
  else if (availableRatio >= 0.25) overstockScore = 20;
  else if (availableRatio > 0) overstockScore = 10;

  let localProtectionScore = 0;
  if (input.forecastRate <= 0.02) localProtectionScore = 20;
  else if (input.coverageDaysAfterCommitments === null) localProtectionScore = 18;
  else if (input.coverageDaysAfterCommitments >= 60) localProtectionScore = 20;
  else if (input.coverageDaysAfterCommitments >= 30) localProtectionScore = 15;
  else if (input.coverageDaysAfterCommitments >= 21) localProtectionScore = 10;
  else if (input.coverageDaysAfterCommitments >= 14) localProtectionScore = 5;

  const routeScore = clamp(
    input.historicalRouteCount * 4 + Math.round(Math.log1p(input.historicalRouteQty) * 2),
    0,
    20
  );
  const wholeItemScore =
    input.availableQty >= input.itemTotal ? 15 : input.availableQty >= input.itemTotal * 0.5 ? 8 : 2;
  const pendingRatio = input.currentStock > 0 ? input.pendingCommitmentQty / input.currentStock : 0;
  const commitmentScore = pendingRatio <= 0 ? 10 : pendingRatio <= 0.1 ? 8 : pendingRatio <= 0.25 ? 5 : 1;

  return Math.round(
    clamp(overstockScore + localProtectionScore + routeScore + wholeItemScore + commitmentScore, 0, 100)
  );
}

export function buildSourceReason(source: Omit<SourceCandidate, "rank" | "selectionReason">): string {
  const coverageText =
    source.coverageDaysAfterCommitments === null
      ? "no meaningful local sales rate"
      : `${roundNumber(source.coverageDaysAfterCommitments, 1)} local coverage days before reserve`;
  const routeText =
    source.historicalRouteCount > 0
      ? `${source.historicalRouteCount} completed route transfer(s), ${roundNumber(source.historicalRouteQty, 0)} unit(s)`
      : "no recent completed route history";
  return (
    [
      `source score ${source.selectionScore}/100`,
      `stock ${source.currentStock}`,
      `pending commitments ${source.pendingCommitmentQty}`,
      `dynamic reserve ${source.dynamicReserveQty} for ${source.reserveDays} day(s)`,
      `available ${source.availableQty}`,
      coverageText,
      routeText,
      source.canCoverWholeItem ? "can fulfill the whole item quantity" : "used only if a split is required",
    ].join("; ") + "."
  );
}

export function allocateWithMinimumSplits(sources: SourceCandidate[], requested: number): Map<number, number> {
  const result = new Map<number, number>();
  const target = wholeNonNegative(requested);
  if (target <= 0) return result;

  const oneSource = sources.find((source) => source.availableQty >= target);
  if (oneSource) {
    result.set(oneSource.sourceLocationId, target);
    return result;
  }

  let remaining = target;
  for (const source of sources) {
    if (remaining <= 0) break;
    const quantity = Math.min(source.availableQty, remaining);
    if (quantity <= 0) continue;
    result.set(source.sourceLocationId, quantity);
    remaining -= quantity;
  }
  return result;
}
