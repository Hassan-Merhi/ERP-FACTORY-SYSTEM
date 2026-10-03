import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { retailImportRowSchema, retailProductVariants, retailProductWriteSchema } from "../shared/schema";
import { blankVariant, MAX_VARIANT_IMAGES } from "../client/src/pages/retail/retailInventoryTypes";

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

describe("retail fashion variants wave 1 POS and reporting contract", () => {
  it("returns exact variant color and prefers variant images with product fallback", () => {
    const pos = read("server/routes/pos/retailPosRoutes.ts");
    expect(pos).toContain("color: retailProductVariants.color");
    expect(pos).toContain("variantImageUrls: retailProductVariants.imageUrls");
    expect(pos).toContain("productImageUrls: retailProducts.imageUrls");
    expect(pos).toContain("resolveRetailItemImages");
    expect(pos).toContain("imageUrls: resolveRetailItemImages");
  });

  it("searches POS items by color and keeps exact color in sale history", () => {
    const pos = read("server/routes/pos/retailPosRoutes.ts");
    expect(pos).toContain("punctuationInsensitiveSearch(retailProductVariants.color, search)");
    expect(pos).toContain("color: retailProductVariants.color");
    expect(pos).toContain("loadSaleResponse");
  });

  it("exposes color on low-stock, out-of-stock and slow-moving reporting rows", () => {
    const reporting = read("server/services/retail/retailReporting.ts");
    expect(reporting.match(/v\.color/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(reporting).toContain("GROUP BY p.id, p.code, p.name, b.name, v.id, v.color, v.size, v.barcode");
    expect(reporting).toContain("GROUP BY v.id, p.id, p.code, p.name, b.name, v.color, v.size, v.barcode");
  });
});

describe("retail fashion variants wave 1 inventory UI contract", () => {
  it("defaults new client variants to Default color and no variant images", () => {
    const variant = blankVariant();
    expect(variant.color).toBe("Default");
    expect(variant.imageUrls).toEqual([]);
    expect(MAX_VARIANT_IMAGES).toBe(4);
  });

  it("preserves color and variant images through the product editor payload", () => {
    const editor = read("client/src/pages/retail/RetailProductEditor.tsx");
    expect(editor).toContain("color: variant.color");
    expect(editor).toContain("imageUrls: [...(variant.imageUrls ?? [])]");
    expect(editor).toContain("color: variant.color.trim()");
    expect(editor).toContain("imageUrls: variant.imageUrls");
    expect(editor).toContain("uploadVariantImages");
    expect(editor).toContain("MAX_VARIANT_IMAGES");
    expect(editor).toContain("<Label>Color *</Label>");
    expect(editor).toContain("<Label>Variant images</Label>");
  });

  it("exposes color facets, filtering and separate color/size inventory display", () => {
    const types = read("client/src/pages/retail/retailInventoryTypes.ts");
    const inventory = read("client/src/pages/retail/RetailInventory.tsx");
    expect(types).toContain("availableColors: string[]");
    expect(types).toContain("colors: string[]");
    expect(inventory).toContain('const [color, setColor] = useState("")');
    expect(inventory).toContain('params.set("color", color)');
    expect(inventory).toContain("catalogFacets?.colors");
    expect(inventory).toContain("{variant.color}");
    expect(inventory).toContain("product.availableColors");
  });
});

describe("retail fashion variants wave 1 inventory and editor contract", () => {
  it("models color and variant images in client inventory types", () => {
    const types = read("client/src/pages/retail/retailInventoryTypes.ts");
    expect(types).toContain("MAX_VARIANT_IMAGES = 4");
    expect(types).toContain("color: string;");
    expect(types).toContain("imageUrls: string[];");
    expect(types).toContain("availableColors: string[];");
    expect(types).toContain("colors: string[];");
    expect(types).toContain('color: "Default"');
  });

  it("preserves and saves color plus variant images in the product editor", () => {
    const editor = read("client/src/pages/retail/RetailProductEditor.tsx");
    expect(editor).toContain("color: variant.color");
    expect(editor).toContain("imageUrls: [...(variant.imageUrls ?? [])]");
    expect(editor).toContain("color: variant.color.trim()");
    expect(editor).toContain("imageUrls: variant.imageUrls");
    expect(editor).toContain("<Label>Color *</Label>");
    expect(editor).toContain("MAX_VARIANT_IMAGES");
    expect(editor).toContain('fetch("/api/files/upload"');
  });

  it("filters and displays inventory by color without losing size", () => {
    const inventory = read("client/src/pages/retail/RetailInventory.tsx");
    expect(inventory).toContain('const [color, setColor] = useState("")');
    expect(inventory).toContain('params.set("color", color)');
    expect(inventory).toContain("catalogFacets?.colors");
    expect(inventory).toContain("All colors");
    expect(inventory).toContain("availableColors");
    expect(inventory).toContain(">Color<");
    expect(inventory).toContain(">Size<");
  });
});

describe("retail fashion variants wave 1 POS UI contract", () => {
  it("threads color through POS item and sale item types", () => {
    const pos = read("client/src/pages/pos/RetailPOS.tsx");
    expect(pos).toContain("interface RetailPosItem");
    expect(pos).toContain("interface SaleItem");
    expect(pos.match(/color: string;/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("shows color and size when scanning and browsing exact variants", () => {
    const pos = read("client/src/pages/pos/RetailPOS.tsx");
    expect(pos).toContain("item.color");
    expect(pos).toContain("line.color");
    expect(pos).toContain("{item.name} · {item.color} · {item.size}");
  });

  it("identifies color plus size in cart, sale history, and transfers", () => {
    const pos = read("client/src/pages/pos/RetailPOS.tsx");
    expect(pos).toContain("{line.brand} · {line.color} · {line.size} · {line.barcode}");
    expect(pos).toContain("{item.name} · {item.color} · {item.size}");
    expect(pos).toContain("{item.name} · {item.brand} · {item.color} · {item.size} · Qty {item.quantity}");
  });
});

describe("retail fashion variants wave 1 import UI contract", () => {
  it("includes color and variant image URL in the Excel template and mapping", () => {
    const importer = read("client/src/pages/retail/RetailImportDialog.tsx");
    expect(importer).toContain('Color: "Black"');
    expect(importer).toContain('VariantImageUrl: "https://example.com/runner-black.jpg"');
    expect(importer).toContain('color: String(row.get("color") ?? "Default").trim() || "Default"');
    expect(importer).toContain('variantImageUrl: String(row.get("variantimageurl") ?? "").trim() || undefined');
    expect(importer).toContain("Name | Brand | Color | Size");
    expect(importer).toContain("VariantImageUrl");
  });
});

describe("retail fashion variants wave 1 dashboard UI contract", () => {
  it("shows color and size for stock-health variant rows", () => {
    const dashboard = read("client/src/pages/retail/RetailDashboard.tsx");
    expect(dashboard).toContain("color?: string;");
    expect(dashboard).toContain('<th className="px-3 py-2">Color</th>');
    expect(dashboard).toContain('{row.color ?? "—"}');
    expect(dashboard).toContain('<th className="px-3 py-2">Size</th>');
  });
});

describe("retail fashion variants wave 1 variant image display contract", () => {
  it("shows an exact variant image in inventory with product-image fallback", () => {
    const inventory = read("client/src/pages/retail/RetailInventory.tsx");
    expect(inventory).toContain("variant.imageUrls[0] || detailProduct.imageUrls[0]");
    expect(inventory).toContain("alt={`${detailProduct.name} · ${variant.color} · ${variant.size}`}");
  });
});
