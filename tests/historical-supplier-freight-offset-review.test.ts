import { describe, expect, it } from "vitest";
import { classifyFreightOffsetEvidence, type FreightOffsetEvidence } from "../scripts/historical-supplier-freight-offset-review";

const evidence: FreightOffsetEvidence = {
  containerId: 102,
  freightVoucherCount: 2,
  freightDebitUsd: "2065.00",
  freightCreditUsd: "2065.00",
  chargeClearingDebitUsd: "2065.00",
  duplicateImportVoucherCount: 0,
  duplicateImportExpenseUsd: "0.00",
};

describe("Historical factory freight reconciliation is strictly a no-write preview", () => {
  it("recognizes an exact accounting offset without claiming it is duplicated", () => {
    const result = classifyFreightOffsetEvidence(evidence);
    expect(result.reviewFlags).toContain("FREIGHT_DEBIT_CREDIT_EXACT_OFFSET");
    expect(result.reviewFlags).toContain("FACTORY_CHARGES_PAYABLE_USED_AS_CLEARING_ACCOUNT");
    expect(result.freightNetDebitUsd).toBe("0.00");
    expect(result.isProvenOverstatement).toBe(false);
    expect(result.proposedCorrectionAmountUsd).toBeNull();
    expect(result.proposedGLPosting).toBeNull();
    expect(result.supplierMovement).toBeNull();
  });
  it("flags unequal freight legs for manual review only", () => {
    const result = classifyFreightOffsetEvidence({
      ...evidence, containerId: 122,
      freightDebitUsd: "1750.00", freightCreditUsd: "2065.00",
    });
    expect(result.reviewFlags).toContain("FREIGHT_DEBIT_CREDIT_DIFFERENCE");
    expect(result.freightNetDebitUsd).toBe("-315.00");
    expect(result.proposedGLPosting).toBeNull();
  });
  it("flags an additional matching-prefix import journal without reversing it", () => {
    const result = classifyFreightOffsetEvidence({
      ...evidence, duplicateImportVoucherCount: 1, duplicateImportExpenseUsd: "7789.18",
    });
    expect(result.reviewFlags).toContain("SECOND_IMPORT_VOUCHER_SAME_CONTAINER_REQUIRES_REVIEW");
    expect(result.isProvenOverstatement).toBe(false);
  });
  it("distinguishes one-sided freight evidence", () => {
    const result = classifyFreightOffsetEvidence({
      ...evidence, freightVoucherCount: 1, freightDebitUsd: "1200.00",
      freightCreditUsd: "0.00", chargeClearingDebitUsd: "0.00",
    });
    expect(result.reviewFlags).toContain("FREIGHT_ONLY_ONE_SIDE_RECORDED");
    expect(result.proposedCorrectionAmountUsd).toBeNull();
  });
});
