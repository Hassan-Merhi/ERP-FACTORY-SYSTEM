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
  it("uses the commission supplier rather than the goods supplier", () => {
    const correct = classifyHistoricalSupplierVoucher({ ...base,
      expectedSupplierId: 27, linkedSupplierId: 27,
      sourceCurrency: "USD", voucherCurrency: "USD",
    });
    expect(correct).not.toContain("SOURCE_SUPPLIER_MISMATCH");
    const incorrect = classifyHistoricalSupplierVoucher({ ...base,
      expectedSupplierId: 27, linkedSupplierId: 60,
    });
    expect(incorrect).toContain("SOURCE_SUPPLIER_MISMATCH");
  });
  it("flags arrival dates after a recorded physical offload", () => {
    expect(classifyHistoricalSupplierVoucher({ ...base,
      storedArrivalDate: "2026-12-11", firstOffloadedAt: "2026-06-19 10:23:36",
    })).toContain("ARRIVAL_DATE_AFTER_STOCK_OFFLOAD");
  });
  it("flags a currency mismatch or an unbalanced voucher without creating corrections", () => {
    const flags = classifyHistoricalSupplierVoucher({ ...base,
      sourceCurrency: "EUR", voucherCurrency: "USD",
      voucherDebitsUsd: "118.00", voucherCreditsUsd: "100.00",
    });
    expect(flags).toContain("SOURCE_VOUCHER_CURRENCY_MISMATCH");
    expect(flags).toContain("VOUCHER_NOT_BALANCED");
  });
  it("does not label raw stock with an actual remaining balance as fully consumed", () => {
    const flags = classifyHistoricalSupplierVoucher({ ...base,
      receivedKg: "20740", usedKg: "0", remainingKg: "20740",
    });
    expect(flags).not.toContain("RAW_MATERIAL_ALREADY_CONSUMED");
  });
  it("flags overused raw rows and missing stock valuation without inventing a correction", () => {
    const flags = classifyHistoricalSupplierVoucher({ ...base,
      receivedKg: "0", usedKg: "3516", remainingKg: "0",
      overusedKg: "3516", unvaluedRawRows: 1,
    });
    expect(flags).toContain("SOURCE_RAW_STOCK_OVERUSED_KG_REQUIRES_REVIEW");
    expect(flags).toContain("RAW_STOCK_MISSING_USD_COST");
    expect(flags).not.toContain("RAW_MATERIAL_ALREADY_CONSUMED");
  });
  it("flags possible expense overlap but does not propose a journal", () => {
    const flags = classifyHistoricalSupplierVoucher({ ...base, relatedExpenseCount: 2 });
    expect(flags).toContain("OTHER_FACTORY_EXPENSE_LINES_CHECK_FOR_OVERLAP");
    expect(flags).toContain("ACCOUNTING_TREATMENT_REQUIRES_MANUAL_PROOF");
  });
});
