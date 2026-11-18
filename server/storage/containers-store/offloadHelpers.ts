// Extracted from ./offload.ts: shared helpers.
import type Decimal from "decimal.js";
import { toInventoryDecimal } from "../../lib/inventoryMath";

export function DecimalMax(value: Decimal.Value, minimum: Decimal.Value): Decimal {
  const decimalValue = toInventoryDecimal(value);
  const decimalMinimum = toInventoryDecimal(minimum);
  return decimalValue.greaterThan(decimalMinimum) ? decimalValue : decimalMinimum;
}
