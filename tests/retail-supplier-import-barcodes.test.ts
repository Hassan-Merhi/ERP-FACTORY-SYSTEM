import { describe, expect, it } from "vitest";
import { formatGeneratedRetailBarcode, isValidEan13 } from "../server/services/retail/retailBarcodeService";
import { describeRetailSupplierBarcode } from "../server/services/retail/retailSupplierBarcodeIntake";
import type { RetailSupplierCatalogDecision } from "../server/services/retail/retailSupplierCatalogPreview";

const decision = (overrides: Partial<RetailSupplierCatalogDecision> = {}): RetailSupplierCatalogDecision => ({
  rowNumber: 2, status: "new-product", productId: null,
  variantId: null, existingBarcode: null, messages: [],
  ...overrides,
});

describe("retail supplier barcode assignment rules", () => {
  it("reuses the exact stored barcode of an existing variant", () => {
    const intent = describeRetailSupplierBarcode({ barcode: "" }, decision({
      status: "existing-variant", productId: 4, variantId: 21,
      existingBarcode: "2000000000015",
    }));
    expect(intent).toMatchObject({ action: "reuse", barcode: "2000000000015" });
  });

  it("preserves a supplied vendor barcode rather than replacing it", () => {
    const intent = describeRetailSupplierBarcode({ barcode: "VENDOR-4412" }, decision());
    expect(intent).toMatchObject({ action: "supplier", barcode: "VENDOR-4412" });
  });

  it("does not allocate a barcode during a preview", () => {
    const intent = describeRetailSupplierBarcode({ barcode: "" }, decision());
    expect(intent).toMatchObject({ action: "generate", barcode: null });
  });

  it("never treats a conflicting variant as a candidate for barcode generation", () => {
    const intent = describeRetailSupplierBarcode(
      { barcode: "" }, decision({ status: "conflict", messages: ["SKU conflict"] })
    );
    expect(intent).toMatchObject({ action: "conflict", barcode: null });
  });

  it("formats a valid company-sequence EAN-13 in restricted circulation range", () => {
    for (const sequence of [1, 20, 101, 999999]) {
      const barcode = formatGeneratedRetailBarcode(sequence);
      expect(barcode).toMatch(/^2\d{12}$/);
      expect(isValidEan13(barcode)).toBe(true);
    }
  });

  it("rejects out-of-range generator sequence inputs", () => {
    expect(() => formatGeneratedRetailBarcode(0)).toThrow();
    expect(() => formatGeneratedRetailBarcode(1.3)).toThrow();
    expect(() => formatGeneratedRetailBarcode(10 ** 11)).toThrow();
  });
});
