// Extracted from ./inventoryHistoryHelpers.ts to keep that module under the source-size cap.
import type Decimal from "decimal.js";
import { MoneyDecimal, toMoney } from "../../lib/money";

// TEMP DEBUG (historical opening-stock audit): gate behind an explicit env
// flag so routine exports/inventory reads stay quiet by default. Enable with
// DEBUG_HISTORICAL_INVENTORY=1 when auditing an opening-stock discrepancy.
export const DEBUG_HISTORICAL_INVENTORY = process.env.DEBUG_HISTORICAL_INVENTORY === "1";

/**
 * The value a movement line moved, unsigned: the sub-ledger value it recorded
 * (`value_moved`, wave 11) when present, else the line's stored total, else
 * quantity × rate. value_moved is read as an amount whatever sign the writer
 * gave it; the caller applies the direction.
 */
export function exactMovementValue(
  exactTotal: string | number | null | undefined,
  quantity: Decimal,
  fallbackRate: Decimal,
  valueMoved?: string | number | null
): Decimal {
  if (valueMoved !== null && valueMoved !== undefined && valueMoved !== "") {
    const moved = toMoney(valueMoved);
    if (moved.isFinite()) return moved.abs();
  }
  if (exactTotal !== null && exactTotal !== undefined && exactTotal !== "") {
    try {
      const parsed = new MoneyDecimal(exactTotal);
      if (parsed.isFinite()) return parsed.abs();
    } catch {
      // Not a number: fall back to quantity x rate below.
    }
  }
  return quantity.times(fallbackRate).abs();
}

export type HistoricalStock = { quantity: Decimal; totalValue: Decimal; rate: number };

export function emptyHistoricalStock(): HistoricalStock {
  return { quantity: new MoneyDecimal(0), totalValue: new MoneyDecimal(0), rate: 0 };
}

/** Moves a stock item's reconstructed quantity and value, then refreshes its rate. */
export function applyHistoricalMovement(
  inventoryMap: Map<number, HistoricalStock>,
  stockItemId: number,
  quantity: Decimal,
  value: Decimal
): void {
  const existing = inventoryMap.get(stockItemId) ?? emptyHistoricalStock();
  existing.quantity = existing.quantity.plus(quantity);
  existing.totalValue = existing.totalValue.plus(value);
  if (existing.quantity.greaterThan(0) && existing.totalValue.greaterThan(0)) {
    existing.rate = existing.totalValue.dividedBy(existing.quantity).toNumber();
  }
  inventoryMap.set(stockItemId, existing);
}

/** Plain decimal text; zero is always "0", never "-0". */
export function plainNumber(value: Decimal): string {
  return value.isZero() ? "0" : value.toFixed();
}

export type HistoricalLocationInventoryRow = {
  stockItemId: number;
  quantity: string;
  averageRate: string;
  totalValue: string;
  stockItemCode: string;
  stockItemName: string;
  stockItemUom: string;
  stockGroupId: number | null;
  stockGroupName: string;
  stockGroupCode: string;
  categoryId: number | null;
  categoryName: string | null;
  stockItemActive: boolean;
};
