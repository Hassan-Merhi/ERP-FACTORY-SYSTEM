import { eq } from "drizzle-orm";
import { z } from "zod";
import { retailBrands, retailProducts, retailProductVariants } from "@shared/schema";
import { db } from "../../db";

const normalize = (value: string) => value.normalize("NFKC").trim().toLocaleLowerCase("en").replace(/\s+/g, " ");
const noBrand = "Other / No Brand";
const normVariant = (color: string, size: string) =>
  `${normalize(color || "Default")}|${normalize(size || "One Size")}`;

export const retailSupplierCatalogPreviewRowsSchema = z
  .array(
    z.object({
      rowNumber: z.number().int().min(2),
      name: z.string().trim().min(1).max(240),
      brand: z.string().trim().max(120).default(noBrand),
      category: z.string().trim().min(1).max(160),
      color: z.string().trim().max(100).default("Default"),
      size: z.string().trim().max(100).default(""),
      sku: z.string().trim().max(191).default(""),
      barcode: z.string().trim().max(191).default(""),
    })
  )
  .min(1)
  .max(5000);
export type RetailSupplierCatalogInput = z.infer<typeof retailSupplierCatalogPreviewRowsSchema>;
export type RetailSupplierCatalogStatus = "new-product" | "new-variant" | "existing-variant" | "conflict";
export interface RetailSupplierCatalogDecision {
  rowNumber: number;
  status: RetailSupplierCatalogStatus;
  productId: number | null;
  variantId: number | null;
  existingBarcode: string | null;
  messages: string[];
}
export type RetailSupplierCatalogSnapshot = {
  productId: number;
  productCode: string;
  productName: string;
  category: string | null;
  brandName: string | null;
  variantId: number | null;
  color: string | null;
  size: string | null;
  sku: string | null;
  barcode: string | null;
};
type Product = { id: number; code: string; name: string; brand: string; category: string | null };
type Variant = { id: number; productId: number; color: string; size: string; sku: string; barcode: string };

function makeProductCode(name: string, brand: string) {
  const identity = `${brand}-${name}`
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}-]+/gu, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return `RTL-${identity || "item"}`.slice(0, 100);
}

