// Extracted from ./retailFashionRoutes.ts to keep that module under the source-size cap.
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  RETAIL_DEFAULT_COLOR,
  RETAIL_LABEL_LAYOUTS,
  retailBrands,
  retailImageUrlSchema,
  retailProducts,
  retailProductVariants,
} from "@shared/schema";
import { db } from "../db";

export const normalize = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");

export const toNumber = (value: unknown) => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

export class RetailQuickAddConflictError extends Error {
  readonly status = 409;
  constructor(
    message: string,
    readonly details: Record<string, unknown>
  ) {
    super(message);
  }
}

const quickAddVariantSchema = z.object({
  color: z.string().trim().min(1).max(100).optional().default(RETAIL_DEFAULT_COLOR),
  size: z.string().trim().min(1).max(100),
  quantity: z.coerce.number().finite().nonnegative().max(100000).optional().default(1),
  cost: z.coerce.number().finite().nonnegative().optional().default(0),
  sellingPrice: z.coerce.number().finite().nonnegative(),
  sku: z.string().trim().max(191).nullable().optional(),
  barcode: z.string().trim().max(191).optional().default(""),
  lowStockThreshold: z.coerce.number().finite().nonnegative().optional().default(0),
  imageUrls: z.array(retailImageUrlSchema).max(4).optional().default([]),
});

export const retailQuickAddSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(191),
  brandId: z.coerce.number().int().positive().nullable().optional(),
  brandName: z.string().trim().max(120).optional(),
  name: z.string().trim().min(1).max(240),
  category: z.string().trim().max(160).nullable().optional(),
  description: z.string().trim().max(5000).nullable().optional(),
  locationId: z.coerce.number().int().positive(),
  variants: z.array(quickAddVariantSchema).min(1).max(100),
});

export type RetailQuickAddInput = z.infer<typeof retailQuickAddSchema>;

/** Rejects repeated color/size and repeated typed barcodes inside one quick-add submission. */
export function validateQuickAddVariants(input: RetailQuickAddInput): void {
  const keys = new Set<string>();
  const barcodes = new Set<string>();
  for (const variant of input.variants) {
    const key = `${normalize(variant.color)}|${normalize(variant.size)}`;
    if (keys.has(key)) throw new Error(`Duplicate color/size in this item: ${variant.color} / ${variant.size}`);
    keys.add(key);
    if (variant.barcode) {
      const barcode = variant.barcode.trim();
      if (barcodes.has(barcode)) throw new Error(`Duplicate barcode in this item: ${variant.barcode}`);
      barcodes.add(barcode);
    }
  }
}

export function productCodeFor(brandName: string, name: string, suffix = "") {
  const identity = `${brandName}-${name}`
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}-]+/gu, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return `RTL-${identity || "item"}`.slice(0, 100 - suffix.length) + suffix;
}

export const labelRequestSchema = z.object({
  layout: z.enum(RETAIL_LABEL_LAYOUTS),
  items: z
    .array(
      z.object({
        variantId: z.coerce.number().int().positive(),
        copies: z.coerce.number().int().min(1).max(500).optional().default(1),
      })
    )
    .min(1)
    .max(500),
});

export async function loadLabelRows(companyId: number, variantIds: number[]) {
  const rows = await db
    .select({
      variantId: retailProductVariants.id,
      productId: retailProducts.id,
      name: retailProducts.name,
      brand: retailBrands.name,
      color: retailProductVariants.color,
      size: retailProductVariants.size,
      barcode: retailProductVariants.barcode,
      barcodeSource: retailProductVariants.barcodeSource,
      sku: retailProductVariants.sku,
      sellingPrice: retailProductVariants.sellingPrice,
      active: retailProductVariants.active,
    })
    .from(retailProductVariants)
    .innerJoin(retailProducts, eq(retailProducts.id, retailProductVariants.productId))
    .leftJoin(retailBrands, eq(retailBrands.id, retailProducts.brandId))
    .where(and(eq(retailProductVariants.companyId, companyId), inArray(retailProductVariants.id, variantIds)));
  // Labels print in the order the caller listed the variants, not in whatever
  // order the database returns them.
  const position = new Map(variantIds.map((id, index) => [id, index]));
  return rows.sort((a, b) => (position.get(a.variantId) ?? 0) - (position.get(b.variantId) ?? 0));
}
