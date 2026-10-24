import { and, eq, isNull, or, sql } from "drizzle-orm";
import {
  retailImageUrlSchema,
  retailProductVariants, retailProducts,
} from "@shared/schema";
import { db } from "../../db";
import { getOrCreateBrand } from "./retailBrands";

/**
 * Phase 2 catalog-identity writer.
 *
 * Intentionally NOT exposed as a standalone HTTP endpoint: Phase 4 will call
 * this from INSIDE a supplier purchase transaction that also receives units,
 * journals Dr inventory / Cr supplier payable, and records idempotency.
 * Invoking this alone for a credit purchase would leave orphan catalog entries.
 */
type RetailTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface RetailSupplierCatalogWriteLine {
  name: string;
  brand: string;
  category: string;
  color: string;
  size: string;
  description?: string;
  sku?: string;
  barcode: string; // generated or confirmed by Phase 3 prior to calling
  barcodeSource: "generated" | "import";
  sellingPrice: number;
  costPrice: number;
  // Uploaded to /api/files/upload by the eventual Phase 4 confirmation pipeline,
  // with ownership checks for the CURRENT company before calling this writer.
  imageUrls: string[];
}

const normalize = (value: string) => value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");

function internalProductCode(brand: string, name: string) {
  const normalized = `${brand}-${name}`.normalize("NFKC").trim().toLowerCase()
    .replace(/\s+/g, "-").replace(/[^\p{L}\p{N}-]+/gu, "")
    .replace(/-+/g, "-").replace(/^-|-$/g, "");
  return `RTL-${normalized || "item"}`.slice(0, 100);
}

