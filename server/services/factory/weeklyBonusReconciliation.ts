import Decimal from "decimal.js";

/** Exact posted-voucher and Factory Daybook checks, no automatic financial repairs. */
export interface WeeklyBonusLedgerRow {
  paymentId: number | string;
  companyId: number | string;
  workerId: number | string;
  weekStart: string;
  weekEnd: string;
  amount: string;
  status: string;
  paymentDate: string;
  cashAccountId: number | string;
  expenseAccountId: number | string;
  voucherId: number | string;
  reversalVoucherId: number | string | null;
  reviewId: number | string;
  reviewWorkerId: number | string;
  reviewWeekStart: string;
  reviewWeekEnd: string;
  reviewStatus: string;
  reviewAmount: string;
  expenseCode: string | null;
  expenseCompanyId: number | string | null;
  cashType: string | null;
  cashCompanyId: number | string | null;
  voucherCompanyId: number | string | null;
  voucherType: string | null;
  voucherCurrency: string | null;
  voucherDate: string | null;
  voucherDeleted: boolean;
  paymentExpenseDebit: string;
  paymentExpenseCredit: string;
  paymentCashDebit: string;
  paymentCashCredit: string;
  paymentTotalDebit: string;
  paymentTotalCredit: string;
  paymentLines: number | string;
  paymentDaybookCount: number | string;
  paymentDaybookUsd: string;
  paymentDaybookNative: string;
  reversalCompanyId: number | string | null;
  reversalType: string | null;
  reversalCurrency: string | null;
  reversalDate: string | null;
  reversalDeleted: boolean;
  reversalExpenseDebit: string;
  reversalExpenseCredit: string;
  reversalCashDebit: string;
  reversalCashCredit: string;
  reversalTotalDebit: string;
  reversalTotalCredit: string;
  reversalLines: number | string;
  reversalDaybookCount: number | string;
  reversalDaybookUsd: string;
  reversalDaybookNative: string;
}
export type WeeklyBonusReconciliationCode =
  | "REVIEW_MISMATCH" | "ACCOUNT_MISMATCH" | "PAYMENT_VOUCHER_MISMATCH"
  | "PAYMENT_LINES_MISMATCH" | "PAYMENT_DAYBOOK_MISMATCH"
  | "REVERSAL_VOUCHER_MISMATCH" | "REVERSAL_LINES_MISMATCH"
  | "REVERSAL_DAYBOOK_MISMATCH" | "INVALID_AMOUNT" | "INVALID_STATUS";

function exact(value: string | number): Decimal | null {
  try {
    const number = new Decimal(value);
    return number.isFinite() ? number.toDecimalPlaces(2) : null;
  } catch { return null; }
}
const same = (value: string | number, expected: Decimal): boolean => {
  const parsed = exact(value);
  return parsed !== null && parsed.eq(expected);
};
const equalId = (left: string | number | null, right: string | number | null): boolean =>
  left !== null && Number(left) === Number(right);

export function reconcileWeeklyBonusLedger(
  payment: WeeklyBonusLedgerRow,
): {paymentId: number; weekStart: string; workerId: number; status: string;
  amount: string; reconciled: boolean; issues: WeeklyBonusReconciliationCode[]} {
  const errors = new Set<WeeklyBonusReconciliationCode>();
  const amount = exact(payment.amount);
  if (!amount || !amount.gt(0) || amount.toFixed(2) !== payment.amount)
    errors.add("INVALID_AMOUNT");
  const expected = amount ?? new Decimal(0);
  if (payment.status !== "POSTED" && payment.status !== "REVERSED")
    errors.add("INVALID_STATUS");
  if (!equalId(payment.workerId,payment.reviewWorkerId) ||
      payment.weekStart!==payment.reviewWeekStart ||
      payment.weekEnd!==payment.reviewWeekEnd ||
      payment.reviewStatus!=="approved" ||
      !same(payment.reviewAmount,expected))
    errors.add("REVIEW_MISMATCH");
  if (payment.expenseCode!=="PAYROLL_DEPOSIT_EXPENSE" ||
      !equalId(payment.companyId,payment.expenseCompanyId) ||
      !equalId(payment.companyId,payment.cashCompanyId) ||
      !["Cash","Bank"].includes(payment.cashType??"") ||
      equalId(payment.cashAccountId,payment.expenseAccountId))
    errors.add("ACCOUNT_MISMATCH");
  if (!equalId(payment.companyId,payment.voucherCompanyId) ||
      payment.voucherType!=="Payment" ||
      payment.voucherCurrency!=="USD" || payment.voucherDate!==payment.paymentDate ||
      payment.voucherDeleted || !payment.voucherId)
    errors.add("PAYMENT_VOUCHER_MISMATCH");
  if (!same(payment.paymentExpenseDebit,expected) ||
      !same(payment.paymentExpenseCredit, new Decimal(0)) ||
      !same(payment.paymentCashDebit,new Decimal(0)) ||
      !same(payment.paymentCashCredit,expected) ||
      !same(payment.paymentTotalDebit,expected) ||
      !same(payment.paymentTotalCredit,expected) ||
      Number(payment.paymentLines)!==2)
    errors.add("PAYMENT_LINES_MISMATCH");
  if (Number(payment.paymentDaybookCount)!==1 ||
      !same(payment.paymentDaybookUsd,expected) ||
      !same(payment.paymentDaybookNative,expected))
    errors.add("PAYMENT_DAYBOOK_MISMATCH");
  if(payment.status==="POSTED"){
    if(payment.reversalVoucherId!==null ||
       Number(payment.reversalDaybookCount)!==0)
      errors.add("INVALID_STATUS");
  }else {
    if(!payment.reversalVoucherId ||
       !equalId(payment.companyId,payment.reversalCompanyId) ||
       payment.reversalType!=="Receipt" || payment.reversalCurrency!=="USD" ||
       !payment.reversalDate || payment.reversalDate<payment.paymentDate ||
       payment.reversalDeleted)
      errors.add("REVERSAL_VOUCHER_MISMATCH");
    if(!same(payment.reversalExpenseDebit,new Decimal(0)) ||
       !same(payment.reversalExpenseCredit,expected) ||
       !same(payment.reversalCashDebit,expected) ||
       !same(payment.reversalCashCredit,new Decimal(0)) ||
       !same(payment.reversalTotalDebit,expected) ||
       !same(payment.reversalTotalCredit,expected) ||
       Number(payment.reversalLines)!==2)
      errors.add("REVERSAL_LINES_MISMATCH");
    if(Number(payment.reversalDaybookCount)!==1 ||
       !same(payment.reversalDaybookUsd,new Decimal(0).minus(expected)) ||
       !same(payment.reversalDaybookNative,new Decimal(0).minus(expected)))
      errors.add("REVERSAL_DAYBOOK_MISMATCH");
  }
  return {
    paymentId:Number(payment.paymentId),weekStart:payment.weekStart,
    workerId:Number(payment.workerId),status:payment.status,
    amount:payment.amount,reconciled:errors.size===0,issues:[...errors],
  };
}
