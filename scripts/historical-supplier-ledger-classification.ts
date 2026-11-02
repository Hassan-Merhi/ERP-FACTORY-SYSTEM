/**
 * Evidence-only classifier for company-12 factory ledger account mapping.
 * This module is NOT an accounting repair or an account-type migration.
 */
export const FACTORY_ACCOUNT_TYPE_EXPECTATIONS = Object.freeze({
  FACTORY_CHARGES_PAYABLE: "Liability",
  FACTORY_RAW_MATERIAL_STOCK: "Asset",
} as const);

export type FactoryAccountAuditRow = {
  code: string;
  name: string;
  accountType: string;
  debitUsd: string;
  creditUsd: string;
  voucherCount: number;
  postedLineCount: number;
};

export function inspectFactoryAccountType(row: FactoryAccountAuditRow) {
  const expected = FACTORY_ACCOUNT_TYPE_EXPECTATIONS[
    row.code as keyof typeof FACTORY_ACCOUNT_TYPE_EXPECTATIONS
  ] ?? null;
  const mismatch = expected !== null &&
    row.accountType.trim().toUpperCase() !== expected.toUpperCase();
  return {
    code: row.code,
    accountName: row.name,
    currentType: row.accountType,
    expectedType: expected,
    mismatch,
    currentPostedDebitUsd: row.debitUsd,
    currentPostedCreditUsd: row.creditUsd,
    postedVoucherCount: row.voucherCount,
    postedLineCount: row.postedLineCount,
    proposedAccountTypeChange: null,
    proposedVoucherCorrection: null,
    accountReviewStatus: mismatch
      ? "MISMATCH_REQUIRES_ENTRY_BY_ENTRY_REVIEW"
      : "TYPE_MATCHES_EXPECTATION",
    safetyNotes: [
      "Historical posted debit-minus-credit is not the expense overstatement amount.",
      "Account type changes alter P&L and balance-sheet classification even without journal writes.",
      "Supplier, customer, stock quantity and journal lines must not be modified by this audit.",
    ],
  };
}
