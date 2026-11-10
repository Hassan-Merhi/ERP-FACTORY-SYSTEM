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
