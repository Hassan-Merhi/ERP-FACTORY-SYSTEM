import { describe, expect, it } from "vitest";
import {
  assertHistoricalSupplierBackfillFrozen,
  inspectHistoricalCorrectionBalanceProtection,
  type HistoricalCorrectionLinePreview,
} from "../scripts/historical-supplier-balance-freeze";
import { previewCharge64CreditorImpact } from "../scripts/historical-charge64-creditor-impact-preview";

const expense: HistoricalCorrectionLinePreview = {
  accountKind: "ledger", accountCode: "FACTORY_FREIGHT_EXPENSE",
  accountType: "Direct Expense", debitUsd: "1692.96", creditUsd: "0",
};
const clearing: HistoricalCorrectionLinePreview = {
  accountKind: "ledger", accountCode: "FACTORY_CHARGES_PAYABLE",
  accountType: "Direct Expense", debitUsd: "0", creditUsd: "1692.96",
};

describe("Historical supplier and creditor balance freeze", () => {
  it("rejects a replay before any October-2026 supplier postings", () => {
    expect(() => assertHistoricalSupplierBackfillFrozen(true))
      .toThrow("HISTORICAL_SUPPLIER_BALANCES_FROZEN");
    expect(() => assertHistoricalSupplierBackfillFrozen(false)).not.toThrow();
  });
  it("blocks all supplier-party adjustments, even if they balance as a voucher", () => {
    const check = inspectHistoricalCorrectionBalanceProtection([
      { accountKind: "factory_supplier", debitUsd: "1692.96", creditUsd: "0" },
      clearing,
    ]);
    expect(check.issues).toContain("PROTECTED_PARTY_CASH_OR_BANK_LINE");
    expect(check.canPost).toBe(false);
    expect(check.approvedJournal).toBeNull();
  });
  it("blocks WALMDACLE and other creditor balances irrespective of source party fields", () => {
    const check = inspectHistoricalCorrectionBalanceProtection([
      { accountKind: "ledger", accountCode: "WALMDACLE", accountType: "Liability", debitUsd: "1692.96", creditUsd: "0" },
      clearing,
    ]);
    expect(check.issues).toContain("PROTECTED_NAMED_CREDITOR_LEDGER");
    expect(check.issues).toContain("PROTECTED_BALANCE_SHEET_OR_OTHER_LEDGER");
    expect(check.previewTotalDebitUsd).toBe("1692.96");
    expect(check.previewTotalCreditUsd).toBe("1692.96");
    expect(check.namedCreditorLedgerDeltaUsd).toBeNull();
    expect(check.canPost).toBe(false);
  });
  it("rejects an invented inventory debit as a way to hide expenses", () => {
    const check = inspectHistoricalCorrectionBalanceProtection([
      { accountKind: "ledger", accountCode: "FACTORY_RAW_MATERIAL_STOCK", accountType: "Asset", debitUsd: "1692.96", creditUsd: "0" },
      clearing,
    ]);
    expect(check.issues).toContain("PROTECTED_BALANCE_SHEET_OR_OTHER_LEDGER");
    expect(check.approvedExpenseOverstatementUsd).toBeNull();
    expect(check.canPost).toBe(false);
  });
  it("balanced expense-only reclassification has no verified P&L correction", () => {
    const check = inspectHistoricalCorrectionBalanceProtection([expense, clearing]);
    expect(check.issues).toContain("HISTORICAL_EXPENSE_RECOGNITION_NOT_PROVEN");
    expect(check.issues).toContain("PROTECTED_NAMED_CREDITOR_LEDGER");
    expect(check.canPost).toBe(false);
  });
  it("rejects an unbalanced or zero-line proposal", () => {
    const check = inspectHistoricalCorrectionBalanceProtection([expense]);
    expect(check.issues).toContain("JOURNAL_NOT_BALANCED");
    expect(check.issues).toContain("NOT_A_COMPLETE_BALANCED_JOURNAL");
    expect(check.canPost).toBe(false);
  });
  it("rejects unaudited missing ledger identities", () => {
    const check = inspectHistoricalCorrectionBalanceProtection([
      { accountKind: "ledger", debitUsd: "5.00", creditUsd: "0" },
      { accountKind: "ledger", accountCode: "EXP", accountType: "Expense", debitUsd: "0", creditUsd: "5.00" },
    ]);
    expect(check.issues).toContain("UNVERIFIED_LEDGER_ACCOUNT_IDENTITY");
    expect(check.canPost).toBe(false);
  });
  it("is impossible for a non-finite or negative proposal to bypass the gate", () => {
    const invalid = inspectHistoricalCorrectionBalanceProtection([
      { ...expense, debitUsd: "NaN" }, { ...clearing, creditUsd: "-1" },
    ]);
    expect(invalid.issues).toContain("INVALID_JOURNAL_AMOUNT");
    expect(invalid.issues).toContain("INVALID_DEBIT_CREDIT_LINE");
    expect(invalid.canPost).toBe(false);
  });
});