/** Product/variant writes only. Never writes inventory quantities, payables or accounting. */
export async function writeRetailSupplierCatalogLineTx(
  tx: RetailTransaction,
  companyId: number,
  line: RetailSupplierCatalogWriteLine
): Promise<{ productId: number; variantId: number; newProduct: boolean; newVariant: boolean }> {
  const brandName = line.brand.trim() || "Other / No Brand";
  const styleName = line.name.trim();
  const variantColor = line.color.trim() || "Default";
  const variantSize = line.size.trim() || "One Size";
  if (!companyId || !styleName || !line.category.trim() || !line.barcode.trim()) {
    throw new Error("Company, brand/style, category and resolved barcode are required");
  }
  if (!Number.isFinite(line.costPrice) || line.costPrice < 0 ||
      !Number.isFinite(line.sellingPrice) || line.sellingPrice < 0) {
    throw new Error("Invalid supplier unit cost or selling price");
  }
  if (line.imageUrls.length > 4 ||
      !line.imageUrls.every(url => retailImageUrlSchema.safeParse(url).success)) {
    throw new Error("Invalid retail supplier photo references (maximum 4 per variant)");
  }
  const brand = await getOrCreateBrand(tx, companyId, brandName);
  const brandStyles = await tx.select({
    id: retailProducts.id, name: retailProducts.name, code: retailProducts.code,
    category: retailProducts.category, imageUrls: retailProducts.imageUrls,
  }).from(retailProducts).where(
    and(eq(retailProducts.companyId, companyId),
      normalize(brandName) === normalize("Other / No Brand")
        ? or(eq(retailProducts.brandId, brand.id), isNull(retailProducts.brandId))
        : eq(retailProducts.brandId, brand.id))
  );
  const matched = brandStyles.filter(style => normalize(style.name) === normalize(styleName));
  if (matched.length > 1) throw new Error(`Ambiguous retail style: ${brandName} / ${styleName}`);
  let product = matched[0];
  let newProduct = false;

  if (!product) {
    const code = internalProductCode(brandName, styleName);
    const [occupied] = await tx.select({ id: retailProducts.id })
      .from(retailProducts).where(
        and(eq(retailProducts.companyId, companyId), eq(retailProducts.code, code))
      ).limit(1);
    if (occupied) throw new Error(`Retail style code conflict: ${code}`);
    const [created] = await tx.insert(retailProducts).values({
      companyId, code, name: styleName, brandId: brand.id,
      category: line.category.trim(), description: line.description?.trim() || null,
      imageUrls: line.imageUrls.length ? [line.imageUrls[0]] : [],
      active: true,
    }).returning({ id: retailProducts.id, name: retailProducts.name,
      code: retailProducts.code, category: retailProducts.category,
      imageUrls: retailProducts.imageUrls });
    product = created;
    newProduct = true;
  } else if (line.imageUrls.length && !product.imageUrls.length) {
    // Preserve existing cover photos; only fill missing cover image.
    await tx.update(retailProducts).set({
      imageUrls: [line.imageUrls[0]], updatedAt: new Date(),
    }).where(and(eq(retailProducts.companyId, companyId), eq(retailProducts.id, product.id)));
  }

  const siblings = await tx.select({
    id: retailProductVariants.id, color: retailProductVariants.color,
    size: retailProductVariants.size, sku: retailProductVariants.sku,
    barcode: retailProductVariants.barcode, imageUrls: retailProductVariants.imageUrls,
  }).from(retailProductVariants).where(
    and(eq(retailProductVariants.companyId, companyId), eq(retailProductVariants.productId, product.id))
  );
  const matchedVariants = siblings.filter(v =>
    normalize(v.color || "Default") === normalize(variantColor) && normalize(v.size || "One Size") === normalize(variantSize));
  if (matchedVariants.length > 1) throw new Error("Ambiguous color/size variant for supplier stock");
  const existing = matchedVariants[0];
  const suppliedSku = line.sku?.trim() || null;

  if (suppliedSku) {
    const [skuOwner] = await tx.select({ id: retailProductVariants.id })
      .from(retailProductVariants).where(
        and(eq(retailProductVariants.companyId, companyId), sql`lower(${retailProductVariants.sku}) = ${suppliedSku.toLowerCase()}`)
      ).limit(1);
    if (skuOwner && skuOwner.id !== existing?.id) throw new Error(`SKU already belongs to another variant: ${suppliedSku}`);
  }
  const [barcodeOwner] = await tx.select({ id: retailProductVariants.id })
    .from(retailProductVariants).where(
      and(eq(retailProductVariants.companyId, companyId), sql`lower(${retailProductVariants.barcode}) = ${line.barcode.trim().toLowerCase()}`)
    ).limit(1);
  if (barcodeOwner && barcodeOwner.id !== existing?.id) {
    throw new Error(`Barcode already belongs to another variant: ${line.barcode}`);
  }
  if (existing) {
    if (existing.barcode !== line.barcode.trim()) throw new Error("Existing variant barcode cannot be changed");
    if (suppliedSku && existing.sku && normalize(existing.sku) !== normalize(suppliedSku)) {
      throw new Error("Existing variant SKU cannot be changed by supplier import");
    }
    const appended = [...existing.imageUrls];
    for (const url of line.imageUrls) {
      if (!appended.includes(url) && appended.length < 4) appended.push(url);
    }
    await tx.update(retailProductVariants).set({
      imageUrls: appended,
      // The supplier's current price list refreshes future selling settings.
      // Historical sale-line prices/cost snapshots are never modified.
      sellingPrice: String(line.sellingPrice),
      cost: String(line.costPrice),
      ...(!existing.sku && suppliedSku ? { sku: suppliedSku } : {}),
      updatedAt: new Date(),
    }).where(and(eq(retailProductVariants.companyId, companyId), eq(retailProductVariants.id, existing.id)));
    return { productId: product.id, variantId: existing.id, newProduct, newVariant: false };
  }
  const [created] = await tx.insert(retailProductVariants).values({
    companyId, productId: product.id, color: variantColor, size: variantSize,
    barcode: line.barcode.trim(), barcodeSource: line.barcodeSource,
    sku: suppliedSku, imageUrls: line.imageUrls,
    cost: String(line.costPrice), sellingPrice: String(line.sellingPrice), active: true,
  }).returning({ id: retailProductVariants.id });
  return { productId: product.id, variantId: created.id, newProduct, newVariant: true };
}
