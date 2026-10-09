/**
 * Retail Wave 2 stock-count line math (Track D).
 *
 * Kept pure and separate so the counting rules can be unit-tested without a database:
 * line status, scan/manual quantity updates, and the movement delta used at finalize.
 */

export type RetailStockCountLineStatusValue = "uncounted" | "counted" | "variance" | "unexpected";

export type RetailStockCountEntryModeValue = "increment" | "set";

export interface RetailStockCountSummaryLine {
  expectedQuantity: number;
  countedQuantity: number | null;
}

export interface RetailStockCountSummary {
  lineCount: number;
  countedLineCount: number;
  uncountedLineCount: number;
  varianceLineCount: number;
  unexpectedLineCount: number;
  expectedQuantityTotal: number;
  countedQuantityTotal: number;
  varianceQuantityTotal: number;
  absoluteVarianceQuantity: number;
}

export const RETAIL_STOCK_COUNT_EPSILON = 0.000001;

export function computeRetailStockCountLineStatus(
  expectedQuantity: number,
  countedQuantity: number | null
): RetailStockCountLineStatusValue {
  if (countedQuantity === null || countedQuantity === undefined) return "uncounted";
  if (expectedQuantity <= RETAIL_STOCK_COUNT_EPSILON && countedQuantity > RETAIL_STOCK_COUNT_EPSILON)
    return "unexpected";
  if (Math.abs(countedQuantity - expectedQuantity) <= RETAIL_STOCK_COUNT_EPSILON) return "counted";
  return "variance";
}

export function nextRetailStockCountQuantity(
  previous: number | null,
  quantity: number,
  mode: RetailStockCountEntryModeValue
): number {
  const value = Number(quantity);
  if (!Number.isFinite(value) || value < 0) throw new Error("Counted quantity cannot be negative");
  if (mode === "set") {
    return value <= 0 ? 0 : value;
  }
  if (value <= 0) throw new Error("An increment must be greater than zero");
  const base = previous === null || previous === undefined ? 0 : Number(previous);
  return Math.max(0, base + value);
}

export function summarizeRetailStockCountLines(lines: RetailStockCountSummaryLine[]): RetailStockCountSummary {
  const summary: RetailStockCountSummary = {
    lineCount: lines.length,
    countedLineCount: 0,
    uncountedLineCount: 0,
    varianceLineCount: 0,
    unexpectedLineCount: 0,
    expectedQuantityTotal: 0,
    countedQuantityTotal: 0,
    varianceQuantityTotal: 0,
    absoluteVarianceQuantity: 0,
  };
  for (const line of lines) {
    summary.expectedQuantityTotal += Number(line.expectedQuantity ?? 0);
    if (line.countedQuantity === null || line.countedQuantity === undefined) {
      summary.uncountedLineCount += 1;
      continue;
    }
    summary.countedLineCount += 1;
    summary.countedQuantityTotal += Number(line.countedQuantity);
    const difference = Number(line.countedQuantity) - Number(line.expectedQuantity ?? 0);
    summary.varianceQuantityTotal += difference;
    summary.absoluteVarianceQuantity += Math.abs(difference);
    const status = computeRetailStockCountLineStatus(Number(line.expectedQuantity ?? 0), Number(line.countedQuantity));
    if (status === "unexpected") summary.unexpectedLineCount += 1;
    if (status === "variance") summary.varianceLineCount += 1;
  }
  return summary;
}

export interface RetailStockCountFinalizeLineResult {
  /** counted − snapshot: the number the report shows as the count variance. */
  varianceQuantity: number;
  /** counted − live stock: what the inventory adjustment must write. */
  movementDelta: number;
  /** Inventory after the adjustment (equal to the counted quantity). */
  finalQuantity: number;
  needsMovement: boolean;
}

/**
 * Finalize math for one counted line.
 *
 * The movement delta is `counted − live` (not `counted − expected`) so a POS sale that
 * happened while the count was open is preserved: stock becomes the counted quantity and
 * the snapshot still explains the reported variance.
 */
export function finalizeRetailStockCountLine(input: {
  expectedQuantity: number;
  countedQuantity: number;
  liveQuantity: number;
}): RetailStockCountFinalizeLineResult {
  const counted = Number(input.countedQuantity);
  if (!Number.isFinite(counted) || counted < 0) throw new Error("Counted quantity cannot be negative");
  const expected = Number(input.expectedQuantity ?? 0);
  const live = Number(input.liveQuantity ?? 0);
  const movementDelta = counted - live;
  return {
    varianceQuantity: counted - expected,
    movementDelta,
    finalQuantity: counted,
    needsMovement: Math.abs(movementDelta) > RETAIL_STOCK_COUNT_EPSILON,
  };
}

/** `SC-000123`, stable per company and human-readable on the count sheet. */
export function formatRetailStockCountCode(id: number): string {
  return `SC-${String(id).padStart(6, "0")}`;
}
