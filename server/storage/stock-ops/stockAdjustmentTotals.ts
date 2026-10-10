import type Decimal from "decimal.js";

import {
  addInventoryValues,
  inventoryMoney,
  subtractInventoryValues,
  toInventoryDecimal,
} from "../../lib/inventoryMath";

export type StockAdjustmentTotalItem = {
  quantity: string | null;
  totalAmount: string | null;
};

/**
 * Derive the voucher header from the values that were actually persisted on the
 * stock-adjustment lines. Consumption lines can be re-costed by the storage
 * layer, so submitted qty × rate is not authoritative.
 */
export function stockAdjustmentHeaderTotal(adjustmentType: string, items: StockAdjustmentTotalItem[]): string {
  const isMixed = adjustmentType.trim().toLowerCase() === "mixed";
  let total = toInventoryDecimal(0);

  for (const item of items) {
    const amount = toInventoryDecimal(item.totalAmount ?? 0).abs();
    if (isMixed && !toInventoryDecimal(item.quantity ?? 0).isPositive()) {
      total = subtractInventoryValues(total, amount);
    } else {
      total = addInventoryValues(total, amount);
    }
  }

  return inventoryMoney(total);
}

/**
 * The ledger line of a periodic stock adjustment: production credits
 * STOCK_ADJUSTMENT, consumption debits it. Both use the same account, so a
 * Mixed adjustment posts the net on one line (wave 12): a two-sided stock
 * voucher must balance, and these two lines never did. Returns null when the
 * net is zero.
 */
export function stockAdjustmentNetLine(
  productionValue: Decimal,
  consumptionValue: Decimal,
  adjustmentType: string
): { debitAmount: string; creditAmount: string; narration: string } | null {
  const net = productionValue.minus(consumptionValue);
  if (net.isZero()) return null;
  return net.isPositive()
    ? {
        debitAmount: "0",
        creditAmount: inventoryMoney(net),
        narration: `Production adjustment - ${adjustmentType} voucher`,
      }
    : {
        debitAmount: inventoryMoney(net.negated()),
        creditAmount: "0",
        narration: `Consumption expense - ${adjustmentType} voucher`,
      };
}
