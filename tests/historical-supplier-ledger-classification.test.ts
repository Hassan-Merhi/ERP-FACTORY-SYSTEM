import { describe, expect, it } from "vitest";
import {
  FACTORY_ACCOUNT_TYPE_EXPECTATIONS,
  inspectFactoryAccountType,
} from "../scripts/historical-supplier-ledger-classification";

describe("Historical factory ledger classification review is nonposting", () => {
  it("marks a factory payable incorrectly classified as a direct expense", () => {
    const x = inspectFactoryAccountType({
      code: "FACTORY_CHARGES_PAYABLE",
      name: "Factory Charges Payable",
      accountType: "Direct Expense",
      debitUsd: "381581.45",
      creditUsd: "0.00",
      voucherCount: 225,
      postedLineCount: 225,
    });
    expect(FACTORY_ACCOUNT_TYPE_EXPECTATIONS.FACTORY_CHARGES_PAYABLE).toBe("Liability");
    expect(x.mismatch).toBe(true);
    expect(x.expectedType).toBe("Liability");
    expect(x.proposedAccountTypeChange).toBeNull();
    expect(x.proposedVoucherCorrection).toBeNull();
  });
  it("flags raw material stock held in an expense account type", () => {
    const x = inspectFactoryAccountType({
      code: "FACTORY_RAW_MATERIAL_STOCK",
      name: "Factory Raw Material Stock",
      accountType: "Indirect Expense",
      debitUsd: "3288.00",
      creditUsd: "0.00",
      voucherCount: 4,
      postedLineCount: 4,
    });
    expect(x.mismatch).toBe(true);
    expect(x.expectedType).toBe("Asset");
    expect(x.proposedVoucherCorrection).toBeNull();
  });
  it("does not request a change when current type matches registry", () => {
    const x = inspectFactoryAccountType({
      code: "FACTORY_CHARGES_PAYABLE",
      name: "Factory Charges Payable",
      accountType: "Liability",
      debitUsd: "381581.45",
      creditUsd: "0.00",
      voucherCount: 225,
      postedLineCount: 225,
    });
    expect(x.mismatch).toBe(false);
    expect(x.proposedAccountTypeChange).toBeNull();
  });
});
