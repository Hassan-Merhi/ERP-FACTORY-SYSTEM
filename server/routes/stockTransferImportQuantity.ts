/**
 * Quantity parsing for the stock-transfer import routes, kept beside them so
 * the route file stays under the repository's size cap.
 */
import type Decimal from "decimal.js";
import { MoneyDecimal, parseMoneyInput } from "../lib/money";

/** A request quantity read as parseFloat read it; NaN (as a Decimal) when it does not parse. */
export type { Decimal };

export function requestQuantity(value: unknown): Decimal {
  return parseMoneyInput(typeof value === "number" ? value : String(value)) ?? new MoneyDecimal(NaN);
}

/**
 * The Quantity column of an imported row. A quantity that does not parse is
 * read as 0 (invalid); it used to pass the checks as NaN.
 */
export function rowQuantity(row: Record<string, unknown>): number {
  return parseMoneyInput(String(row.Quantity || row.quantity || row.Qty || row.qty || "0"))?.toNumber() ?? 0;
}
