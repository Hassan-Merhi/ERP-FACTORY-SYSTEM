// Extracted from ./retailCatalogRoutes.ts
import { numberValue, type CatalogProductRow } from "./buildCatalogWhere";

export function assembleProducts(rows: CatalogProductRow[]) {
  type ProductResult = {
    id: number;
    code: string;
    name: string;
    category: string | null;
    description: string | null;
    imageUrls: string[];
    active: boolean;
    brand: { id: number | null; name: string };
    variants: Array<{
      id: number;
      color: string;
      size: string;
      imageUrls: string[];
      barcode: string;
      barcodeSource: string;
      sku: string | null;
      cost: number;
      sellingPrice: number;
      lowStockThreshold: number;
      active: boolean;
      quantity: number;
      stocks: Array<{ locationId: number; locationName: string; quantity: number }>;
    }>;
    availableColors: string[];
    availableSizes: string[];
    totalQuantity: number;
    minSellingPrice: number;
    maxSellingPrice: number;
  };

  const products = new Map<number, ProductResult>();
  const variants = new Map<number, Map<number, ProductResult["variants"][number]>>();

  for (const row of rows) {
    let product = products.get(row.product_id);
    if (!product) {
      product = {
        id: row.product_id,
        code: row.code,
        name: row.name,
        category: row.category,
        description: row.description,
        imageUrls: Array.isArray(row.image_urls)
          ? row.image_urls.filter((value): value is string => typeof value === "string")
          : [],
        active: row.active,
        brand: { id: row.brand_id, name: row.brand_name ?? "Other / No Brand" },
        variants: [],
        availableColors: [],
        availableSizes: [],
        totalQuantity: 0,
        minSellingPrice: 0,
        maxSellingPrice: 0,
      };
      products.set(row.product_id, product);
      variants.set(row.product_id, new Map());
    }

    if (!row.variant_id) continue;
    const productVariants = variants.get(row.product_id)!;
    let variant = productVariants.get(row.variant_id);
    if (!variant) {
      variant = {
        id: row.variant_id,
        color: row.color ?? "Default",
        size: row.size ?? "",
        imageUrls: Array.isArray(row.variant_image_urls)
          ? row.variant_image_urls.filter((value): value is string => typeof value === "string")
          : [],
        barcode: row.barcode ?? "",
        barcodeSource: row.barcode_source ?? "manual",
        sku: row.sku,
        cost: numberValue(row.cost),
        sellingPrice: numberValue(row.selling_price),
        lowStockThreshold: numberValue(row.low_stock_threshold),
        active: row.variant_active !== false,
        quantity: 0,
        stocks: [],
      };
      productVariants.set(row.variant_id, variant);
      product.variants.push(variant);
    }

    if (row.location_id) {
      const quantity = numberValue(row.quantity);
      variant.quantity += quantity;
      variant.stocks.push({
        locationId: row.location_id,
        locationName: row.location_name ?? "",
        quantity,
      });
    }
  }

  for (const product of products.values()) {
    const activeVariants = product.variants.filter((variant) => variant.active);
    product.availableColors = [...new Set(activeVariants.map((variant) => variant.color))];
    product.availableSizes = [...new Set(activeVariants.map((variant) => variant.size))];
    product.totalQuantity = activeVariants.reduce((sum, variant) => sum + variant.quantity, 0);
    const prices = activeVariants.map((variant) => variant.sellingPrice);
    product.minSellingPrice = prices.length ? Math.min(...prices) : 0;
    product.maxSellingPrice = prices.length ? Math.max(...prices) : 0;
  }

  return [...products.values()];
}
