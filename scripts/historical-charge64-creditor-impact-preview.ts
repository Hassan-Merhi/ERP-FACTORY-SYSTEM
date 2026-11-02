/**
 * Company-12 charge #64: immutable, nonposting accounting counterfactual.
 * The historical credit to WALMDACLE is a real named-creditor ledger leg.
 * Reversing this charge changes that creditor's debit/credit position even
 * though it has no factory_supplier_id or supplier_id voucher-entry lines.
 */
import Decimal from "decimal.js";
import { inspectHistoricalCorrectionBalanceProtection } from "./historical-supplier-balance-freeze";

export interface Charge64CreditorImpactInput {
  creditorAccountCode: string;
  creditorAccountType: string;
  creditorPostedDebitUsd: string;
  creditorPostedCreditUsd: string;
  creditorOpeningBalanceUsd: string;
  creditorOpeningBalanceSide: string | null;
  factoryClearingAccountCode: string;
  factoryClearingAccountType: string;
  factoryClearingPostedDebitUsd: string;
  daybookNativeAmountUsd: string;
  retainedVoucherId: number;
  retainedVoucherNativeAmountUsd: string;
  retainedCreditorCreditUsd: string;
  extraVoucherId: number;
  extraVoucherNativeAmountUsd: string;
  extraCreditorCreditUsd: string;
  priorCorrectionVoucherId: number;
  priorCorrectionDeletedAt: string | null;
  correctionDeletedAuditEventCount: number;
  correctionDeletionReason: string | null;
  originalAmountEditAuditEventCount: number;
  latestCreditorPaymentDate: string | null;
  latestCreditorPaymentAmountUsd: string | null;
  fiscalReviewedCloseCount: number;
}

const money = (value: string) => new Decimal(value);
const fmt = (value: Decimal) => value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);

