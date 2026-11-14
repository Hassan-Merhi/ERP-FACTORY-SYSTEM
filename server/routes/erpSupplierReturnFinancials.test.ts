import { describe, expect, it } from "vitest";
import { calculateSupplierReturnFinancials, reconcileSupplierReturnBatch } from "./erpSupplierReturnFinancials";

const calculation = (
  quantity: string, purchaseRate: string,
  previousQuantity: string, newQuantity: string,
  previousTotalValue: string, newTotalValue: string,
) => calculateSupplierReturnFinancials({
  quantity, purchaseRate, previousQuantity, newQuantity, previousTotalValue,
  newTotalValue, inventoryValueDelta: (Number(newTotalValue) - Number(previousTotalValue)).toFixed(2),
});

describe("ERP supplier returns — source purchase cost and moving-average valuation", () => {
  it("credits inventory at the true moving average and debits the original supplier cost", () => {
    const financials = calculation("18", "58", "100", "82", "6500.00", "5330.00");
    expect(financials).toMatchObject({
      supplierDebit: "1044.00",
      inventoryCredit: "1170.00",
      varianceDebit: "126.00",
      varianceCredit: "0.00",
      signedVariance: "126.00",
      effectiveInventoryCostPerBale: "65.0000000",
    });
  });

  it("books the reverse variance when the supplier purchase credit exceeds inventory relief", () => {
    expect(calculation("2", "80", "10", "8", "650", "520")).toMatchObject({
      supplierDebit: "160.00", inventoryCredit: "130.00",
      varianceDebit: "0.00", varianceCredit: "30.00",
    });
  });

  it("does not add variance when purchase and inventory amounts match", () => {
    expect(calculation("2", "65", "10", "8", "650.00", "520.00")).toMatchObject({
      supplierDebit: "130.00", inventoryCredit: "130.00",
      varianceDebit: "0.00", varianceCredit: "0.00",
    });
  });

  it("relieves the last bale's entire stored residual value", () => {
    expect(calculation("1", "10", "1", "0", "10.01", "0.00")).toMatchObject({
      inventoryCredit: "10.01", supplierDebit: "10.00", varianceDebit: "0.01",
    });
  });

  it("reconciles line-level cent rounding across different purchase rates and stock buckets", () => {
    const first = calculation("17", "58.12", "100", "83", "6500.00", "5395.00");
    const second = calculation("1", "62.03", "10", "9", "700.00", "630.00");
    const totals = reconcileSupplierReturnBatch([
      { quantity: "17", financials: first },
      { quantity: "1", financials: second },
    ]);
    expect(totals).toEqual({
      totalQuantity: "18.000",
      supplierDebit: "1050.07",
      inventoryCredit: "1175.00",
      varianceDebit: "124.93",
      varianceCredit: "0.00",
    });
  });

  it("reconciles mixed debit and credit variances at line and batch level", () => {
    const first = calculation("1", "10", "2", "1", "22.00", "11.00");
    const second = calculation("1", "20", "2", "1", "22.00", "11.00");
    expect(reconcileSupplierReturnBatch([
      { quantity: "1", financials: first },
      { quantity: "1", financials: second },
    ])).toEqual({
      totalQuantity: "2.000", supplierDebit: "30.00",
      inventoryCredit: "22.00", varianceDebit: "1.00", varianceCredit: "9.00",
    });
  });

  it("rejects wrong quantity or value delta instead of posting misleading inventory amounts", () => {
    const base = {
      quantity: "1", purchaseRate: "10", previousQuantity: "2", newQuantity: "1",
      previousTotalValue: "20.00", newTotalValue: "10.00", inventoryValueDelta: "-10.00",
    };
    expect(() => calculateSupplierReturnFinancials({ ...base, newQuantity: "1.5" })).toThrow(/quantity/);
    expect(() => calculateSupplierReturnFinancials({ ...base, inventoryValueDelta: "-9.99" })).toThrow(/value/);
    expect(() => calculateSupplierReturnFinancials({ ...base, inventoryValueDelta: "1.00" })).toThrow(/value/);
    expect(() => calculateSupplierReturnFinancials({ ...base, purchaseRate: "-1" })).toThrow(/purchase/);
    expect(() => calculateSupplierReturnFinancials({ ...base, newTotalValue: "21.00", inventoryValueDelta: "1.00" }))
      .toThrow(/increase inventory/);
  });

  it("uses precise decimal arithmetic for fractional bale quantities", () => {
    const financials = calculateSupplierReturnFinancials({
      quantity: "0.125", purchaseRate: "11.125", previousQuantity: "1.000",
      newQuantity: "0.875", previousTotalValue: "10.00",
      newTotalValue: "8.75", inventoryValueDelta: "-1.25",
    });
    expect(financials.supplierDebit).toBe("1.39");
    expect(financials.inventoryCredit).toBe("1.25");
    expect(financials.varianceCredit).toBe("0.14");
  });
});
