/**
 * Company 12 / October 2026: supplier and named-creditor balance freeze.
 *
 * The historical backfill already ran. An --apply replay must NEVER create a
 * replacement source voucher merely because an original was retired.
 *
 * For proposed historical GL cleanup, the gate is deliberately stricter than
 * "no factory_supplier_id lines": supplier/creditor positions may be held in
 * named ledger accounts (e.g. WALMDACLE). Reject all party, liability,
 * balance-sheet and unknown-code legs; an expense-only reclassification can
 * be reviewed but is NOT proof of lower TOTAL expenses. No posting mechanism.
 */
import Decimal from "decimal.js";

export function assertHistoricalSupplierBackfillFrozen(apply: boolean): void {
  if (apply) {
    throw new Error(
      "HISTORICAL_SUPPLIER_BALANCES_FROZEN: Company-12 Oct-14 goods and " +
      "commission vouchers are already posted. Never re-run this backfill " +
      "with --apply. Supplier balances, openings, memos, payments and all " +
      "named creditor GL accounts are protected. Run the private read-only " +
      "historical supplier audit instead."
    );
  }
}

export type HistoricalCorrectionAccountKind =
  | "ledger" | "factory_supplier" | "supplier" | "customer" | "bank" | "cash" | "other_party";

export interface HistoricalCorrectionLinePreview {
  accountKind: HistoricalCorrectionAccountKind;
  accountCode?: string | null;
  accountType?: string | null;
  debitUsd: string;
  creditUsd: string;
}

export function inspectHistoricalCorrectionBalanceProtection(lines: HistoricalCorrectionLinePreview[]) {
  const issues: string[] = [];
  const ZERO = new Decimal(0);
  let dr = ZERO, cr = ZERO;
  for (const line of lines) {
    let debit: Decimal, credit: Decimal;
    try {
      debit = new Decimal(line.debitUsd);
      credit = new Decimal(line.creditUsd);
      if (!debit.isFinite() || !credit.isFinite()) throw new Error("nonfinite");
    } catch {
      issues.push("INVALID_JOURNAL_AMOUNT");
      continue;
    }
    if (debit.lt(0) || credit.lt(0) || (debit.gt(0) && credit.gt(0))) {
      issues.push("INVALID_DEBIT_CREDIT_LINE");
    }
    dr = dr.plus(debit);
    cr = cr.plus(credit);
    if (line.accountKind !== "ledger") {
      issues.push("PROTECTED_PARTY_CASH_OR_BANK_LINE");
      continue;
    }
    const code = (line.accountCode ?? "").trim().toUpperCase();
    const type = (line.accountType ?? "").trim().toUpperCase();
    if (!code || !type) {
      issues.push("UNVERIFIED_LEDGER_ACCOUNT_IDENTITY");
      continue;
    }
    if (type !== "DIRECT EXPENSE" && type !== "INDIRECT EXPENSE" && type !== "EXPENSE") {
      issues.push("PROTECTED_BALANCE_SHEET_OR_OTHER_LEDGER");
    }
    // Defensive against a chart account that was misclassified as Expense;
    // do not trust accountType for a known liability code.
    if (code === "WALMDACLE" || code.includes("PAYABLE") ||
        code.includes("SUPPLIER") || code.includes("CREDITOR")) {
      issues.push("PROTECTED_NAMED_CREDITOR_LEDGER");
    }
  }
  if (lines.length < 2) issues.push("NOT_A_COMPLETE_BALANCED_JOURNAL");
  if (!dr.eq(cr)) issues.push("JOURNAL_NOT_BALANCED");
  // No independently verified asset / prior-period expense evidence. This
  // must remain unapproved even for a balanced expense-only categorization.
  issues.push("HISTORICAL_EXPENSE_RECOGNITION_NOT_PROVEN");
  issues.push("NO_APPROVED_COUNTERPART_ACCOUNT_OR_PERIOD");
  return {
    policy: "SUPPLIER_AND_NAMED_CREDITOR_BALANCES_IMMUTABLE",
    issues: [...new Set(issues)],
    previewTotalDebitUsd: dr.toFixed(2),
    previewTotalCreditUsd: cr.toFixed(2),
    sourceSupplierPartyBalanceDeltaUsd: null,
    namedCreditorLedgerDeltaUsd: null,
    approvedExpenseOverstatementUsd: null,
    approvedJournal: null,
    canPost: false,
  };
}
