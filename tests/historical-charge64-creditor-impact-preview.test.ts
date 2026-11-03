import { describe, expect, it } from "vitest";
import {
  previewCharge64CreditorImpact,
  type Charge64CreditorImpactInput,
} from "../scripts/historical-charge64-creditor-impact-preview";

const verified: Charge64CreditorImpactInput = {
  creditorAccountCode: "WALMDACLE",
  creditorAccountType: "Liability",
  creditorPostedDebitUsd: "228261.00",
  creditorPostedCreditUsd: "227277.66",
  creditorOpeningBalanceUsd: "1691.20",
  creditorOpeningBalanceSide: "Dr",
  factoryClearingAccountCode: "FACTORY_CHARGES_PAYABLE",
  factoryClearingAccountType: "Direct Expense",
  factoryClearingPostedDebitUsd: "381581.45",
  daybookNativeAmountUsd: "1692.00",
  retainedVoucherId: 9341,
  retainedVoucherNativeAmountUsd: "1692.00",
  retainedCreditorCreditUsd: "1692.00",
  extraVoucherId: 9309,
  extraVoucherNativeAmountUsd: "1692.96",
  extraCreditorCreditUsd: "1692.96",
  priorCorrectionVoucherId: 15976,
  priorCorrectionDeletedAt: "2026-10-19 12:37:16.345",
  correctionDeletedAuditEventCount: 1,
  correctionDeletionReason: null,
  originalAmountEditAuditEventCount: 1,
  latestCreditorPaymentDate: "2026-10-26",
  latestCreditorPaymentAmountUsd: "10000.00",
  fiscalReviewedCloseCount: 0,
};

describe("Company-12 charge-64 creditor exposure: always a nonposting preview", () => {
  it("shows the named creditor would move even though no factory supplier-party entries change", () => {
    const r = previewCharge64CreditorImpact(verified);
    expect(r.source.duplicateVoucherId).toBe(9309);
    expect(r.sourceDaybookAmountUsd).toBe("1692.00");
    expect(r.sourceNativeAmountVarianceUsd).toBe("0.96");
    expect(r.postedCreditorNetDebitBeforeUsd).toBe("983.34");
    expect(r.postedCreditorNetDebitAfterIllustrationUsd).toBe("2676.30");
    expect(r.openingInclusiveNetDebitBeforeUsd).toBe("2674.54");
    expect(r.openingInclusiveNetDebitAfterIllustrationUsd).toBe("4367.50");
    expect(r.factoryClearingNetDebitAfterIllustrationUsd).toBe("379888.49");
    expect(r.reportedExpenseDecreaseIfSameAccountTypeUsd).toBe("1692.96");
    expect(r.namedCreditorLedgerWouldChange).toBe(true);
    expect(r.supplierBalanceProtectionRequired).toBe(true);
    expect(r.supplierBalanceFreeze.canPost).toBe(false);
    expect(r.supplierBalanceFreeze.issues).toContain("PROTECTED_NAMED_CREDITOR_LEDGER");
    expect(r.supplierBalanceFreeze.issues).toContain("PROTECTED_BALANCE_SHEET_OR_OTHER_LEDGER");
    expect(r.allowedSupplierOrCreditorBalanceDeltaUsd).toBe("0.00");
    expect(r.neutralCorrectionProven).toBe(false);
    expect(r.registeredSupplierPartyLinesChanged).toBe(false);
    expect(r.readyToPost).toBe(false);
    expect(r.proposedJournal).toBeNull();
    expect(r.blockers).toContain("PREVIOUS_CORRECTION_DELETION_REASON_UNDOCUMENTED");
  });
  it("guards a mismatch between source daybook and retained voucher", () => {
    const r = previewCharge64CreditorImpact({
      ...verified,
      retainedVoucherNativeAmountUsd: "1700.00",
    });
    expect(r.blockers).toContain("SOURCE_CHARGE_AMOUNT_OR_GL_PAIR_MISMATCH");
    expect(r.readyToPost).toBe(false);
  });
  it("guards a different ledger or deleted-correction lifecycle", () => {
    const r = previewCharge64CreditorImpact({
      ...verified,
      creditorAccountCode: "OTHER",
      priorCorrectionDeletedAt: null,
      originalAmountEditAuditEventCount: 0,
    });
    expect(r.blockers).toContain("CREDITOR_ACCOUNT_IDENTITY_CHANGED");
    expect(r.blockers).toContain("EXPECTED_RETIRED_CORRECTION_STATE_CHANGED");
    expect(r.blockers).toContain("MISSING_ORIGINAL_EDIT_AUDIT");
    expect(r.proposedJournal).toBeNull();
  });
  it("does not invent an opening balance when the sign is not known", () => {
    const r = previewCharge64CreditorImpact({
      ...verified,
      creditorOpeningBalanceSide: null,
    });
    expect(r.blockers).toContain("CREDITOR_OPENING_BALANCE_SIDE_UNKNOWN");
    expect(r.openingInclusiveNetDebitBeforeUsd).toBeNull();
    expect(r.readyToPost).toBe(false);
  });
});
