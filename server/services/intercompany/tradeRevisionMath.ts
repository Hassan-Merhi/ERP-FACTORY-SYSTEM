import { MoneyDecimal, toMoney, sumMoney } from "../../lib/money";
import type { ErpVoucherLine } from "../accounting/erpVoucherPosting";

export type FinancialTarget = { ledgerAccountId: number } | { supplierId: number };

export const cents = (value: string | number): MoneyDecimal =>
  toMoney(value).toDecimalPlaces(2, MoneyDecimal.ROUND_HALF_UP);

export function exactPositiveQuantity(value: string): MoneyDecimal {
  const qty = toMoney(value);
  if (!qty.isFinite() || qty.lte(0) || qty.decimalPlaces() > 3 || qty.gte("10000000000")) {
    throw new Error("PO quantity must be positive with at most 3 decimals");
  }
  return qty;
}

export function exactNonnegativeRate(value: string): MoneyDecimal {
  const rate = toMoney(value);
  if (!rate.isFinite() || rate.lt(0) || rate.decimalPlaces() > 2 || rate.gte("10000000000")) {
    throw new Error("PO rate must be non-negative with at most 2 decimals");
  }
  return rate;
}

export function lineTotal(quantity: string, rate: string): MoneyDecimal {
  return exactPositiveQuantity(quantity).times(exactNonnegativeRate(rate))
    .toDecimalPlaces(2, MoneyDecimal.ROUND_HALF_UP);
}

export function fullPoCost(po: {
  itemsTotal: string | null;
  freight: string | null;
  surcharge: string | null;
  fumigation: string | null;
  documentCharges: string | null;
  discount: string | null;
  otherCharges: string | null;
}): MoneyDecimal {
  return sumMoney([
    po.itemsTotal, po.freight, po.surcharge, po.fumigation, po.documentCharges, po.otherCharges,
  ]).minus(toMoney(po.discount)).toDecimalPlaces(2);
}

/** Append-only journal delta: a decrease reverses both sides; no mutation of historical vouchers. */
export function signedPair(
  positiveDebit: FinancialTarget,
  positiveCredit: FinancialTarget,
  signedAmount: MoneyDecimal,
  narration: string
): ErpVoucherLine[] {
  const amount = cents(signedAmount);
  if (amount.isZero()) return [];
  const absolute = amount.abs().toFixed(2);
  if (amount.gt(0)) {
    return [
      { ...positiveDebit, debit: absolute, narration },
      { ...positiveCredit, credit: absolute, narration },
    ];
  }
  return [
    { ...positiveCredit, debit: absolute, narration: "Reversal: " + narration },
    { ...positiveDebit, credit: absolute, narration: "Reversal: " + narration },
  ];
}

/** Cent-exact deterministic weight allocation; final row absorbs the rounding remainder. */
export function allocateByWeights(total: MoneyDecimal, weights: readonly MoneyDecimal[]): MoneyDecimal[] {
  if (!weights.length || weights.some(w => w.lt(0)) || sumMoney(weights).lte(0)) {
    throw new Error("Confirmed charge requires positive eligible purchase weights");
  }
  if (!total.isFinite() || total.lt(0) || total.decimalPlaces() > 2) {
    throw new Error("Confirmed charge must be a non-negative USD amount in cents");
  }
  const denominator = sumMoney(weights);
  let remainder = cents(total);
  return weights.map((weight, index) => {
    const portion = index === weights.length - 1
      ? remainder
      : cents(total.times(weight).div(denominator));
    if (portion.gt(remainder)) throw new Error("Invalid proportional charge rounding");
    remainder = remainder.minus(portion);
    return portion;
  });
}

export function requireCostEqual(label: string, actual: MoneyDecimal, expected: MoneyDecimal) {
  if (!actual.eq(expected)) throw new Error(
    label + " does not reconcile (" + actual.toFixed(2) + " versus " + expected.toFixed(2) + ")"
  );
}
