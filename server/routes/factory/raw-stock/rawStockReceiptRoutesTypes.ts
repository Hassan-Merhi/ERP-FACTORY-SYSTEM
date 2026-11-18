// Extracted from ./rawStockReceiptRoutes.ts to keep that module under the source-size cap.
import type Decimal from "decimal.js";
import { MoneyDecimal, toMoney } from "../../../lib/money";

export const ZERO = new MoneyDecimal(0);

/** A stored amount, or zero when it is missing or not a number. */
export const amountOrZero = (value: unknown) => toMoney(value as string | null);

export type SupplierStock = {
  supplierName: string;
  supplierId: number | null;
  categoryId: number | null;
  categoryName: string | null;
  sourceType: string;
  currencyCode: string;
  _totalReceived: Decimal;
  _totalUsed: Decimal;
  _avgCostPerKg: Decimal;
  _avgCostPerKgUsd: Decimal;
  _remainingValueLocal: Decimal;
  _remainingValueUsd: Decimal;
  lastOffloaded: unknown;
  _adjustmentIds?: number[];
};

/**
 * Usage not tied to a specific container draws the supplier's remaining stock
 * down at that stock's current blended cost/kg.
 */
export function drawDown(stock: SupplierStock, kg: Decimal) {
  const remainingKgBefore = stock._totalReceived.minus(stock._totalUsed);
  const avgCostBefore = remainingKgBefore.gt(0) ? stock._remainingValueUsd.div(remainingKgBefore) : ZERO;
  const avgCostLocalBefore = remainingKgBefore.gt(0) ? stock._remainingValueLocal.div(remainingKgBefore) : ZERO;
  stock._totalUsed = stock._totalUsed.plus(kg);
  stock._remainingValueUsd = stock._remainingValueUsd.minus(kg.times(avgCostBefore));
  stock._remainingValueLocal = stock._remainingValueLocal.minus(kg.times(avgCostLocalBefore));
}
