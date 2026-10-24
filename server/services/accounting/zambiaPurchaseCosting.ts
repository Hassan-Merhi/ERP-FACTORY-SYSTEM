/**
 * Phase 8: native ZMW purchase provenance and immutable historical USD valuation.
 * All existing PO/container/stock monetary columns remain USD cents.
 * No current-rate stock revaluation and no legacy CFA changes.
 */
import Decimal from "decimal.js";
import { HttpError } from "../../lib/httpError";
import { assertApprovedZmwVoucherRate } from "./zambiaVoucherRatePolicy";
import { isUnsupportedNativeZmwPurchase } from "./zambiaPurchaseCurrencyGuard";

const ZERO = "0";
const chargeNames = ["freight", "surcharge", "fumigation", "documentCharges", "discount", "otherCharges"] as const;
type ChargeName = (typeof chargeNames)[number];
export type NativePurchaseCharges = Partial<Record<ChargeName, string | number | null>>;

function nonNegative(value: unknown, field: string): Decimal {
  try {
    const amount = new Decimal(String(value == null || value === "" ? ZERO : value));
    if (!amount.isFinite() || amount.lt(0)) throw Error("negative or nonfinite");
    if (amount.decimalPlaces() > 2) throw Error("more than 2 decimal places");
    return amount;
  } catch {
    throw new HttpError(400, `${field} must be a nonnegative amount with at most two decimals`);
  }
}
function positiveQuantity(value: unknown): Decimal {
  try {
    const quantity = new Decimal(String(value));
    if (!quantity.isFinite() || quantity.lte(0) || quantity.decimalPlaces() > 3) throw Error("bad quantity");
    return quantity;
  } catch {
    throw new HttpError(400, "Purchase quantity must be positive with at most three decimals");
  }
}
const cents = (value: Decimal) => value.toDecimalPlaces(2).toFixed(2);
const usd = (native: Decimal, rate: Decimal) => cents(native.div(rate));

/** Convert one approved native charge at a persisted rate; never fetch current FX. */
export function historicalUsdFromNativeZmw(value: string | number | null | undefined, historicalRate: string): string {
  let rate: Decimal;
  try {
    rate = new Decimal(historicalRate);
  } catch {
    throw new HttpError(409, "Original ZMW purchase exchange rate is missing");
  }
  if (!rate.isFinite() || rate.lte(0)) throw new HttpError(409, "Original ZMW purchase exchange rate is invalid");
  return usd(nonNegative(value, "Native purchase charge"), rate);
}

export interface NativePurchaseLine {
  quantity: string | number;
  rate: string | number;
}

/** Require explicit supplied/approved historical FX before calculating anything. */
export async function prepareZmwPurchaseCost(input: {
  companyId: number;
  date: string;
  exchangeRate: string | number | null | undefined;
  lines: readonly NativePurchaseLine[];
  charges: NativePurchaseCharges;
}) {
  if (input.lines.length === 0) throw new HttpError(400, "A purchase requires at least one item");
  const historicalRate = await assertApprovedZmwVoucherRate(input.companyId, input.date, "ZMW", input.exchangeRate);
  if (!historicalRate) throw new HttpError(409, "Historical ZMW purchase rate unavailable");
  return valueZmwPurchaseAtLockedRate({
    date: input.date,
    historicalRate,
    lines: input.lines,
    charges: input.charges,
  });
}

/**
 * Edit/reversal valuation MUST use the stored transaction rate, not the latest
 * approved rate. Existing native amounts are never revalued at an edited
 * company rate.
 */
