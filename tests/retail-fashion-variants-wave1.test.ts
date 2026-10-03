import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  retailImportRowSchema,
  retailProductVariants,
  retailProductWriteSchema,
} from "../shared/schema";

const root = process.cwd();
const migrationPath = path.join(root, "migrations/20261003_001_retail_fashion_variants.sql");
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), "utf8");

describe("retail fashion variants wave 1 schema", () => {
  it("defaults legacy variant color to Default and keeps variant images empty", () => {
    const parsed = retailProductWriteSchema.parse({
      code: "LEGACY-TEE",
      name: "Legacy Tee",
      variants: [
        {
          size: "M",
          barcode: "LEGACY-001",
          cost: 5,
          sellingPrice: 10,
          stocks: [],
        },
      ],
    });

    expect(parsed.variants[0].color).toBe("Default");
    expect(parsed.variants[0].imageUrls).toEqual([]);
  });

  it("accepts explicit color and up to four variant images", () => {
    const imageUrls = [
      "https://example.com/1.jpg",
      "https://example.com/2.jpg",
      "https://example.com/3.jpg",
      "https://example.com/4.jpg",
    ];
    const parsed = retailProductWriteSchema.parse({
      code: "COLOR-TEE",
      name: "Color Tee",
      variants: [
        {
          color: " Black ",
          size: "M",
          barcode: "COLOR-001",
          imageUrls,
          cost: 5,
          sellingPrice: 10,
          stocks: [],
        },
      ],
    });

    expect(parsed.variants[0].color).toBe("Black");
    expect(parsed.variants[0].imageUrls).toEqual(imageUrls);
  });

  it("rejects blank color and more than four variant images", () => {
    const blankColor = retailProductWriteSchema.safeParse({
      code: "BAD-COLOR",
      name: "Bad Color",
      variants: [
        {
          color: "   ",
          size: "M",
          barcode: "BAD-COLOR-001",
          cost: 5,
          sellingPrice: 10,
          stocks: [],
        },
      ],
    });
    expect(blankColor.success).toBe(false);

    const tooManyImages = retailProductWriteSchema.safeParse({
      code: "TOO-MANY",
      name: "Too Many Images",
      variants: [
        {
          color: "Black",
          size: "M",
          barcode: "TOO-MANY-001",
          imageUrls: Array.from({ length: 5 }, (_, index) => `https://example.com/${index}.jpg`),
          cost: 5,
          sellingPrice: 10,
          stocks: [],
        },
      ],
    });
    expect(tooManyImages.success).toBe(false);
  });

  it("defaults omitted import color to Default and accepts a variant image URL", () => {
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

    expect(row.color).toBe("Default");
    expect(row.variantImageUrl).toBe("https://example.com/variant.jpg");
  });

  it("exposes color and imageUrls columns on retail variants", () => {
    expect(retailProductVariants.color).toBeDefined();
    expect(retailProductVariants.imageUrls).toBeDefined();
  });

  it("ships a migration from product+size uniqueness to product+color+size uniqueness", () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
    if (!fs.existsSync(migrationPath)) return;

    const sql = fs.readFileSync(migrationPath, "utf8");
    expect(sql).toContain("retail_product_variants_product_size_unique");
    expect(sql).toContain("retail_product_variants_product_color_size_unique");
    expect(sql).toContain("color");
    expect(sql).toContain("image_urls");
  });
});

describe("retail fashion variants wave 1 catalog and import contract", () => {
  it("uses normalized color plus size as the in-product variant identity", () => {
    const routes = read("server/routes/retailRoutes.ts");
    expect(routes).toContain("const variantKey = `${normalize(variant.color)}|${normalize(variant.size)}`");
    expect(routes).toContain("Duplicate color/size in product");
  });

  it("persists and returns color and variant images", () => {
    const routes = read("server/routes/retailRoutes.ts");
    expect(routes).toContain("color: retailProductVariants.color");
    expect(routes).toContain("variantImageUrls: retailProductVariants.imageUrls");
    expect(routes).toContain("color: variantInput.color");
    expect(routes).toContain("imageUrls: variantInput.imageUrls");
    expect(routes).toContain("availableColors");
  });

  it("groups imports by product, color and size while keeping legacy color defaults", () => {
    const routes = read("server/routes/retailRoutes.ts");
    expect(routes).toContain("${normalize(row.code)}|${normalize(row.color)}|${normalize(row.size)}");
    expect(routes).toContain("${product.id}|${normalize(row.color)}|${normalize(row.size)}");
    expect(routes).toContain("imageUrls: row.variantImageUrl ? [row.variantImageUrl] : []");
  });

  it("supports catalog color search, filtering and facets", () => {
    const catalog = read("server/routes/retailCatalogRoutes.ts");
    expect(catalog).toContain("color: normalize(req.query.color)");
    expect(catalog).toContain("LOWER(color_variant.color)");
    expect(catalog).toContain("v.color");
    expect(catalog).toContain("availableColors");
    expect(catalog).toContain("colors:");
  });
});
