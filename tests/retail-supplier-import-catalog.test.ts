import { describe, expect, it } from "vitest";
import {
  planRetailSupplierCatalog,
  retailSupplierCatalogPreviewRowsSchema,
} from "../server/services/retail/retailSupplierCatalogPreview";

const row = (overrides: Record<string, unknown> = {}) => ({
  rowNumber: 2, name: "Runner 270", brand: "Acme", category: "Shoes",
  color: "Black", size: "42", sku: "", barcode: "", ...overrides,
});
const snapshot = (overrides: Record<string, unknown> = {}) => ({
  productId: 15, productCode: "RTL-acme-runner-270", productName: "Runner 270",
  category: "Shoes", brandName: "Acme", variantId: 40, color: "Black", size: "42",
  sku: "R-42", barcode: "2345678901234", ...overrides,
});
const plan = (rows: Array<Record<string, unknown>>, existing: Array<Record<string, unknown>> = []) =>
  planRetailSupplierCatalog(retailSupplierCatalogPreviewRowsSchema.parse(rows),
    existing as Parameters<typeof planRetailSupplierCatalog>[1]);

describe("retail supplier stock catalog preview", () => {
  it("classifies a new style without creating it", () => {
    const result = plan([row()]);
    expect(result.summary).toEqual({ existingVariants: 0, newVariants: 0, newProducts: 1, conflicts: 0 });
    expect(result.decisions[0].productId).toBeNull();
  });

  it("groups new color/size rows under one new style", () => {
    const result = plan([row(), row({ rowNumber: 3, color: "White", size: "43" })]);
    expect(result.summary.newProducts).toBe(1);
    expect(result.summary.newVariants).toBe(1);
    expect(result.summary.conflicts).toBe(0);
  });

  it("reuses existing variants and their stored barcodes even when Excel omits a barcode", () => {
    const result = plan([row()], [snapshot()]);
    expect(result.decisions[0].status).toBe("existing-variant");
    expect(result.decisions[0].variantId).toBe(40);
    expect(result.decisions[0].existingBarcode).toBe("2345678901234");
  });

  it("matches equivalent case/spacing of brand and style", () => {
    const result = plan([row({ name: "  RUNNER  270 ", brand: " ACME " })], [snapshot()]);
    expect(result.summary.existingVariants).toBe(1);
  });

  it("flags barcodes assigned to another variant instead of reassigning them", () => {
    const result = plan([row({ color: "White", barcode: "2345678901234" })], [snapshot()]);
    expect(result.summary.conflicts).toBe(1);
  });

  it("flags SKU and barcode that point to different existing variants", () => {
    const result = plan([row({ sku: "R-42", barcode: "NEWCODE" })],
      [snapshot(), snapshot({ productId: 16, productCode: "RTL-other-tee",
        productName: "Tee", category: "Clothing", brandName: "Other",
        variantId: 41, sku: "TEE42", barcode: "NEWCODE" })]);
    expect(result.summary.conflicts).toBe(1);
  });

  it("rejects duplicate style/size even if rows use different SKUs", () => {
    const result = plan([row({ sku: "ONE" }), row({ rowNumber: 3, sku: "TWO" })]);
    expect(result.summary.conflicts).toBe(1);
  });

  it("preserves existing category and warns rather than silently reclassifying a style", () => {
    const result = plan([row({ category: "Sale Shoes" })], [snapshot()]);
    expect(result.summary.existingVariants).toBe(1);
    expect(result.decisions[0].messages).toContain('Existing category is "Shoes"; it will be preserved');
  });

  it("detects collisions between newly generated product codes", () => {
    const result = plan([
      row({ name: "A+B", brand: "Acme" }),
      row({ rowNumber: 3, name: "AB", brand: "Acme" }),
    ]);
    expect(result.summary.conflicts).toBe(1);
  });
});