/** Pure catalog resolver; no writes, so duplicate/conflict decisions can be previewed safely. */
export function planRetailSupplierCatalog(rows: RetailSupplierCatalogInput, existing: RetailSupplierCatalogSnapshot[]) {
  const products = new Map<number, Product>();
  const variants = new Map<number, Variant>();
  const productsByIdentity = new Map<string, Product[]>();
  const productsByCode = new Map<string, Product>();
  const variantsBySku = new Map<string, Variant>();
  const variantsByBarcode = new Map<string, Variant>();
  const variantsByProduct = new Map<number, Map<string, Variant>>();

  for (const entry of existing) {
    if (!products.has(entry.productId)) {
      const product: Product = {
        id: entry.productId,
        code: entry.productCode,
        name: entry.productName,
        brand: entry.brandName || noBrand,
        category: entry.category,
      };
      products.set(product.id, product);
      const key = `${normalize(product.brand)}|${normalize(product.name)}`;
      productsByIdentity.set(key, [...(productsByIdentity.get(key) ?? []), product]);
      productsByCode.set(normalize(product.code), product);
    }
    if (entry.variantId && !variants.has(entry.variantId)) {
      const variant: Variant = {
        id: entry.variantId,
        productId: entry.productId,
        color: entry.color || "Default",
        size: entry.size || "One Size",
        sku: entry.sku ?? "",
        barcode: entry.barcode ?? "",
      };
      variants.set(variant.id, variant);
      if (variant.sku) variantsBySku.set(normalize(variant.sku), variant);
      if (variant.barcode) variantsByBarcode.set(normalize(variant.barcode), variant);
      const siblings = variantsByProduct.get(variant.productId) ?? new Map();
      siblings.set(normVariant(variant.color, variant.size), variant);
      variantsByProduct.set(variant.productId, siblings);
    }
  }
  const uploadKeys = new Set<string>();
  const uploadSkus = new Set<string>();
  const uploadBarcodes = new Set<string>();
  const seenNewStyles = new Set<string>();
  const newCodeOwners = new Map<string, string>();
  const usedExistingVariantIds = new Set<number>();

  const decisions: RetailSupplierCatalogDecision[] = rows.map((row) => {
    const warnings: string[] = [];
    const errors: string[] = [];
    const identity = `${normalize(row.brand || noBrand)}|${normalize(row.name)}`;
    const exactVariant = normVariant(row.color, row.size);
    const identityKey = `${identity}|${exactVariant}`;
    const skuKey = normalize(row.sku || "");
    const barcodeKey = normalize(row.barcode || "");
    if (uploadKeys.has(identityKey)) errors.push("Duplicate brand/item/color/size within spreadsheet");
    uploadKeys.add(identityKey);
    if (skuKey) {
      if (uploadSkus.has(skuKey)) errors.push("Duplicate SKU within spreadsheet");
      uploadSkus.add(skuKey);
    }
    if (barcodeKey) {
      if (uploadBarcodes.has(barcodeKey)) errors.push("Duplicate barcode within spreadsheet");
      uploadBarcodes.add(barcodeKey);
    }

    const candidates = productsByIdentity.get(identity) ?? [];
    const skuVariant = skuKey ? variantsBySku.get(skuKey) : undefined;
    const barcodeVariant = barcodeKey ? variantsByBarcode.get(barcodeKey) : undefined;
    if (skuVariant && barcodeVariant && skuVariant.id !== barcodeVariant.id) {
      errors.push("SKU and barcode belong to two different existing variants");
    }
    const identifiedVariant = skuVariant ?? barcodeVariant;
    if (candidates.length > 1) errors.push("More than one existing style matches this brand/name; review manually");
    let product: Product | undefined = candidates.length === 1 ? candidates[0] : undefined;
    if (identifiedVariant) {
      const owner = products.get(identifiedVariant.productId);
      if (product && product.id !== identifiedVariant.productId) {
        errors.push("Barcode/SKU belongs to a different style");
      } else if (
        !owner ||
        normalize(owner.brand) !== normalize(row.brand || noBrand) ||
        normalize(owner.name) !== normalize(row.name)
      ) {
        errors.push("Barcode/SKU is already used by a different brand or product");
      } else product = owner;
    }

    const variant = product ? variantsByProduct.get(product.id)?.get(exactVariant) : undefined;
    if (variant && identifiedVariant && variant.id !== identifiedVariant.id) {
      errors.push("Barcode/SKU belongs to another color or size");
    }
    if (!variant && identifiedVariant) errors.push("Barcode/SKU belongs to another color or size");
    if (variant) {
      if (skuKey && normalize(variant.sku) !== skuKey && variant.sku) {
        errors.push("Existing variant has a different SKU");
      }
      if (barcodeKey && normalize(variant.barcode) !== barcodeKey) {
        errors.push("Existing variant has a different barcode; leave blank to reuse it");
      }
      if (usedExistingVariantIds.has(variant.id)) errors.push("Existing variant appears multiple times in this file");
      usedExistingVariantIds.add(variant.id);
      if (!variant.barcode) errors.push("Existing variant is missing its stored barcode");
    }

    if (product && product.category && normalize(product.category) !== normalize(row.category)) {
      warnings.push(`Existing category is "${product.category}"; it will be preserved`);
    }

    if (!product) {
      const generatedCode = normalize(makeProductCode(row.name, row.brand || noBrand));
      const collision = productsByCode.get(generatedCode);
      if (collision) errors.push(`Generated style code is already used by "${collision.name}"`);
      const previousCodeOwner = newCodeOwners.get(generatedCode);
      if (previousCodeOwner && previousCodeOwner !== identity) {
        errors.push("Two different styles in this spreadsheet generate the same internal product code");
      }
      if (!previousCodeOwner) newCodeOwners.set(generatedCode, identity);
    }
    let status: RetailSupplierCatalogStatus;
    if (errors.length) status = "conflict";
    else if (variant) status = "existing-variant";
    else if (product || seenNewStyles.has(identity)) status = "new-variant";
    else status = "new-product";
    if (!product && !errors.length) seenNewStyles.add(identity);
    if (status === "new-variant" && !product) warnings.push("Another row will create this new style");

    return {
      rowNumber: row.rowNumber,
      status,
      productId: product?.id ?? null,
      variantId: variant?.id ?? null,
      existingBarcode: variant?.barcode ?? null,
      messages: [...errors, ...warnings],
    };
  });
  return {
    decisions,
    summary: {
      existingVariants: decisions.filter((d) => d.status === "existing-variant").length,
      newVariants: decisions.filter((d) => d.status === "new-variant").length,
      newProducts: decisions.filter((d) => d.status === "new-product").length,
      conflicts: decisions.filter((d) => d.status === "conflict").length,
    },
  };
}

/**
 * Shared catalog reader: Phase 3 finalization uses the SAME logic inside its
 * future purchase transaction. Preview results must never be trusted at posting time.
 */
export async function loadRetailSupplierCatalogSnapshot(
  executor: Pick<typeof db, "select">,
  companyId: number
): Promise<RetailSupplierCatalogSnapshot[]> {
  return executor
    .select({
      productId: retailProducts.id,
      productCode: retailProducts.code,
      productName: retailProducts.name,
      category: retailProducts.category,
      brandName: retailBrands.name,
      variantId: retailProductVariants.id,
      color: retailProductVariants.color,
      size: retailProductVariants.size,
      sku: retailProductVariants.sku,
      barcode: retailProductVariants.barcode,
    })
    .from(retailProducts)
    .leftJoin(retailBrands, eq(retailProducts.brandId, retailBrands.id))
    .leftJoin(retailProductVariants, eq(retailProductVariants.productId, retailProducts.id))
    .where(eq(retailProducts.companyId, companyId));
}

/** Read-only company-scoped catalog preview, no barcode sequences reserved. */
export async function previewRetailSupplierCatalog(companyId: number, rows: RetailSupplierCatalogInput) {
  const existing = await loadRetailSupplierCatalogSnapshot(db, companyId);
  return planRetailSupplierCatalog(rows, existing);
}