export function previewCharge64CreditorImpact(input: Charge64CreditorImpactInput) {
  const blockers: string[] = [];
  const amount = money(input.extraVoucherNativeAmountUsd);
  const retainedAmount = money(input.retainedVoucherNativeAmountUsd);
  const daybookAmount = money(input.daybookNativeAmountUsd);
  const postedDr = money(input.creditorPostedDebitUsd);
  const postedCr = money(input.creditorPostedCreditUsd);
  const opening = money(input.creditorOpeningBalanceUsd);
  const openingSide = (input.creditorOpeningBalanceSide ?? "").toUpperCase();
  const before = postedDr.minus(postedCr);
  const after = before.plus(amount);
  const openingDebit = openingSide === "DR" ? opening : openingSide === "CR" ? opening.negated() : new Decimal(0);
  const recognizedOpening = opening.isZero() || openingSide === "DR" || openingSide === "CR";
  if (!recognizedOpening) blockers.push("CREDITOR_OPENING_BALANCE_SIDE_UNKNOWN");
  if (!amount.eq(input.extraCreditorCreditUsd) ||
      !retainedAmount.eq(input.retainedCreditorCreditUsd) ||
      !retainedAmount.eq(daybookAmount)) blockers.push("SOURCE_CHARGE_AMOUNT_OR_GL_PAIR_MISMATCH");
  if (input.retainedVoucherId !== 9341 || input.extraVoucherId !== 9309 ||
      input.priorCorrectionVoucherId !== 15976) blockers.push("HISTORICAL_SOURCE_ID_CHANGED");
  if (!input.priorCorrectionDeletedAt) blockers.push("EXPECTED_RETIRED_CORRECTION_STATE_CHANGED");
  if (input.correctionDeletedAuditEventCount < 1) blockers.push("MISSING_CORRECTION_DELETION_AUDIT");
  if (input.originalAmountEditAuditEventCount < 1) blockers.push("MISSING_ORIGINAL_EDIT_AUDIT");
  if (input.creditorAccountCode !== "WALMDACLE" ||
      input.creditorAccountType.toUpperCase() !== "LIABILITY") blockers.push("CREDITOR_ACCOUNT_IDENTITY_CHANGED");
  if (input.factoryClearingAccountCode !== "FACTORY_CHARGES_PAYABLE" ||
      input.factoryClearingAccountType.toUpperCase() !== "DIRECT EXPENSE") blockers.push("CLEARING_ACCOUNT_TYPE_CHANGED");
  if (amount.lte(0)) blockers.push("INVALID_EXTRA_CHARGE");
  if (input.correctionDeletionReason === null) blockers.push("PREVIOUS_CORRECTION_DELETION_REASON_UNDOCUMENTED");
  blockers.push("CREDITOR_LEDGER_RECONCILIATION_REQUIRED");
  blockers.push("PAYMENT_AND_SETTLEMENT_EVIDENCE_NOT_SIGNED_OFF");
  blockers.push("FINANCIAL_POSTING_REQUIRES_ACCOUNTING_APPROVAL");
  const clearingAfter = money(input.factoryClearingPostedDebitUsd).minus(amount);
  // This is the *actual* balancing counterpart required to remove voucher
  // #9309. WALMDACLE would be debited, changing a protected creditor balance.
  // Never replace it with an invented asset, suspense, or equity account.
  const supplierBalanceFreeze = inspectHistoricalCorrectionBalanceProtection([
    {
      accountKind: "ledger",
      accountCode: input.creditorAccountCode,
      accountType: input.creditorAccountType,
      debitUsd: fmt(amount),
      creditUsd: "0.00",
    },
    {
      accountKind: "ledger",
      accountCode: input.factoryClearingAccountCode,
      accountType: input.factoryClearingAccountType,
      debitUsd: "0.00",
      creditUsd: fmt(amount),
    },
  ]);
  blockers.push(...supplierBalanceFreeze.issues);
  return {
    status: "REVIEW_REQUIRED_NO_POSTING",
    source: { containerId: 83, chargeId: 64,
      retainedVoucherId: input.retainedVoucherId, duplicateVoucherId: input.extraVoucherId,
      previouslyRetiredCorrectionId: input.priorCorrectionVoucherId },
    sourceDaybookAmountUsd: fmt(daybookAmount),
    retainedVoucherAmountUsd: fmt(retainedAmount),
    extraPostingAmountUsd: fmt(amount),
    sourceNativeAmountVarianceUsd: fmt(amount.minus(retainedAmount)),
    creditorLedgerCode: input.creditorAccountCode,
    creditorOpeningBalanceUsd: fmt(opening),
    creditorOpeningBalanceSide: input.creditorOpeningBalanceSide,
    postedCreditorNetDebitBeforeUsd: fmt(before),
    postedCreditorNetDebitAfterIllustrationUsd: fmt(after),
    openingInclusiveNetDebitBeforeUsd: recognizedOpening ? fmt(before.plus(openingDebit)) : null,
    openingInclusiveNetDebitAfterIllustrationUsd: recognizedOpening ? fmt(after.plus(openingDebit)) : null,
    creditorDebitChangeIllustrationUsd: fmt(amount),
    factoryClearingNetDebitBeforeUsd: fmt(money(input.factoryClearingPostedDebitUsd)),
    factoryClearingNetDebitAfterIllustrationUsd: fmt(clearingAfter),
    reportedExpenseDecreaseIfSameAccountTypeUsd: fmt(amount),
    note: "The counterfactual would Dr WALMDACLE / Cr FACTORY_CHARGES_PAYABLE, reducing a named creditor's GL credit balance and removing a currently expensed clearing debit. This does not preserve all creditor balances, and is NOT authorized.",
    lastObservedCreditorPayment: input.latestCreditorPaymentDate
      ? { date: input.latestCreditorPaymentDate, amountUsd: input.latestCreditorPaymentAmountUsd }
      : null,
    priorCorrectionDeletionReason: input.correctionDeletionReason,
    priorCorrectionDeletedAt: input.priorCorrectionDeletedAt,
    reviewedFiscalCloseCount: input.fiscalReviewedCloseCount,
    registeredSupplierPartyLinesChanged: false,
    namedCreditorLedgerWouldChange: true,
    supplierBalanceFreeze,
    supplierBalanceProtectionRequired: true,
    allowedSupplierOrCreditorBalanceDeltaUsd: "0.00",
    neutralCorrectionProven: false,
    stockOrContainerCostChanged: false,
    proposedJournal: null,
    approvedPeriod: null,
    readyToPost: false,
    blockers,
  };
}
