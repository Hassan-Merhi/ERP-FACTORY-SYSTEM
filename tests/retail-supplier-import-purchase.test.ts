import { describe, expect, it } from "vitest";
import {
  retailSupplierPurchaseSchema,
  retailSupplierPurchaseFingerprint,
} from "../server/services/retail/retailSupplierPurchaseService";

const request = (overrides: Record<string, unknown> = {}) => ({
  idempotencyKey: "supplier-import-test-20261024-0001",
  supplierId: 7,
  locationId: 5,
  invoiceReference: "SUP-001",
  invoiceDate: "2026-10-24",
  currency: "USD",
  exchangeRate: "1",
  lines: [{
    rowNumber: 2, name: "Sneaker", brand: "Brand", category: "Shoes",
    color: "Black", size: "42", quantity: 5,
    costPrice: 12.5, sellingPrice: 35,
    sku: "SHOE-BLK-42", barcode: "", imageUrls: [],
  }],
  ...overrides,
});

describe("retail supplier purchase request contract", () => {
  it("accepts a company supplier purchase with explicit row quantities and costs", () => {
    const parsed = retailSupplierPurchaseSchema.parse(request());
    expect(parsed.lines[0]).toMatchObject({ quantity: 5, costPrice: 12.5 });
  });

  it("does not allow a missing invoice reference used for duplicate prevention", () => {
    expect(() => retailSupplierPurchaseSchema.parse(request({ invoiceReference: "" }))).toThrow();
  });

  it("does not allow zero or negative quantity and empty purchase lines", () => {
    expect(() => retailSupplierPurchaseSchema.parse(request({ lines: [] }))).toThrow();
    const qtyZero = { ...request(), lines: [{ ...request().lines[0], quantity: 0 }] };
    expect(() => retailSupplierPurchaseSchema.parse(qtyZero)).toThrow();
  });

  it("rejects external or unowned-looking image URLs before accounting", () => {
    const withRemoteImage = { ...request(), lines: [{
      ...request().lines[0], imageUrls: ["https://example.com/unsafe.png"],
    }] };
    expect(() => retailSupplierPurchaseSchema.parse(withRemoteImage)).toThrow();
  });

  it("refuses more than four images on a variant", () => {
    const images = Array.from({ length: 5 }, (_, i) => `/api/retail/media/${i + 1}`);
    expect(() => retailSupplierPurchaseSchema.parse({
      ...request(), lines: [{ ...request().lines[0], imageUrls: images }],
    })).toThrow();
  });

  it("keeps the same idempotency fingerprint for identical retried purchases", () => {
    const a = retailSupplierPurchaseSchema.parse(request());
    const b = retailSupplierPurchaseSchema.parse(request());
    expect(retailSupplierPurchaseFingerprint(a)).toEqual(retailSupplierPurchaseFingerprint(b));
    const changed = retailSupplierPurchaseSchema.parse(request({ invoiceReference: "SUP-002" }));
    expect(retailSupplierPurchaseFingerprint(a)).not.toEqual(retailSupplierPurchaseFingerprint(changed));
  });
});
