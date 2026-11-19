// Extracted from ./purchaseOrderItemsUpdate.ts: shared helpers.
import { HttpError } from "../../lib/httpHandlers";
import type Decimal from "decimal.js";
import { MoneyDecimal, parseMoneyInput } from "../../lib/money";

/**
 * A request amount as an exact Decimal, read as parseFloat reads it. A blank
 * value is zero, as the edit form treats it; anything else that does not
 * parse is rejected, where it used to be written as NaN.
 */
export function amountInput(value: unknown): Decimal {
  if (typeof value === "string" && value.trim() === "") return new MoneyDecimal(0);
  const parsed = parseMoneyInput(value);
  if (!parsed) throw new HttpError(400, "Invalid amount");
  return parsed;
}

/** Cents as a numeric(…, 2) column stores them (half away from zero). */
export const cents = (value: Decimal) => value.toFixed(2);
