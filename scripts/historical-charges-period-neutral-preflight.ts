/**
 * Strictly diagnostic company-12 historical factory clearing account preflight.
 *
 * A type-only change of a large debit expense account to Liability inflates
 * apparent profit while creating an unexplained debit liability. This module
 * models the neutralizing GL-only journal concept, but never posts it, supplies
 * no approved accounting classification, and no operation accepts --apply.
 */
import Decimal from "decimal.js";

export type ChargeSource = "FREIGHT" | "OC" | "POC";

export interface HistoricalClearingPeriodRow {
  period: string; // YYYY-MM of the existing voucher's effective business date
  source: ChargeSource;
  voucherCount: number;
  clearingDebitUsd: string;
  clearingCreditUsd: string;
  balancedTwoLineVoucherCount: number;
  directSupplierCustomerBankLineCount: number;
}

const decimal = (value: string | number) => new Decimal(value);
const dollar = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
const zero = () => new Decimal(0);
export function previewHistoricalChargesPeriodNeutrality(
  rows: HistoricalClearingPeriodRow[],
  options: {
    currentAccountType: string;
    actualPostedDebitUsd: string;
    actualPostedCreditUsd: string;
    expectedVoucherCount: number;
  }
) {
  let postedDebits = zero(), postedCredits = zero();
  let postedVouchers = 0;
  const blockers: string[] = [];
  const periods = rows.map((row) => {
    const dr = decimal(row.clearingDebitUsd);
    const cr = decimal(row.clearingCreditUsd);
    postedDebits = postedDebits.plus(dr);
    postedCredits = postedCredits.plus(cr);
    postedVouchers += row.voucherCount;
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(row.period)) blockers.push("INVALID_BUSINESS_PERIOD");
    if (dr.isNegative() || cr.isNegative()) blockers.push("NEGATIVE_CLEARING_AMOUNT");
    if (row.balancedTwoLineVoucherCount !== row.voucherCount ||
        row.directSupplierCustomerBankLineCount !== 0) blockers.push("SOURCE_JOURNAL_STRUCTURE_UNVERIFIED");
    const target = row.source === "FREIGHT" ? "FACTORY_FREIGHT_EXPENSE"
      : row.source === "OC" ? "FACTORY_OC_EXPENSE" : null;
    if (target === null) blockers.push("POST_OFFLOAD_CHARGES_REQUIRE_SOURCE_COST_CLASSIFICATION");
    if (!cr.isZero()) blockers.push("SOURCE_CLEARING_CONTAINS_CREDIT_LEGS");
    return {
      ...row,
      debitExpenseAccountCandidate: target,
      illustrativeExpenseDebitUsd: dollar(dr),
      illustrativeClearingCreditUsd: dollar(dr),
      illustrativeSamePeriodPnlDeltaUsd: "0.00",
      requiresPeriodSpecificEvidenceAndApproval: true,
      approvedJournal: null,
    };
  });
  if (options.currentAccountType.trim().toUpperCase() !== "DIRECT EXPENSE") {
    blockers.push("ACTUAL_ACCOUNT_TYPE_HAS_CHANGED");
  }
  if (postedVouchers !== options.expectedVoucherCount ||
      !postedDebits.eq(decimal(options.actualPostedDebitUsd)) ||
      !postedCredits.eq(decimal(options.actualPostedCreditUsd))) {
    blockers.push("POSTED_VOUCHER_TOTALS_DO_NOT_TIE_OUT");
  }
  if (rows.length === 0) blockers.push("NO_SOURCE_PERIODS");
  return {
    status: "SIMULATION_ONLY_NOT_APPROVED",
    postedVoucherCount: postedVouchers,
    postedClearingDebitsUsd: dollar(postedDebits),
    postedClearingCreditsUsd: dollar(postedCredits),
    hypotheticalExpenseDecreaseFromChangingTypeAloneUsd: dollar(postedDebits.minus(postedCredits)),
    hypotheticalExpenseIncreaseFromEqualExpenseReclassUsd: dollar(postedDebits.minus(postedCredits)),
    illustrativeCombinedPnlChangeUsd: "0.00",
    note: "A type-only conversion cannot be performed: it would remove existing expenses from profit-and-loss. The equal GL expense replacement is only a mathematical illustration and must be independently proven by business source and period.",
    periods,
    blockers: [...new Set([...blockers, "HISTORICAL_EXPENSE_ACCOUNT_MAPPING_NOT_APPROVED",
      "PERIOD_POSTING_AND_PRIOR_CLOSES_NOT_VERIFIED"])],
    changesToSuppliersUsd: "0.00",
    changesToStockQty: false,
    approvedJournal: null,
    approvedAccountTypeChange: null,
    readyToPost: false,
  };
}
