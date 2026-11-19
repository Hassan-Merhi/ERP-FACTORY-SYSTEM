// Extracted from ./smartTransferAllocation.ts to keep that module under the source-size cap.
import type { OtwContainerDetail } from "./stockTransferAnalysis";
import type { HistoricalTransferItemPerformance, SmartTransferHistoryResult } from "./smartTransferHistoryAnalysis";
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

export interface SmartTransferItemCandidate {
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

export function parseQuantity(value: unknown): number {
  const parsed = parseMoneyInput(String(value ?? "0"))?.toNumber() ?? NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

export function wholeNonNegative(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

export function uniquePositiveIds(values: number[] | undefined): number[] {
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

export function classificationPriority(classification: TransferPerformanceClassification): number {
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

export function classificationMultiplier(classification: TransferPerformanceClassification): number {
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

export function confidenceForPerformance(performance: HistoricalTransferItemPerformance): number {
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
