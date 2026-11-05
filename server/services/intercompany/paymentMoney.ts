import type Decimal from "decimal.js";
import { MoneyDecimal, sumMoney } from "../../lib/money";

/** Currency convention: number of transaction units for one USD. */
export type PaymentCurrency = "USD" | "CFA" | "ZMW";
const AMOUNT_PATTERN = /^\d+(?:\.\d{1,2})?$/;
const RATE_PATTERN = /^\d+(?:\.\d{1,10})?$/;
export function paymentMoney(value: string): Decimal {
  if (typeof value !== "string" || !AMOUNT_PATTERN.test(value))
    throw new Error("Transaction amount must be an exact nonnegative number with at most 2 decimals");
  const amount = new MoneyDecimal(value);
  if (!amount.isFinite() || amount.lte(0) || amount.gte("1000000000000"))
    throw new Error("Transaction amount must be positive and within safe range");
  return amount;
}
export function paymentHistoricalRate(currency: PaymentCurrency, value: string): Decimal {
  if (!["USD", "CFA", "ZMW"].includes(currency)) throw new Error("Unsupported transaction currency");
  if (typeof value !== "string" || !RATE_PATTERN.test(value))
    throw new Error("Historical FX rate must have at most 10 decimals");
  const rate = new MoneyDecimal(value);
  if (!rate.isFinite() || rate.lte(0) || rate.gte("1000000000000")) throw new Error("Invalid historical FX rate");
  if (currency === "USD" && !rate.eq(1)) throw new Error("USD payment must use an identity FX rate");
  return rate;
}
export function paymentBaseAmount(currency: PaymentCurrency, native: string, rate: string): Decimal {
  const amount = paymentMoney(native),
    fx = paymentHistoricalRate(currency, rate);
  const base = amount.div(fx).toDecimalPlaces(2, MoneyDecimal.ROUND_HALF_UP);
  if (!base.gt(0)) throw new Error("Actual payment converts to less than one US cent");
  return base;
}
export type CreditPayment = { id: number; available: Decimal };
export type PaymentAllocationPlan = { paymentId: number; amount: Decimal };
/** Deterministic oldest-first credit usage; does not post any new cash or GL vouchers. */
export function oldestAvailableCredits(payments: readonly CreditPayment[], due: Decimal): PaymentAllocationPlan[] {
  if (due.lt(0) || due.decimalPlaces() > 2) throw new Error("PO credit allocation budget must be cent-exact");
  let remaining = due;
  const result: PaymentAllocationPlan[] = [];
  for (const payment of payments) {
    if (payment.available.lt(0) || payment.available.decimalPlaces() > 2)
      throw new Error("Unreconciled payment credit balance");
    const use = MoneyDecimal.min(payment.available, remaining);
    if (use.gt(0)) {
      result.push({ paymentId: payment.id, amount: use });
      remaining = remaining.minus(use);
    }
    if (remaining.isZero()) break;
  }
  return result;
}
export function exactManualAllocation(
  amount: Decimal,
  parts: readonly Decimal[],
  outstanding: readonly Decimal[]
): void {
  if (parts.length !== outstanding.length) throw new Error("Payment PO allocation list mismatch");
  if (parts.some((part, i) => part.lt(0) || part.decimalPlaces() > 2 || part.gt(outstanding[i]))) {
    throw new Error("Manual allocation exceeds an individual PO's confirmed unpaid amount");
  }
  if (sumMoney(parts).gt(amount))
    throw new Error("Manual allocation exceeds confirmed payment; overage must remain credit");
}
export function pairCreditBalance(paymentTotal: Decimal, activeAllocations: readonly Decimal[]): Decimal {
  const remaining = paymentTotal.minus(sumMoney(activeAllocations));
  if (remaining.lt(0) || remaining.decimalPlaces() > 2) throw new Error("Payment credit ledger does not reconcile");
  return remaining;
}
