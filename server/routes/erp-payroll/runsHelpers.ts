// Extracted from ./runs.ts
import type Decimal from "decimal.js";
import { MoneyDecimal, moneyString, parseMoneyInput, toMoney } from "../../lib/money";

type PayrollItemInput = {
  employeeId: number;
  employeeName: string;
  groupName?: string | null;
  baseSalary: unknown;
  deduction?: unknown;
  payrollDeduction?: unknown;
  netPay: unknown;
};

/**
 * A run item's amounts as the cents the numeric(…, 2) columns store, or null
 * when one does not parse. Unparsed amounts used to be written as 'NaN', which
 * Postgres numeric accepts and which then reached the payment voucher.
 */
function payrollItemAmounts(item: PayrollItemInput) {
  const baseSalary = parseMoneyInput(item.baseSalary);
  const deduction = parseMoneyInput(item.deduction || 0);
  const payrollDeduction = parseMoneyInput(item.payrollDeduction || 0);
  const netPay = parseMoneyInput(item.netPay);
  if (!baseSalary || !deduction || !payrollDeduction || !netPay) return null;
  return {
    baseSalary: moneyString(baseSalary),
    deduction: moneyString(deduction),
    payrollDeduction: moneyString(payrollDeduction),
    netPay: moneyString(netPay),
  };
}

/** Run items with exact amounts, or the first employee whose amounts do not parse. */
export function payrollItemRows(items: PayrollItemInput[], runId: number) {
  const rows = [];
  for (const it of items) {
    const amounts = payrollItemAmounts(it);
    if (!amounts) return { invalidEmployee: it.employeeName || `employee #${it.employeeId}` };
    rows.push({
      runId,
      employeeId: it.employeeId,
      employeeName: it.employeeName,
      groupName: it.groupName || null,
      ...amounts,
    });
  }
  return { rows };
}

/** The deduction a run item represents: the stored one, or for legacy rows base − advance deduction − net. */
export function payrollDeductionOf(item: {
  payrollDeduction: string | null;
  baseSalary: string | null;
  deduction: string | null;
  netPay: string | null;
}): Decimal {
  const stored = toMoney(item.payrollDeduction);
  const inferredLegacy = MoneyDecimal.max(
    0,
    toMoney(item.baseSalary).minus(toMoney(item.deduction)).minus(toMoney(item.netPay))
  );
  return stored.gt("0.005") ? stored : inferredLegacy;
}
