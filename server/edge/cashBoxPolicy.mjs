/**
 * Owner-approved offline payments (2026-11-01): from the factory cash box
 * only, in USD, with no bank transfers and no supplier/customer payments.
 *
 * A Payment voucher takes money OUT of exactly one Cash-type ledger account
 * (its single credit line) to expense accounts; a Receipt puts money INTO
 * exactly one Cash-type account (its single debit line) from income
 * accounts. Every other line must be an expense (Payment) or income (Receipt)
 * ledger account, so payables, receivables, banks, stock, employees and
 * intercompany balances can never move offline.
 *
 * Pure: callers pass the voucher type, the sanitized entries and the current
 * account types from THEIR database (LAN at capture, cloud at apply).
 */
export const PHASE8_CASH_BOX_VOUCHER_TYPES = Object.freeze(["Payment", "Receipt"]);
const EXPENSE_TYPES = new Set(["Expense", "Direct Expense", "Indirect Expense"]);
const INCOME_TYPES = new Set(["Income", "Direct Income", "Indirect Income"]);

function nonZero(value) {
  return Number(value ?? 0) !== 0;
}

/** Returns null when allowed, otherwise a refusal code. */
export function phase8CashBoxRefusal(voucherType, entries, accountTypeById) {
  if (voucherType === "Journal") return null;
  if (!PHASE8_CASH_BOX_VOUCHER_TYPES.includes(voucherType)) return "PHASE8_UNSUPPORTED_VOUCHER_SHAPE";
  const payment = voucherType === "Payment";
  const counterTypes = payment ? EXPENSE_TYPES : INCOME_TYPES;
  let cashLines = 0;
  for (const entry of entries) {
    const type = accountTypeById.get(Number(entry.ledgerAccountId));
    if (type === undefined) return "PHASE8_LEDGER_TARGET_NOT_APPROVED";
    const debit = nonZero(entry.debitAmount);
    const credit = nonZero(entry.creditAmount);
    if (type === "Cash") {
      cashLines++;
      // Payment: cash goes out (credit). Receipt: cash comes in (debit).
      if (payment ? !credit || debit : !debit || credit) return "PHASE8_CASH_BOX_DIRECTION_INVALID";
    } else if (!counterTypes.has(type)) {
      return "PHASE8_CASH_BOX_COUNTER_ACCOUNT_NOT_APPROVED";
    } else if (payment ? !debit || credit : !credit || debit) {
      return "PHASE8_CASH_BOX_DIRECTION_INVALID";
    }
  }
  return cashLines === 1 ? null : "PHASE8_CASH_BOX_SINGLE_CASH_ACCOUNT_REQUIRED";
}
