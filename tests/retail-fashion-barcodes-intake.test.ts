import { describe, expect, it } from "vitest";
import {
  ean13CheckDigit,
  formatGeneratedRetailBarcode,
  isValidEan13,
} from "../server/services/retail/retailBarcodeService";
import { retailQuickAddSchema, validateQuickAddVariants } from "../server/routes/retailFashionRoutes";
import { retailProductWriteSchema } from "../shared/schema";
import { validateRetailVariantPayload } from "../server/services/retail/retailProductValidation";

describe("retail generated barcodes", () => {
  it("computes standard EAN-13 check digits", () => {
    expect(ean13CheckDigit("400638133393")).toBe(1); // 4006381333931 is a published example
    expect(isValidEan13("4006381333931")).toBe(true);
    expect(isValidEan13("4006381333932")).toBe(false);
  });

  it("issues restricted-circulation (prefix 2) EAN-13 values that never look like supplier codes", () => {
    const first = formatGeneratedRetailBarcode(1);
    expect(first).toBe("2000000000015");
    expect(isValidEan13(first)).toBe(true);
    const big = formatGeneratedRetailBarcode(98_765_432_109);
    expect(big).toMatch(/^298765432109\d$/);
    expect(isValidEan13(big)).toBe(true);
    expect(() => formatGeneratedRetailBarcode(0)).toThrow();
    expect(() => formatGeneratedRetailBarcode(10 ** 11)).toThrow(/exhausted/);
  });

  it("lets new variants omit the barcode so the server can generate one", () => {
    const parsed = retailProductWriteSchema.parse({
      code: "GEN",
      name: "Generated",
      variants: [
        { color: "Black", size: "S", cost: 1, sellingPrice: 2 },
        { color: "Black", size: "M", cost: 1, sellingPrice: 2 },
      ],
    });
    expect(parsed.variants.map((variant) => variant.barcode)).toEqual(["", ""]);
    // Two blank barcodes are not a duplicate; each gets its own generated value.
    expect(() => validateRetailVariantPayload(parsed)).not.toThrow();
  });
});

describe("retail quick add intake contract", () => {
  const base = {
    idempotencyKey: "quick-add-test-0001",
    brandName: "Zara",
    name: "Wide Leg Trouser",
    locationId: 1,
  };

  it("defaults quantity to one unit and barcode to auto-generate", () => {
    const parsed = retailQuickAddSchema.parse({
      ...base,
      variants: [{ color: "Black", size: "M", sellingPrice: 49.9 }],
    });
    expect(parsed.variants[0]).toMatchObject({ quantity: 1, barcode: "", cost: 0, imageUrls: [] });
  });

  it("still accepts larger quantities and supplier barcodes", () => {
    const parsed = retailQuickAddSchema.parse({
      ...base,
      variants: [{ color: "Black", size: "M", sellingPrice: 49.9, quantity: 12, barcode: "8412345678905" }],
    });
    expect(parsed.variants[0]).toMatchObject({ quantity: 12, barcode: "8412345678905" });
  });

  it("rejects the same color + size twice and repeated typed barcodes", () => {
    expect(() =>
      validateQuickAddVariants(
        retailQuickAddSchema.parse({
          ...base,
          variants: [
            { color: "Black", size: "M", sellingPrice: 1 },
            { color: " black ", size: "m", sellingPrice: 1 },
          ],
        })
      )
    ).toThrow(/Duplicate color\/size/);
    expect(() =>
      validateQuickAddVariants(
        retailQuickAddSchema.parse({
          ...base,
          variants: [
            { color: "Black", size: "M", sellingPrice: 1, barcode: "ABC" },
            { color: "Beige", size: "S", sellingPrice: 1, barcode: "ABC" },
          ],
        })
      )
    ).toThrow(/Duplicate barcode/);
  });

  it("keeps Black / M and Beige / S as separate variants of one style", () => {
    const parsed = retailQuickAddSchema.parse({
      ...base,
      variants: [
        { color: "Black", size: "M", sellingPrice: 1 },
        { color: "Beige", size: "S", sellingPrice: 1 },
      ],
    });
    expect(() => validateQuickAddVariants(parsed)).not.toThrow();
  });

  it("caps photos at four per variant", () => {
    const result = retailQuickAddSchema.safeParse({
      ...base,
      variants: [
        {
          color: "Black",
          size: "M",
          sellingPrice: 1,
          imageUrls: Array.from({ length: 5 }, (_, index) => `https://example.com/${index}.jpg`),
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});
