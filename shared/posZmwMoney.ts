/**
 * Zambia POS transaction-currency totals. Preserve the two-decimal Kwacha
 * price entered by the cashier; USD is a translated accounting value, never
 * the source from which an invoice total is reconstructed.
 */
import Decimal from "decimal.js";

export interface ZmwSaleLine {
  quantity: unknown;
  rate?: unknown;
  sellingPrice?: unknown;
  originalCurrencyRate?: unknown;
}

function decimal(value: unknown, label: string): Decimal {
  const parsed = new Decimal(String(value ?? ""));
  if (!parsed.isFinite()) throw new Error(`Invalid ${label}`);
  return parsed;
}

export function resolveZmwUnitPrice(line: ZmwSaleLine, historicalRate: string | number, allowReconstruction = false): Decimal {
  const rate = decimal(historicalRate, "USD/ZMW rate");
  if (!rate.gt(0)) throw new Error("A positive USD/ZMW rate is required");
  const supplied = line.originalCurrencyRate;
  if (supplied === null || supplied === undefined || supplied === "") {
    if (!allowReconstruction) throw new Error("The original Kwacha unit price is required");
    const usd = decimal(line.rate ?? line.sellingPrice, "USD unit price");
    if (!usd.gt(0)) throw new Error("USD unit price must be positive");
    // Existing sale_items persist six-decimal USD unit prices; reconstruct the
    // nearest ngwee using the voucher's LOCKED rate, never the current rate.
    const native = usd.times(rate).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    if (!native.gt(0)) throw new Error("Converted Kwacha unit price must be positive");
    return native;
  }
  const native = decimal(supplied, "Kwacha unit price");
  if (!native.gt(0) || native.decimalPlaces() > 2) {
    throw new Error("Kwacha unit prices must be positive and have at most two decimals");
  }
  return native;
}

export function calculateZmwSaleAmounts(
  lines: readonly ZmwSaleLine[],
  historicalRate: string | number,
  allowReconstruction = false
): { nativeTotal: string; usdTotal: number } {
  const rate = decimal(historicalRate, "USD/ZMW rate");
  if (!rate.gt(0)) throw new Error("A positive USD/ZMW rate is required");
  if (!lines.length) throw new Error("A Kwacha sale must contain items");
  let nativeTotal = new Decimal(0);
  for (const [index, line] of lines.entries()) {
    const quantity = decimal(line.quantity, `quantity on line ${index + 1}`);
    if (!quantity.gt(0)) throw new Error("Sale quantities must be positive");
    const unit = resolveZmwUnitPrice(line, historicalRate, allowReconstruction);
    // Round each native line to ngwee, THEN sum. Do not round USD per line and
    // multiply the rounded USD sum by the rate to recreate a native amount.
    nativeTotal = nativeTotal.plus(quantity.times(unit).toDecimalPlaces(2, Decimal.ROUND_HALF_UP));
  }
  if (!nativeTotal.gt(0)) throw new Error("Kwacha sale total must be positive");
  const usdTotal = nativeTotal.div(rate).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  return { nativeTotal: nativeTotal.toFixed(2), usdTotal: usdTotal.toNumber() };
}
