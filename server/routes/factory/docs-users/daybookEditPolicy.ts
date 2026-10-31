import { MoneyDecimal, toMoney, type MoneyInput } from "../../../lib/money";

/**
 * Posting source types of the factory employee cash vouchers whose void moves
 * the employee balances back (the engine-numbered successors of EMP-DEP- /
 * EMP-WD- / EMP-PAY-; see employee-crud/cash.ts, bulk-withdraw.ts, bulk-payroll.ts).
 */
export const EMPLOYEE_CASH_POSTING_SOURCE_TYPES = [
  "factory-employee-deposit",
  "factory-employee-withdrawal",
  "factory-bulk-withdrawal",
  "factory-bulk-payroll",
];

/** A voucher's exchange rate; a missing, zero or unreadable one counts as 1. */
export const voucherFxRate = (rate: MoneyInput) => {
  const parsed = toMoney(rate || "1");
  return parsed.isZero() ? new MoneyDecimal(1) : parsed;
};
