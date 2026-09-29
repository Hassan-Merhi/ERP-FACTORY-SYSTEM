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
export function stockAdjustmentHeaderTotal(
  adjustmentType: string,
  items: StockAdjustmentTotalItem[]
): string {
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
