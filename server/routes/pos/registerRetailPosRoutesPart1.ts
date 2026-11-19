// Extracted from ./retailPosRoutes.ts to keep that module under the source-size cap.
import type { Express } from "express";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { locations, retailBrands, retailProducts, retailProductVariants, retailVariantInventory } from "@shared/schema";
import { requireAuth } from "../../auth";
import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import {
  emptyQuery,
  positiveIntParam,
  validateRequest,
  validatedInput,
  type RequestSchemas,
} from "../../lib/validateRequest";
import { ensureCompanyLocation, requireRetailCompany, toNumber } from "./retailPosContext";
import { evaluateRetailDiscountPolicy } from "../../services/retail/retailDiscountApproval";
import { effectiveManualDiscountPercent, hasManualAdjustment } from "../../services/retail/retailPricing";
import { listActiveRetailPromotions } from "../../services/retail/retailPromotions";
import { loadRetailSettings } from "../../services/retail/retailSettings";
import {
  prepareRetailSalePricing,
  resolveRetailItemImages,
  type RetailSaleLineRequest,
} from "../../services/retail/retailSaleService";
import { registerRetailPosRoutesPart4 } from "./registerRetailPosRoutesPart4";

const idempotencyKeySchema = z.string().trim().min(8).max(191);

const positiveQuantitySchema = z.coerce.number().finite().positive();

const paymentSchema = z.strictObject({
  method: z.enum(["cash", "card", "bank", "mobile", "other", "credit"]),
  amount: z.coerce.number().finite().positive(),
  // Non-cash and customer-credit tenders do not have a cash-tendered amount.
  tenderedAmount: z.coerce.number().finite().positive().nullable().optional(),
  reference: z.string().trim().max(191).optional(),
  ledgerAccountId: z.number().int().positive().nullable().optional(),
  bankAccountId: z.number().int().positive().nullable().optional(),
});

const saleItemSchema = z.strictObject({
  variantId: z.coerce.number().int().positive(),
  quantity: positiveQuantitySchema,
  priceOverride: z.coerce.number().finite().nonnegative().nullable().optional(),
  discountType: z.enum(["none", "percent", "fixed"]).optional(),
  discountValue: z.coerce.number().finite().nonnegative().optional(),
  discountReason: z.string().trim().max(500).nullable().optional(),
});

export const saleSchema = z.strictObject({
  locationId: z.coerce.number().int().positive(),
  idempotencyKey: idempotencyKeySchema,
  notes: z.string().trim().max(2000).optional(),
  shiftId: z.coerce.number().int().positive().optional(),
  payments: z.array(paymentSchema).min(1).max(8).optional(),
  customerId: z.coerce.number().int().positive().nullable().optional(),
  customerName: z.string().trim().max(191).nullable().optional(),
  orderDiscount: z
    .strictObject({
      type: z.enum(["none", "percent", "fixed"]),
      value: z.coerce.number().finite().nonnegative().optional(),
      reason: z.string().trim().max(500).nullable().optional(),
    })
    .optional(),
  approvalToken: z.string().trim().max(4000).optional(),
  items: z.array(saleItemSchema).min(1).max(250),
});

const cartPreviewSchema = z.strictObject({
  locationId: z.coerce.number().int().positive().optional(),
  items: z.array(saleItemSchema).min(1).max(250),
  orderDiscount: z
    .strictObject({
      type: z.enum(["none", "percent", "fixed"]),
      value: z.coerce.number().finite().nonnegative().optional(),
      reason: z.string().trim().max(500).nullable().optional(),
    })
    .optional(),
});

export const returnSchema = z.strictObject({
  locationId: z.coerce.number().int().positive(),
  idempotencyKey: idempotencyKeySchema,
  shiftId: z.coerce.number().int().positive().optional(),
  notes: z.string().trim().max(2000).optional(),
  refundDestination: z.enum(["original", "customer_credit", "account"]).default("original"),
  refundLedgerAccountId: z.number().int().positive().nullable().optional(),
  refundBankAccountId: z.number().int().positive().nullable().optional(),
  items: z
    .array(
      z.strictObject({
        saleItemId: z.coerce.number().int().positive(),
        quantity: positiveQuantitySchema,
        restock: z.boolean().default(true),
      })
    )
    .min(1)
    .max(250),
});

export const transferSchema = z.strictObject({
  idempotencyKey: idempotencyKeySchema,
  variantId: z.coerce.number().int().positive(),
  fromLocationId: z.coerce.number().int().positive(),
  toLocationId: z.coerce.number().int().positive(),
  quantity: positiveQuantitySchema,
  notes: z.string().trim().max(2000).optional(),
});

export const adjustmentSchema = z.strictObject({
  idempotencyKey: idempotencyKeySchema,
  variantId: z.coerce.number().int().positive(),
  locationId: z.coerce.number().int().positive(),
  quantityDelta: z.coerce
    .number()
    .finite()
    .refine((value) => value !== 0, "Adjustment cannot be zero"),
  reason: z.string().trim().min(1).max(500),
  reference: z.string().trim().max(191).optional(),
});

export const cartPreviewInput = { query: emptyQuery, body: cartPreviewSchema } satisfies RequestSchemas;
export const saleInput = { query: emptyQuery, body: saleSchema } satisfies RequestSchemas;
export const returnInput = {
  params: z.strictObject({ saleId: positiveIntParam }),
  query: emptyQuery,
  body: returnSchema,
} satisfies RequestSchemas;
export const transferInput = { query: emptyQuery, body: transferSchema } satisfies RequestSchemas;
export const adjustmentInput = { query: emptyQuery, body: adjustmentSchema } satisfies RequestSchemas;

