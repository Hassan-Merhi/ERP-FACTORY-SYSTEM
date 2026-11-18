/**
 * Zambia POS transaction-currency totals. Preserve the two-decimal Kwacha
 * price entered by the cashier; USD is a translated accounting value, never
 * the source from which an invoice total is reconstructed.
 */
import Decimal from "decimal.js";

/** Human-readable Zambia validation messages, kept in one place for translation. */
export const zmwAmountErrorMessages = {
  invalid: (label: string) => `Invalid ${label}`,
  rateRequired: "A positive USD/ZMW rate is required",
  originalPriceRequired: "The original Kwacha unit price is required",
  usdPriceRequired: "USD unit price must be positive",
  convertedPriceRequired: "Converted Kwacha unit price must be positive",
  unitPrecision: "Kwacha unit prices must be positive and have at most two decimals",
  noItems: "A Kwacha sale must contain items",
  quantityRequired: "Sale quantities must be positive",
  totalRequired: "Kwacha sale total must be positive",
} as const;

export interface ZmwSaleLine {
  quantity: unknown;
  rate?: unknown;
  sellingPrice?: unknown;
  originalCurrencyRate?: unknown;
}

function decimal(value: unknown, label: string): Decimal {
  const parsed = new Decimal(String(value ?? ""));
  if (!parsed.isFinite()) throw new Error(zmwAmountErrorMessages.invalid(label));
  return parsed;
}

/**
 * Older sales stored the USD unit price rounded to cents, so K2,000 at 20.8
 * was saved as $96.15 and read back as K1,999.92. Every Kwacha price inside
 * that cent's rounding window gives the same stored USD price; when the window
 * holds a whole-Kwacha price, that is the price the cashier typed. Six-decimal
 * prices (how sales are stored now) are already exact and are left alone.
 */
function legacyWholeKwachaPrice(usd: Decimal, rate: Decimal): Decimal | null {
  if (usd.decimalPlaces() > 2) return null;
  const whole = usd.times(rate).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  if (!whole.gt(0)) return null;
  return whole.div(rate).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).eq(usd) ? whole : null;
}

export function resolveZmwUnitPrice(
  line: ZmwSaleLine,
  historicalRate: string | number,
  allowReconstruction = false
): Decimal {
  const rate = decimal(historicalRate, "USD/ZMW rate");
  if (!rate.gt(0)) throw new Error(zmwAmountErrorMessages.rateRequired);
  const supplied = line.originalCurrencyRate;
  if (supplied === null || supplied === undefined || supplied === "") {
    if (!allowReconstruction) throw new Error(zmwAmountErrorMessages.originalPriceRequired);
    const usd = decimal(line.rate ?? line.sellingPrice, "USD unit price");
    if (!usd.gt(0)) throw new Error(zmwAmountErrorMessages.usdPriceRequired);
    // Reconstruct at the voucher's LOCKED rate, never the current rate.
    const native = legacyWholeKwachaPrice(usd, rate) ?? usd.times(rate).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    if (!native.gt(0)) throw new Error(zmwAmountErrorMessages.convertedPriceRequired);
    return native;
  }
  const native = decimal(supplied, "Kwacha unit price");
  if (!native.gt(0) || native.decimalPlaces() > 2) {
    throw new Error(zmwAmountErrorMessages.unitPrecision);
  }
  return native;
}

export function calculateZmwSaleAmounts(
  lines: readonly ZmwSaleLine[],
  historicalRate: string | number,
  allowReconstruction = false
): { nativeTotal: string; usdTotal: number } {
  const rate = decimal(historicalRate, "USD/ZMW rate");
  if (!rate.gt(0)) throw new Error(zmwAmountErrorMessages.rateRequired);
  if (!lines.length) throw new Error(zmwAmountErrorMessages.noItems);
  let nativeTotal = new Decimal(0);
  for (const [index, line] of lines.entries()) {
    const quantity = decimal(line.quantity, `quantity on line ${index + 1}`);
    if (!quantity.gt(0)) throw new Error(zmwAmountErrorMessages.quantityRequired);
    const unit = resolveZmwUnitPrice(line, historicalRate, allowReconstruction);
    // Round each native line to ngwee, THEN sum. Do not round USD per line and
    // multiply the rounded USD sum by the rate to recreate a native amount.
    nativeTotal = nativeTotal.plus(quantity.times(unit).toDecimalPlaces(2, Decimal.ROUND_HALF_UP));
  }
  if (!nativeTotal.gt(0)) throw new Error(zmwAmountErrorMessages.totalRequired);
  const usdTotal = nativeTotal.div(rate).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  return { nativeTotal: nativeTotal.toFixed(2), usdTotal: usdTotal.toNumber() };
}
