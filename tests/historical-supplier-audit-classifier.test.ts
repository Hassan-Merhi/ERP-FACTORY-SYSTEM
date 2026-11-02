import { describe, expect, it } from "vitest";
import { classifyHistoricalSupplierVoucher, type HistoricalSupplierVoucherEvidence } from "../scripts/historical-supplier-audit-classifier";

const base: HistoricalSupplierVoucherEvidence = {
  voucherDate: "2026-10-10",
  postingDate: "2026-10-14",
  businessDate: "2026-11-02",
  expenseDebitUsd: "118.00",
  supplierCreditUsd: "118.00",
  expectedUsd: "118.00",
  receivedKg: "100",
  usedKg: "0",
  remainingKg: "100",
  relatedExpenseCount: 0,
};

describe("Historical supplier backend audit classification", () => {
  it("marks future-dated and consumed container without claiming a duplicate", () => {
    const flags = classifyHistoricalSupplierVoucher({
      ...base,
      voucherDate: "2026-11-11",
      postingDate: "2026-10-14",
      businessDate: "2026-11-02",
      receivedKg: "17980", usedKg: "17980", remainingKg: "0",
    });
    expect(flags).toContain("FUTURE_DATED");
    expect(flags).toContain("DATED_AFTER_POSTING");
    expect(flags).toContain("RAW_MATERIAL_ALREADY_CONSUMED");
    expect(flags).not.toContain("PROVEN_DUPLICATE");
  });
  it("identifies unbalanced posted expense and supplier credits only as a review flag", () => {
    const flags = classifyHistoricalSupplierVoucher({ ...base, supplierCreditUsd: "0.00" });
    expect(flags).toContain("EXPENSE_VS_SUPPLIER_GL_DIFFERENCE");
  });
  it("compares native converted goods against the posted GL amount", () => {
    expect(classifyHistoricalSupplierVoucher({ ...base, expectedUsd: "200.00" }))
      .toContain("SOURCE_VS_GL_AMOUNT_REQUIRES_REVIEW");
    expect(classifyHistoricalSupplierVoucher(base)).not.toContain("SOURCE_VS_GL_AMOUNT_REQUIRES_REVIEW");
  });
  it("flags possible expense overlap but does not propose a journal", () => {
    const flags = classifyHistoricalSupplierVoucher({ ...base, relatedExpenseCount: 2 });
    expect(flags).toContain("OTHER_FACTORY_EXPENSE_LINES_CHECK_FOR_OVERLAP");
    expect(flags).toContain("ACCOUNTING_TREATMENT_REQUIRES_MANUAL_PROOF");
  });
});
