// Extracted from ./retailRoutes.ts to keep that module under the source-size cap.
import type { Request } from "express";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  locations,
  RETAIL_DEFAULT_COLOR,
  RETAIL_NO_BRAND_NAME,
  retailBrands,
  retailProducts,
  retailProductVariants,
  type RetailProductWrite,
  retailVariantInventory,
} from "@shared/schema";
import { db } from "../db";
import { getOrCreateBrand, type RetailQueryExecutor } from "../services/retail/retailBrands";

export const normalize = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");

export const asNumber = (value: unknown) => Number(value ?? 0);

export async function resolveBrand(executor: RetailQueryExecutor, companyId: number, input: RetailProductWrite) {
  if (input.brandId) {
    const [brand] = await executor
      .select()
      .from(retailBrands)
      .where(and(eq(retailBrands.id, input.brandId), eq(retailBrands.companyId, companyId)))
      .limit(1);

    if (!brand) throw new Error("Brand not found for this company");
    return brand;
  }

  return getOrCreateBrand(executor, companyId, input.brandName);
}

export async function validateLocations(executor: RetailQueryExecutor, companyId: number, input: RetailProductWrite) {
  const ids = [...new Set(input.variants.flatMap((variant) => variant.stocks.map((stock) => stock.locationId)))];
  if (!ids.length) return;

  const valid = await executor
    .select({ id: locations.id })
    .from(locations)
    .where(and(eq(locations.companyId, companyId), inArray(locations.id, ids)));
  const validIds = new Set(valid.map((row) => row.id));
  const invalid = ids.find((id) => !validIds.has(id));

  if (invalid) throw new Error(`Location ${invalid} does not belong to the selected company`);
}

export async function assertUniqueBarcodes(
  executor: RetailQueryExecutor,
  companyId: number,
  variants: RetailProductWrite["variants"]
) {
  const barcodes = variants.map((variant) => variant.barcode.trim()).filter(Boolean);
  if (!barcodes.length) return;

  const existing = await executor
    .select({ id: retailProductVariants.id, barcode: retailProductVariants.barcode })
    .from(retailProductVariants)
    .where(and(eq(retailProductVariants.companyId, companyId), inArray(retailProductVariants.barcode, barcodes)));

  for (const row of existing) {
    const incoming = variants.find((variant) => variant.barcode.trim() === row.barcode);
    if (!incoming || incoming.id !== row.id) throw new Error(`Barcode already exists: ${row.barcode}`);
  }
}

