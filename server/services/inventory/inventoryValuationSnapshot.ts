type NumericInventoryValue = string | number | null | undefined;

export interface InventoryValuationSnapshot {
  quantity: number;
  totalValue: number;
  rate: number;
}

export interface InventoryValuationReconciliation {
  asOfMonth: number;
  liveQty: number;
  liveValue: number;
  liveRate: number;
  derivedQty: number;
  derivedValue: number;
  derivedRate: number;
  quantityDelta: number;
  valueDelta: number;
  inSync: boolean;
}

const QUANTITY_TOLERANCE = 0.0005;
const VALUE_TOLERANCE = 0.01;

function finiteNumber(value: NumericInventoryValue): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Build a live inventory valuation from the stored asset value.
 *
 * inventory.total_value is the authoritative amount. average_rate is a rounded
 * cost-memory field and is used only if an older row has no usable total_value.
 */
export function inventorySnapshotFromStoredValues(
  quantity: NumericInventoryValue,
  totalValue: NumericInventoryValue,
  averageRate: NumericInventoryValue
): InventoryValuationSnapshot {
  const parsedQuantity = finiteNumber(quantity) ?? 0;
  const storedValue = finiteNumber(totalValue);
  const storedRate = Math.max(finiteNumber(averageRate) ?? 0, 0);

  if (parsedQuantity <= 0) {
    return {
      quantity: parsedQuantity,
      totalValue: 0,
      rate: storedRate,
    };
  }

  const resolvedValue = Math.max(storedValue ?? parsedQuantity * storedRate, 0);
  const resolvedRate = resolvedValue > 0 ? resolvedValue / parsedQuantity : storedRate;

  return {
    quantity: parsedQuantity,
    totalValue: resolvedValue,
    rate: resolvedRate,
  };
}

export function buildInventoryValuationReconciliation(
  asOfMonth: number,
  live: InventoryValuationSnapshot,
  derived: InventoryValuationSnapshot
): InventoryValuationReconciliation {
  const quantityDelta = live.quantity - derived.quantity;
  const valueDelta = live.totalValue - derived.totalValue;

  return {
    asOfMonth,
    liveQty: live.quantity,
    liveValue: live.totalValue,
    liveRate: live.rate,
    derivedQty: derived.quantity,
    derivedValue: derived.totalValue,
    derivedRate: derived.rate,
    quantityDelta,
    valueDelta,
    inSync: Math.abs(quantityDelta) <= QUANTITY_TOLERANCE && Math.abs(valueDelta) <= VALUE_TOLERANCE,
  };
}
