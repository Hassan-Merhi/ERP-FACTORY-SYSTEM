import { describe, expect, it } from "vitest";
import {
  previewHistoricalChargesPeriodNeutrality,
  type HistoricalClearingPeriodRow,
} from "../scripts/historical-charges-period-neutral-preflight";

const rows: HistoricalClearingPeriodRow[] = [
  {
    period: "2026-02", source: "FREIGHT", voucherCount: 16,
    clearingDebitUsd: "39948.90", clearingCreditUsd: "0.00",
    balancedTwoLineVoucherCount: 16, directSupplierCustomerBankLineCount: 0,
  },
  {
    period: "2026-03", source: "OC", voucherCount: 2,
    clearingDebitUsd: "1441.60", clearingCreditUsd: "0.00",
    balancedTwoLineVoucherCount: 2, directSupplierCustomerBankLineCount: 0,
  },
  {
    period: "2026-04", source: "POC", voucherCount: 1,
    clearingDebitUsd: "1230.00", clearingCreditUsd: "0.00",
    balancedTwoLineVoucherCount: 1, directSupplierCustomerBankLineCount: 0,
  },
];
const baseline = {
  currentAccountType: "Direct Expense",
  actualPostedDebitUsd: "42620.50",
  actualPostedCreditUsd: "0.00",
  expectedVoucherCount: 19,
};

describe("Historical factory clearing reconciliation is only a period-aware GL simulation", () => {
  it("distinguishes type-only P&L inflation from an illustrative neutral GL mapping", () => {
    const actual = previewHistoricalChargesPeriodNeutrality(rows, baseline);
    expect(actual.postedVoucherCount).toBe(19);
    expect(actual.postedClearingDebitsUsd).toBe("42620.50");
    expect(actual.hypotheticalExpenseDecreaseFromChangingTypeAloneUsd).toBe("42620.50");
    expect(actual.illustrativeCombinedPnlChangeUsd).toBe("0.00");
    expect(actual.periods[0].debitExpenseAccountCandidate).toBe("FACTORY_FREIGHT_EXPENSE");
    expect(actual.periods[1].debitExpenseAccountCandidate).toBe("FACTORY_OC_EXPENSE");
    expect(actual.periods[2].debitExpenseAccountCandidate).toBeNull();
    expect(actual.blockers).toContain("POST_OFFLOAD_CHARGES_REQUIRE_SOURCE_COST_CLASSIFICATION");
    expect(actual.readyToPost).toBe(false);
    expect(actual.approvedJournal).toBeNull();
    expect(actual.approvedAccountTypeChange).toBeNull();
  });
  it("fails closed when source totals or voucher counts do not reconcile", () => {
    const mismatched = previewHistoricalChargesPeriodNeutrality(rows, {
      ...baseline, actualPostedDebitUsd: "42620.51", expectedVoucherCount: 20,
    });
    expect(mismatched.blockers).toContain("POSTED_VOUCHER_TOTALS_DO_NOT_TIE_OUT");
    expect(mismatched.approvedJournal).toBeNull();
  });
  it("rejects unbalanced or party-linked original vouchers", () => {
    const changed = previewHistoricalChargesPeriodNeutrality([
      { ...rows[0], balancedTwoLineVoucherCount: 15, directSupplierCustomerBankLineCount: 1 },
    ], {
      ...baseline, actualPostedDebitUsd: "39948.90", expectedVoucherCount: 16,
    });
    expect(changed.blockers).toContain("SOURCE_JOURNAL_STRUCTURE_UNVERIFIED");
    expect(changed.readyToPost).toBe(false);
  });
  it("blocks account-type changes already made by another process", () => {
    const changed = previewHistoricalChargesPeriodNeutrality(rows, {
      ...baseline, currentAccountType: "Liability",
    });
    expect(changed.blockers).toContain("ACTUAL_ACCOUNT_TYPE_HAS_CHANGED");
    expect(changed.approvedAccountTypeChange).toBeNull();
  });
  it("rejects invalid business dates and credit legs", () => {
    const changed = previewHistoricalChargesPeriodNeutrality([
      { ...rows[0], period: "2026-13", clearingCreditUsd: "50.00" },
    ], { ...baseline, actualPostedDebitUsd: "39948.90", actualPostedCreditUsd: "50.00",
      expectedVoucherCount: 16 });
    expect(changed.blockers).toContain("INVALID_BUSINESS_PERIOD");
    expect(changed.blockers).toContain("SOURCE_CLEARING_CONTAINS_CREDIT_LEGS");
    expect(changed.readyToPost).toBe(false);
  });
});