export async function loadProducts(companyId: number, productId?: number) {
  const whereClause = productId
    ? and(eq(retailProducts.companyId, companyId), eq(retailProducts.id, productId))
    : eq(retailProducts.companyId, companyId);

  const rows = await db
    .select({
      productId: retailProducts.id,
      code: retailProducts.code,
      name: retailProducts.name,
      category: retailProducts.category,
      description: retailProducts.description,
      imageUrls: retailProducts.imageUrls,
      active: retailProducts.active,
      brandId: retailBrands.id,
      brandName: retailBrands.name,
      variantId: retailProductVariants.id,
      color: retailProductVariants.color,
      size: retailProductVariants.size,
      variantImageUrls: retailProductVariants.imageUrls,
      barcode: retailProductVariants.barcode,
      barcodeSource: retailProductVariants.barcodeSource,
      sku: retailProductVariants.sku,
      cost: retailProductVariants.cost,
      sellingPrice: retailProductVariants.sellingPrice,
      lowStockThreshold: retailProductVariants.lowStockThreshold,
      variantActive: retailProductVariants.active,
      locationId: retailVariantInventory.locationId,
      locationName: locations.name,
      quantity: retailVariantInventory.quantity,
    })
    .from(retailProducts)
    .leftJoin(retailBrands, eq(retailBrands.id, retailProducts.brandId))
    .leftJoin(retailProductVariants, eq(retailProductVariants.productId, retailProducts.id))
    .leftJoin(retailVariantInventory, eq(retailVariantInventory.variantId, retailProductVariants.id))
    .leftJoin(locations, eq(locations.id, retailVariantInventory.locationId))
    .where(whereClause)
    .orderBy(
      asc(retailProducts.name),
      asc(retailProductVariants.color),
      asc(retailProductVariants.size),
      asc(locations.name)
    );

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
  const variantMaps = new Map<number, Map<number, ProductResult["variants"][number]>>();

  for (const row of rows) {
    let product = products.get(row.productId);
    if (!product) {
      product = {
        id: row.productId,
        code: row.code,
        name: row.name,
        category: row.category,
        description: row.description,
        imageUrls: Array.isArray(row.imageUrls) ? row.imageUrls : [],
        active: row.active,
        brand: { id: row.brandId ?? null, name: row.brandName ?? RETAIL_NO_BRAND_NAME },
        variants: [],
        availableColors: [],
        availableSizes: [],
        totalQuantity: 0,
        minSellingPrice: 0,
        maxSellingPrice: 0,
      };
      products.set(row.productId, product);
      variantMaps.set(row.productId, new Map());
    }

    if (!row.variantId) continue;

    const productVariantMap = variantMaps.get(row.productId)!;
    let variant = productVariantMap.get(row.variantId);
    if (!variant) {
      variant = {
        id: row.variantId,
        color: row.color ?? RETAIL_DEFAULT_COLOR,
        size: row.size ?? "",
        imageUrls: Array.isArray(row.variantImageUrls)
          ? row.variantImageUrls.filter((value): value is string => typeof value === "string")
          : [],
        barcode: row.barcode ?? "",
        barcodeSource: row.barcodeSource ?? "manual",
        sku: row.sku,
        cost: asNumber(row.cost),
        sellingPrice: asNumber(row.sellingPrice),
        lowStockThreshold: asNumber(row.lowStockThreshold),
        active: row.variantActive ?? true,
        quantity: 0,
        stocks: [],
      };
      productVariantMap.set(row.variantId, variant);
      product.variants.push(variant);
    }

    if (row.locationId) {
      const quantity = asNumber(row.quantity);
      variant.quantity += quantity;
      variant.stocks.push({
        locationId: row.locationId,
        locationName: row.locationName ?? "",
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

export function filterProducts(products: Awaited<ReturnType<typeof loadProducts>>, query: Request["query"]) {
  const search = normalize(String(query.search ?? ""));
  const brandId = Number(query.brandId || 0);
  const color = normalize(String(query.color ?? ""));
  const size = normalize(String(query.size ?? ""));
  const category = normalize(String(query.category ?? ""));
  const locationId = Number(query.locationId || 0);
  const stockStatus = String(query.stockStatus ?? "all");

  return products.filter((product) => {
    if (
      search &&
      !normalize(
        `${product.code} ${product.name} ${product.brand.name} ${product.variants
          .map((variant) => `${variant.color} ${variant.size} ${variant.barcode} ${variant.sku ?? ""}`)
          .join(" ")}`
      ).includes(search)
    ) {
      return false;
    }
    if (brandId && product.brand.id !== brandId) return false;
    if (category && normalize(product.category ?? "") !== category) return false;
    if (color && !product.variants.some((variant) => normalize(variant.color) === color)) return false;
    if (size && !product.variants.some((variant) => normalize(variant.size) === size)) return false;
    if (
      locationId &&
      !product.variants.some((variant) => variant.stocks.some((stock) => stock.locationId === locationId))
    ) {
      return false;
    }
    if (stockStatus === "out" && product.totalQuantity !== 0) return false;
    if (
      stockStatus === "low" &&
      !product.variants.some((variant) => variant.quantity > 0 && variant.quantity <= variant.lowStockThreshold)
    ) {
      return false;
    }
    if (stockStatus === "in" && product.totalQuantity <= 0) return false;
    return true;
  });
}
