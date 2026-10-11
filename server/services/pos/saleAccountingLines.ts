/**
 * Phase 22 (B): the lines of a POS sale voucher, in exact cents, shared by the
 * sale create and the sale edit. The voucher itself is posted through the
 * central engine (`postErpVoucherTx`); this module only decides the lines.
 *
 *   Normal ERP:        Dr payment (cash / bank / receivable) = total
 *                      Cr Sales Revenue                      = total
 *   Supplier partner:  Dr payment                            = total
 *                      Cr Supplier Cash Payable              = total − deduction
 *                      Cr Deduction Clearing                 = deduction (if any)
 *
 * A negative total (a return) swaps every side. The sale total is in USD; a
 * non-USD sale also carries its transaction amount (total × rate) per line.
 */
import Decimal from "decimal.js";
import { MoneyDecimal, toMoney, type MoneyInput } from "../../lib/money";
import type { ErpVoucherLine } from "../accounting/erpVoucherPosting";

export interface PosLineTarget {
  ledgerAccountId?: number | null;
  bankAccountId?: number | null;
  supplierId?: number | null;
  employeeId?: number | null;
  fixedAssetId?: number | null;
  customerId?: number | null;
}

export interface PosSaleLinesInput {
  grandTotal: MoneyInput;
  payment: PosLineTarget;
  paymentNarration: string;
  /** Normal ERP companies: the revenue line. */
  revenue?: { target: PosLineTarget; narration: string } | null;
  /** Supplier-partner companies: the payable split. */
  supplierPartner?: {
    payableAccountId: number;
    deductionClearingAccountId: number | null;
    quantitySold: MoneyInput;
    deductionPerQty: MoneyInput;
    payableNarration: string;
    deductionNarration: string;
  } | null;
  currency?: string | null;
  exchangeRate?: MoneyInput;
}

export class PosSaleDeductionError extends Error {
  constructor(deduction: Decimal, total: Decimal) {
    super(
      `Supplier payable deduction (${deduction.toFixed()}) exceeds the sale total (${total.toFixed()}). ` +
        `Adjust the deduction per qty setting on this location.`
    );
    this.name = "PosSaleDeductionError";
  }
}

function targetFields(target: PosLineTarget): PosLineTarget {
  const out: PosLineTarget = {};
  for (const key of [
    "ledgerAccountId",
    "bankAccountId",
    "supplierId",
    "employeeId",
    "fixedAssetId",
    "customerId",
  ] as const) {
    if (target[key] != null) out[key] = target[key];
  }
  return out;
}

export function posSaleLines(input: PosSaleLinesInput): ErpVoucherLine[] {
  const total = toMoney(input.grandTotal).toDecimalPlaces(2);
  const magnitude = total.abs();
  const isReturn = total.isNegative();
  const currency = (input.currency || "USD").toUpperCase();
  const rate = toMoney(input.exchangeRate);
  const foreign = currency !== "USD" && rate.gt(0);

  const line = (target: PosLineTarget, amount: Decimal, debitSide: boolean, narration: string): ErpVoucherLine => {
    const debit = debitSide !== isReturn;
    return {
      ...targetFields(target),
      debit: debit ? amount : 0,
      credit: debit ? 0 : amount,
      narration,
      transaction: foreign ? { currency, amount: amount.times(rate), rate } : null,
    };
  };

  const lines: ErpVoucherLine[] = [line(input.payment, magnitude, true, input.paymentNarration)];

  if (!input.supplierPartner) {
    if (!input.revenue) throw new Error("A POS sale needs a revenue line");
    lines.push(line(input.revenue.target, magnitude, false, input.revenue.narration));
    return lines;
  }

  const sp = input.supplierPartner;
  const deduction = toMoney(sp.quantitySold).times(toMoney(sp.deductionPerQty)).toDecimalPlaces(2);
  if (deduction.gt(magnitude)) throw new PosSaleDeductionError(deduction, total);
  // Without a clearing account the deduction stays in the payable (the old
  // writer left that voucher unbalanced, so the balance guard refused it).
  const postedDeduction = sp.deductionClearingAccountId ? deduction : new MoneyDecimal(0);
  const payable = magnitude.minus(postedDeduction);
  if (payable.gt(0)) lines.push(line({ ledgerAccountId: sp.payableAccountId }, payable, false, sp.payableNarration));
  if (postedDeduction.gt(0) && sp.deductionClearingAccountId) {
    lines.push(line({ ledgerAccountId: sp.deductionClearingAccountId }, postedDeduction, false, sp.deductionNarration));
  }
  return lines;
}