export function registerRetailPosRoutesPart1(app: Express) {
  registerRetailPosRoutesPart4(app);

  /**
   * Prices a cart without selling it. The POS uses this to render the exact
   * Subtotal → Discount → Tax → Total ladder and to warn the cashier that a manager
   * approval is required, so the client never re-implements the money math.
   */
  app.post("/api/pos/retail/cart-preview", requireAuth, validateRequest(cartPreviewInput), async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const body = validatedInput(req, cartPreviewInput).body;
      if (body.locationId) await ensureCompanyLocation(companyId, body.locationId);
      const requestedLines: RetailSaleLineRequest[] = body.items.map((item) => ({
        variantId: item.variantId,
        quantity: item.quantity,
        priceOverride: item.priceOverride ?? null,
        discountType: item.discountType ?? "none",
        discountValue: item.discountValue ?? 0,
        discountReason: item.discountReason ?? null,
      }));
      const settings = await loadRetailSettings(companyId);
      const promotions = await listActiveRetailPromotions(companyId);
      const orderDiscount = {
        type: body.orderDiscount?.type ?? ("none" as const),
        value: body.orderDiscount?.value ?? 0,
        reason: body.orderDiscount?.reason ?? null,
      };
      const { priced } = await prepareRetailSalePricing(db, {
        companyId,
        items: requestedLines,
        orderDiscount,
        settings,
        promotions,
      });
      const manual = hasManualAdjustment(priced, orderDiscount);
      const effectiveDiscountPercent = effectiveManualDiscountPercent(priced);
      const hasPriceOverride = priced.lines.some((line) => line.priceOverride);
      const policy = evaluateRetailDiscountPolicy({
        role: req.user?.role,
        discountLimitPercent: settings.discountLimitPercent,
        requireManagerApproval: settings.requireManagerApproval,
        priceOverrideRequiresApproval: settings.priceOverrideRequiresApproval,
        effectiveDiscountPercent,
        hasPriceOverride,
        hasManualDiscount: manual.any,
      });
      res.json({
        settings: { ...settings, taxRatePercent: Number((settings.taxRate * 100).toFixed(5)) },
        policy: {
          ...policy,
          hasPriceOverride,
          hasManualDiscount: manual.any,
          effectiveDiscountPercent: Number(effectiveDiscountPercent.toFixed(6)),
        },
        pricing: priced,
      });
    } catch (error) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/pos/retail/barcodes/:barcode", requireAuth, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const locationId = Number(req.query.locationId);
      if (!Number.isInteger(locationId) || locationId <= 0)
        return res.status(400).json({ message: "Location is required" });
      await ensureCompanyLocation(companyId, locationId);
      const barcode = String(req.params.barcode ?? "").trim();
      if (!barcode) return res.status(400).json({ message: "Barcode is required" });

      const lookup = (match: ReturnType<typeof eq>) =>
        db
          .select({
            variantId: retailProductVariants.id,
            productId: retailProducts.id,
            code: retailProducts.code,
            name: retailProducts.name,
            brand: retailBrands.name,
            color: retailProductVariants.color,
            variantImageUrls: retailProductVariants.imageUrls,
            productImageUrls: retailProducts.imageUrls,
            size: retailProductVariants.size,
            sku: retailProductVariants.sku,
            barcode: retailProductVariants.barcode,
            price: retailProductVariants.sellingPrice,
            quantity: retailVariantInventory.quantity,
            variantActive: retailProductVariants.active,
            productActive: retailProducts.active,
          })
          .from(retailProductVariants)
          .innerJoin(retailProducts, eq(retailProducts.id, retailProductVariants.productId))
          .leftJoin(retailBrands, eq(retailBrands.id, retailProducts.brandId))
          .leftJoin(
            retailVariantInventory,
            and(
              eq(retailVariantInventory.variantId, retailProductVariants.id),
              eq(retailVariantInventory.locationId, locationId),
              eq(retailVariantInventory.companyId, companyId)
            )
          )
          .where(and(eq(retailProductVariants.companyId, companyId), match))
          .limit(1);
      // Exact match first; scanners and keyboards sometimes change letter case of alphanumeric codes.
      let [row] = await lookup(eq(retailProductVariants.barcode, barcode));
      if (!row) [row] = await lookup(sql`lower(${retailProductVariants.barcode}) = lower(${barcode})`);
      if (!row) return res.status(404).json({ code: "BARCODE_NOT_FOUND", message: "Barcode not found" });

      const { variantImageUrls, productImageUrls, variantActive, productActive, ...rest } = row;
      const otherLocations = await db
        .select({
          locationId: retailVariantInventory.locationId,
          locationName: locations.name,
          quantity: retailVariantInventory.quantity,
        })
        .from(retailVariantInventory)
        .innerJoin(locations, eq(locations.id, retailVariantInventory.locationId))
        .where(
          and(
            eq(retailVariantInventory.companyId, companyId),
            eq(retailVariantInventory.variantId, row.variantId),
            sql`${retailVariantInventory.locationId} <> ${locationId}`,
            sql`${retailVariantInventory.quantity} > 0`
          )
        )
        .orderBy(locations.name);
      const item = {
        ...rest,
        imageUrls: resolveRetailItemImages(variantImageUrls, productImageUrls),
        brand: row.brand ?? "Other / No Brand",
        price: toNumber(row.price),
        quantity: toNumber(row.quantity),
        active: Boolean(variantActive && productActive),
        otherLocations: otherLocations.map((entry) => ({ ...entry, quantity: toNumber(entry.quantity) })),
      };
      if (!item.active) {
        return res
          .status(409)
          .json({ code: "ITEM_INACTIVE", message: "This item is archived and cannot be sold", item });
      }
      res.json(item);
    } catch (error) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });
}
