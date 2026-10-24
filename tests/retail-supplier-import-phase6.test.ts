import { describe, expect, it } from "vitest";
import {
  retailSupplierPurchaseSchema,
  retailSupplierPurchaseFingerprint,
} from "../server/services/retail/retailSupplierPurchaseService";
import { savedRetailSupplierPurchaseItems } from "../server/services/retail/retailSupplierPurchaseHistory";

function purchase(overrides: Record<string, unknown> = {}) {
  return {
    idempotencyKey: "retail-supplier-phase6-test-request-0001",
    supplierId: 19,
    locationId: 4,
    invoiceReference: "INV-ABC-400",
    invoiceDate: "2026-10-24",
    currency: "USD",
    exchangeRate: "1",
    lines: [{
      rowNumber: 2, name: "Hoodie", brand: "Acme", category: "Clothing",
      color: "Blue", size: "XL", quantity: 4,
      costPrice: 5, sellingPrice: 12, sku: "HOODIE-BLUE-XL",
      barcode: "4400000000002", imageUrls: [],
    }],
    ...overrides,
  };
}

describe("retail supplier import history and partial deliveries", () => {
  it("supports separately referenced partial deliveries of one supplier invoice", () => {
    const first = retailSupplierPurchaseSchema.parse(purchase({
      partialReceipt: true, deliveryReference: "PACK-01",
    }));
    const second = retailSupplierPurchaseSchema.parse(purchase({
      partialReceipt: true, deliveryReference: "PACK-02",
    }));
    expect(first.invoiceReference).toBe(second.invoiceReference);
    expect(first.deliveryReference).not.toEqual(second.deliveryReference);
    expect(retailSupplierPurchaseFingerprint(first)).not.toEqual(retailSupplierPurchaseFingerprint(second));
  });

  it("refuses partial receipt without a delivery reference", () => {
    expect(() => retailSupplierPurchaseSchema.parse(purchase({
      partialReceipt: true, deliveryReference: "",
    }))).toThrow();
  });

  it("refuses a delivery reference when not in partial receipt mode", () => {
    expect(() => retailSupplierPurchaseSchema.parse(purchase({
      partialReceipt: false, deliveryReference: "PACK-01",
    }))).toThrow();
  });

  it("accepts a valid company-owned invoice file id for server verification", () => {
    const parsed = retailSupplierPurchaseSchema.parse(purchase({
      invoiceFileId: 1003,
    }));
    expect(parsed.invoiceFileId).toBe(1003);
  });

  it("rejects invalid invoice attachment ids", () => {
    expect(() => retailSupplierPurchaseSchema.parse(purchase({ invoiceFileId: -2 }))).toThrow();
  });

  it("reads original barcode and purchased units from persisted receipt metadata", () => {
    const rows = savedRetailSupplierPurchaseItems({
      items: [{
        rowNumber: 6, variantId: 77, barcode: "12300000006",
        quantity: 9, name: "Hoodie", brand: "Acme", color: "Blue",
        size: "XL", unitCost: "5.0000", sellingPrice: "12.0000",
      }],
    });
    expect(rows).toMatchObject([{ rowNumber: 6, variantId: 77, quantity: 9,
      barcode: "12300000006", unitCost: "5.0000" }]);
  });

  it("rejects corrupted historical receipt metadata instead of giving broken reprints", () => {
    expect(() => savedRetailSupplierPurchaseItems({
      items: [{ rowNumber: 1, variantId: 77, barcode: "ABC", quantity: 4 }],
    })).toThrow(/corrupted/i);
    expect(() => savedRetailSupplierPurchaseItems({
      items: [{ rowNumber: 2, variantId: 77, barcode: "", quantity: 4 }],
    })).toThrow(/corrupted/i);
    expect(() => savedRetailSupplierPurchaseItems({
      items: [{ rowNumber: 2, variantId: 77, barcode: "ABC", quantity: 0 }],
    })).toThrow(/corrupted/i);
  });

  it("keeps an immutable receipt fingerprint distinct from another invoice", () => {
    const a = retailSupplierPurchaseSchema.parse(purchase());
    const b = retailSupplierPurchaseSchema.parse(purchase({ invoiceReference: "INV-ABC-401" }));
    expect(retailSupplierPurchaseFingerprint(a)).not.toEqual(retailSupplierPurchaseFingerprint(b));
  });
});