export function valueZmwPurchaseAtLockedRate(input: {
  date: string;
  historicalRate: string;
  lines: readonly NativePurchaseLine[];
  charges: NativePurchaseCharges;
}) {
  const historicalRate = input.historicalRate;
  if (input.lines.length === 0) throw new HttpError(400, "Purchase needs at least one line");
  let rate: Decimal;
  try {
    rate = new Decimal(historicalRate);
  } catch {
    throw new HttpError(409, "Historical purchase rate is invalid");
  }
  if (!rate.isFinite() || rate.lte(0)) throw new HttpError(409, "Historical purchase rate is invalid");
  const lines = input.lines.map((line) => {
    const quantity = positiveQuantity(line.quantity);
    const nativeRate = nonNegative(line.rate, "Native item price");
    const nativeLineTotal = new Decimal(cents(quantity.times(nativeRate)));
    return {
      quantity: quantity.toFixed(3),
      nativeRate: cents(nativeRate),
      nativeLineTotal: cents(nativeLineTotal),
      rate: usd(nativeRate, rate),
      lineTotal: usd(nativeLineTotal, rate),
    };
  });
  const nativeItemsTotal = lines.reduce((sum, line) => sum.plus(line.nativeLineTotal), new Decimal(0));
  const itemsTotal = lines.reduce((sum, line) => sum.plus(line.lineTotal), new Decimal(0));
  const originalCharges = {} as Record<ChargeName, string>;
  const baseCharges = {} as Record<ChargeName, string>;
  for (const key of chargeNames) {
    const nativeValue = nonNegative(input.charges[key], key);
    originalCharges[key] = cents(nativeValue);
    baseCharges[key] = usd(nativeValue, rate);
  }
  const nativeChargesTotal = chargeNames.reduce(
    (sum, key) => (key === "discount" ? sum.minus(originalCharges[key]) : sum.plus(originalCharges[key])),
    new Decimal(0)
  );
  const baseChargesTotal = chargeNames.reduce(
    (sum, key) => (key === "discount" ? sum.minus(baseCharges[key]) : sum.plus(baseCharges[key])),
    new Decimal(0)
  );
  return {
    historicalExchangeRate: historicalRate,
    historicalRateDate: input.date,
    nativeItemsTotal: cents(nativeItemsTotal),
    nativeLineCount: lines.length,
    nativeFreight: originalCharges.freight,
    nativeSurcharge: originalCharges.surcharge,
    nativeFumigation: originalCharges.fumigation,
    nativeDocumentCharges: originalCharges.documentCharges,
    nativeDiscount: originalCharges.discount,
    nativeOtherCharges: originalCharges.otherCharges,
    itemsTotal: cents(itemsTotal),
    freight: baseCharges.freight,
    surcharge: baseCharges.surcharge,
    fumigation: baseCharges.fumigation,
    documentCharges: baseCharges.documentCharges,
    discount: baseCharges.discount,
    otherCharges: baseCharges.otherCharges,
    chargesTotal: cents(baseChargesTotal),
    grandTotal: cents(itemsTotal.plus(baseChargesTotal)),
    nativeGrandTotal: cents(nativeItemsTotal.plus(nativeChargesTotal)),
    lines,
  };
}

/**
 * Called by generic PO storage before its transaction, so no ZMW cost can be
 * accepted with missing metadata or mismatched company-approved rate.
 */
export async function assertPreparedZmwPurchaseCost(
  input: {
    companyId: number;
    currency?: string | null;
    historicalExchangeRate?: string | null;
    historicalRateDate?: string | null;
    nativeItemsTotal?: string | null;
    nativeLineCount?: number | null;
    itemsTotal?: string | null;
    [key: string]: unknown;
  },
  voucherDate?: string
): Promise<void> {
  if (!isUnsupportedNativeZmwPurchase(input.currency)) return;
  if (
    !input.historicalRateDate ||
    input.historicalRateDate !== voucherDate ||
    !input.historicalExchangeRate ||
    input.nativeItemsTotal == null
  ) {
    throw new HttpError(409, "Native Kwacha PO needs original amounts, voucher date and a locked historical rate");
  }
  const rate = await assertApprovedZmwVoucherRate(
    input.companyId,
    input.historicalRateDate,
    "ZMW",
    input.historicalExchangeRate
  );
  if (!rate) throw new HttpError(409, "Historical ZMW PO rate is unavailable");
  if (
    !Number.isSafeInteger(input.nativeLineCount) ||
    Number(input.nativeLineCount) <= 0 ||
    Number(input.nativeLineCount) > 10000
  ) {
    throw new HttpError(409, "Original native purchase line count is missing");
  }
  const required = [
    "nativeFreight",
    "nativeSurcharge",
    "nativeFumigation",
    "nativeDocumentCharges",
    "nativeDiscount",
    "nativeOtherCharges",
  ];
  if (required.some((key) => input[key] == null)) {
    throw new HttpError(409, "Original ZMW PO charges are missing");
  }
  // Sum of individually rounded base lines can legitimately differ from
  // converting the whole native total, but cannot drift arbitrarily.
  const original = nonNegative(input.nativeItemsTotal, "Original items total");
  const base = nonNegative(input.itemsTotal, "USD items total");
  const expected = original.div(new Decimal(rate));
  const tolerance = new Decimal("0.005").times(input.nativeLineCount!).plus("0.005");
  // Every USD line is rounded independently to cents; any larger variance
  // indicates an incorrect conversion or a Kwacha-as-USD financial value.
  const linkedCharges: Array<[string, string]> = [
    ["nativeFreight", "freight"],
    ["nativeSurcharge", "surcharge"],
    ["nativeFumigation", "fumigation"],
    ["nativeDocumentCharges", "documentCharges"],
    ["nativeDiscount", "discount"],
    ["nativeOtherCharges", "otherCharges"],
  ];
  for (const [nativeField, baseField] of linkedCharges) {
    const originalCharge = nonNegative(input[nativeField], nativeField);
    const usdCharge = nonNegative(input[baseField], baseField);
    if (usdCharge.minus(originalCharge.div(rate)).abs().gt("0.05")) {
      throw new HttpError(409, "Historical USD charge is inconsistent with the native Kwacha amount");
    }
  }
  if (base.minus(expected).abs().gt(tolerance)) {
    throw new HttpError(409, "USD inventory cost does not reconcile to original Kwacha purchase amount");
  }
}
