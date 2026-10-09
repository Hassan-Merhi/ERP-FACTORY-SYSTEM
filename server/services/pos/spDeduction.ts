import { toMoney, type MoneyInput } from "../../lib/money";

/**
 * The Supplier Partner per-quantity payable deduction on a POS sale, in exact
 * cents. A float product rounded with toFixed(2) gave 3 x 1.115 = 3.34, not
 * 3.35, so the deduction and the payable it reduces could be a cent off.
 */
export function spDeductionAmount(quantitySold: MoneyInput, deductionPerQty: MoneyInput): number {
  return toMoney(quantitySold).times(toMoney(deductionPerQty)).toDecimalPlaces(2).toNumber();
}

/** The sale total in cents, rounded once from its exact decimal value. */
export function saleTotalCents(grandTotal: MoneyInput): number {
  return toMoney(grandTotal).toDecimalPlaces(2).toNumber();
}

/** The supplier payable left after the deduction: total minus deduction, exact. */
export function spPayableAfterDeduction(saleTotal: MoneyInput, deduction: MoneyInput): number {
  return toMoney(saleTotal).minus(toMoney(deduction)).toDecimalPlaces(2).toNumber();
}
