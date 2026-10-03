import { describe, expect, it } from "vitest";
import { retailImportRowSchema, retailProductVariants, retailProductWriteSchema } from "../shared/schema";
import { blankVariant, MAX_VARIANT_IMAGES } from "../client/src/pages/retail/retailInventoryTypes";
import { validateRetailVariantPayload } from "../server/services/retail/retailProductValidation";

describe("retail fashion variants wave 1 behavior", () => {
  it("keeps legacy variants backward compatible", () => {
    const parsed = retailProductWriteSchema.parse({
      code: "LEGACY-TEE",
      name: "Legacy Tee",
      variants: [{ size: "M", barcode: "LEGACY-001", cost: 5, sellingPrice: 10, stocks: [] }],
    });
    expect(parsed.variants[0]).toMatchObject({ color: "Default", imageUrls: [] });
  });

  it("accepts the same size in different colors", () => {
    const parsed = retailProductWriteSchema.parse({
      code: "COLOR-TEE",
      name: "Color Tee",
      variants: [
        { color: "Black", size: "M", barcode: "COLOR-001", cost: 5, sellingPrice: 10, stocks: [] },
        { color: "Beige", size: "M", barcode: "COLOR-002", cost: 5, sellingPrice: 10, stocks: [] },
      ],
    });
    expect(() => validateRetailVariantPayload(parsed)).not.toThrow();
  });

  it("rejects normalized duplicate color and size combinations", () => {
    const parsed = retailProductWriteSchema.parse({
      code: "DUP-TEE",
      name: "Duplicate Tee",
      variants: [
        { color: "Black", size: "M", barcode: "DUP-001", cost: 5, sellingPrice: 10, stocks: [] },
        { color: " black ", size: " m ", barcode: "DUP-002", cost: 5, sellingPrice: 10, stocks: [] },
      ],
    });
    expect(() => validateRetailVariantPayload(parsed)).toThrow("Duplicate color/size in product");
  });

  it("accepts up to four variant images and rejects a fifth", () => {
    const base = {
      code: "IMAGE-TEE",
      name: "Image Tee",
      variants: [
        {
          color: "Black",
          size: "M",
          barcode: "IMAGE-001",
          cost: 5,
          sellingPrice: 10,
          stocks: [],
        },
      ],
    };
    const four = retailProductWriteSchema.safeParse({
      ...base,
      variants: [
        { ...base.variants[0], imageUrls: Array.from({ length: 4 }, (_, i) => `https://example.com/${i}.jpg`) },
      ],
    });
    const five = retailProductWriteSchema.safeParse({
      ...base,
      variants: [
        { ...base.variants[0], imageUrls: Array.from({ length: 5 }, (_, i) => `https://example.com/${i}.jpg`) },
      ],
    });
    expect(four.success).toBe(true);
    expect(five.success).toBe(false);
  });

  it("defaults legacy import color and accepts a variant image URL", () => {
    const row = retailImportRowSchema.parse({
      code: "IMPORT-1",
      name: "Imported Trouser",
      size: "M",
      barcode: "IMPORT-001",
      cost: 20,
      price: 40,
      qty: 1,
      location: "MAIN",
      variantImageUrl: "https://example.com/variant.jpg",
    });
    expect(row).toMatchObject({ color: "Default", variantImageUrl: "https://example.com/variant.jpg" });
  });

  it("exposes persisted color/image columns and matching client defaults", () => {
    expect(retailProductVariants.color).toBeDefined();
    expect(retailProductVariants.imageUrls).toBeDefined();
    expect(blankVariant()).toMatchObject({ color: "Default", imageUrls: [] });
    expect(MAX_VARIANT_IMAGES).toBe(4);
  });
});
