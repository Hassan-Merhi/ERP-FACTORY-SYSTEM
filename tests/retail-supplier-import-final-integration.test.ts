import { describe, expect, it } from "vitest";
import { parseRetailSupplierImportRows } from "../client/src/pages/retail/retailSupplierImportDraft";
import {
  retailSupplierFileMagicMatches,
  RETAIL_SUPPLIER_ALLOWED_IMAGE_TYPES,
  RETAIL_SUPPLIER_ALLOWED_INVOICE_TYPES,
} from "../server/services/retail/retailSupplierImportFileValidation";

function source(overrides: Record<string, unknown> = {}) {
  return [{
    rowNumber: 2,
    values: {
      "Item Name": "Running Shoes", Category: "Shoes", Brand: "Acme",
      Color: "Black", Size: "42", Quantity: 6,
      "Cost Price": "5.2000", "Selling Price": "19.9900",
      Barcode: "", SKU: "", ...overrides,
    },
  }];
}

describe("Phase 7 supplier import source-level contract", () => {
  it("accepts deliberate text barcodes with leading zeroes", () => {
    const [row] = parseRetailSupplierImportRows(source({ Barcode: "0000123456789" }));
    expect(row.errors).toEqual([]);
    expect(row.barcode).toBe("0000123456789");
  });

  it("blocks numeric Excel barcodes and SKUs that can silently lose leading zeroes", () => {
    const [row] = parseRetailSupplierImportRows(source({ Barcode: 123456789012, SKU: 1002 }));
    expect(row.errors.join(" ")).toMatch(/barcode was stored as a number/i);
    expect(row.errors.join(" ")).toMatch(/sku was stored as a number/i);
  });

  it("keeps client length limits aligned with server purchase schema", () => {
    expect(parseRetailSupplierImportRows(source({ "Item Name": "x".repeat(241) }))[0].errors.join(" ")).toMatch(/240/);
    expect(parseRetailSupplierImportRows(source({ Brand: "x".repeat(121) }))[0].errors.join(" ")).toMatch(/120/);
    expect(parseRetailSupplierImportRows(source({ Description: "x".repeat(5001) }))[0].errors.join(" ")).toMatch(/5000/);
  });

  it("accepts real PDF and JPEG headers only under allowed type", () => {
    const pdf = Buffer.from("%PDF-1.7 invoice").toString("base64");
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString("base64");
    expect(RETAIL_SUPPLIER_ALLOWED_INVOICE_TYPES.has("application/pdf")).toBe(true);
    expect(RETAIL_SUPPLIER_ALLOWED_IMAGE_TYPES.has("application/pdf")).toBe(false);
    expect(retailSupplierFileMagicMatches("application/pdf", pdf)).toBe(true);
    expect(retailSupplierFileMagicMatches("image/jpeg", jpeg)).toBe(true);
    expect(retailSupplierFileMagicMatches("image/jpeg", pdf)).toBe(false);
  });

  it("rejects fake image headers, unsafe Base64, and unsupported content types", () => {
    const fake = Buffer.from("<script>alert(1)</script>").toString("base64");
    expect(retailSupplierFileMagicMatches("image/png", fake)).toBe(false);
    expect(retailSupplierFileMagicMatches("image/svg+xml", fake)).toBe(false);
    expect(retailSupplierFileMagicMatches("image/jpeg", "!!!")).toBe(false);
  });

  it("recognizes WEBP and GIF signatures without reading full uploaded files", () => {
    const webp = Buffer.from("RIFF0000WEBP\0\0", "binary").toString("base64");
    const gif = Buffer.from("GIF89a123456").toString("base64");
    expect(retailSupplierFileMagicMatches("image/webp", webp)).toBe(true);
    expect(retailSupplierFileMagicMatches("image/gif", gif)).toBe(true);
  });
});
