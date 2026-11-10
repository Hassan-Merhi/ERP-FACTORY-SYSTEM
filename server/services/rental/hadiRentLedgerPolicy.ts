
import type Decimal from "decimal.js";
import { MoneyDecimal, toMoney } from "../../lib/money";

export const HADI_LINKED_RENT = Object.freeze({
  payerCompanyId: 1,
  propertiesCompanyId: 13,
  payableLedgerId: 1021,
  prepaidLedgerId: 1022,
  expenseLedgerId: 1007,
});

export const HADI_HISTORICAL_ACCRUAL_GUARD = Object.freeze({
  code: "HADI_RENT_HISTORICAL_REPAIR_LOCKED",
  message:
    "HADI L'SHI historical rent has been reconciled in its original vouchers. " +
    "Use the read-only linked-rent reconciliation and an audited original-voucher correction; " +
    "automatic re-accrue/reversal would change verified rent balances.",
});

export function isHadiHistoricAccrualRepair(companyId: number, module: string): boolean {
  return companyId === HADI_LINKED_RENT.payerCompanyId && module === "ERP";
}

/** Keep overpayment as a separate credit, never reduce an unrelated month's due. */
export function positiveRentalDue(expected: string, paid: string): Decimal {
  return MoneyDecimal.max(0, toMoney(expected).minus(toMoney(paid))).toDecimalPlaces(2);
}

export function classifyHadiRentDifference(
  payableCredit: string,
  linkedOutstanding: string,
  ownedOutstanding: string,
  unmatchedPostedPayments: number
): { difference: string; status: "MATCH" | "REVIEW" } {
  const difference = toMoney(payableCredit)
    .minus(toMoney(linkedOutstanding))
    .minus(toMoney(ownedOutstanding))
    .toDecimalPlaces(2);
  return {
    difference: difference.toFixed(2),
    status: difference.abs().lte("0.005") && unmatchedPostedPayments === 0 ? "MATCH" : "REVIEW",
  };
}

/**
 * HADI L'SHI's linked Properties rent is expensed by a monthly accrual:
 *   Dr Rent Expense - ERP Shops (#1007), Cr Accrued Rent Payable (#1021).
 * Settlement of that accrued rent must NOT debit expense again:
 *   Dr Accrued Rent Payable (#1021), Cr owner's credit / settlement account.
 *
 * Historical journals #13386, #15110 and #16664 were misclassified this way.
 * Phase 2 repaired their original lines in place on 2026-11-10.
 *
 * Pure policy used by the ordinary ERP voucher-posting door. A new journal
 * exhibiting that same wrong combination refuses before any voucher is posted.
 * Existing vouchers, original amounts, prepaid #1022 and correct future accruals
 * are unaffected. Other companies' accounting behavior is unchanged.
 */
export const HADI_RENT_ACCOUNT_POLICY = Object.freeze({
  companyId: 1,
  rentExpenseAccountId: 1007,
  accruedRentPayableAccountId: 1021,
  prepaidRentAccountId: 1022,
  ownerCreditAccountId: 867,
  settlementAccountId: 1197,
});

export interface HadiVoucherPolicyEntry {
  ledgerAccountId?: number | null;
  debitAmount?: string | number | null;
  creditAmount?: string | number | null;
}

function positive(value: string | number | null | undefined): boolean {
  if (value === null || value === undefined || value === "") return false;
  const number = Number(value);
  return Number.isFinite(number) && number > 0;
}

/**
 * Only target the precise HADI historical mistake, not normal expense accruals:
 * - Dr #1007 / Cr #1021 is valid and is never blocked;
 * - Dr #1021 / Cr #867 or #1197 is a valid payable settlement;
 * - Dr #1007 / Cr #867 or #1197 duplicates the already accrued expense.
 *
 * Cannot be bypassed by choosing the manual Journal form instead of rental UI:
 * both use postErpEntriesTx for non-optional posted vouchers.
 */
export function isHadiDuplicateLinkedRentExpenseJournal(
  companyId: number,
  voucherType: string,
  entries: readonly HadiVoucherPolicyEntry[]
): boolean {
  if (companyId !== HADI_RENT_ACCOUNT_POLICY.companyId || voucherType !== "Journal") return false;
  const expenseDebit = entries.some(
    e => e.ledgerAccountId === HADI_RENT_ACCOUNT_POLICY.rentExpenseAccountId && positive(e.debitAmount)
  );
  const ownerOrSettlementCredit = entries.some(
    e =>
      (e.ledgerAccountId === HADI_RENT_ACCOUNT_POLICY.ownerCreditAccountId ||
        e.ledgerAccountId === HADI_RENT_ACCOUNT_POLICY.settlementAccountId) &&
      positive(e.creditAmount)
  );
  return expenseDebit && ownerOrSettlementCredit;
}
