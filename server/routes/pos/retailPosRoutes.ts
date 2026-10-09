import { punctuationInsensitiveSearch } from "../../lib/searchNormalization";
import type { Express } from "express";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  customers,
  locations,
  retailBrands,
  retailPosSales,
  retailProductVariants,
  retailProducts,
  retailDiscountApprovals,
  retailStockMovements,
  retailStockOperations,
  retailVariantInventory,
} from "@shared/schema";
import { requireAuth } from "../../auth";
import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { currentUserId, ensureCompanyLocation, requireRetailCompany } from "./retailPosContext";
import {
  addMovement,
  lockInventoryRow,
  nextAverageCost,
  setInventoryQuantity,
} from "../../services/retail/retailStockLedger";
import { trackRetailStockValueTx } from "../../services/retail/retailInventoryJournal";
import {
  approvalCoversRequest,
  evaluateRetailDiscountPolicy,
  ExpiredRetailApprovalTokenError,
  InvalidRetailApprovalTokenError,
  retailApprovalFingerprint,
  RetailApprovalReuseError,
  verifyRetailApprovalToken,
} from "../../services/retail/retailDiscountApproval";
import {
  effectiveManualDiscountPercent,
  hasManualAdjustment,
  roundRetailMoney,
} from "../../services/retail/retailPricing";
import { bestPromotionForLine, listActiveRetailPromotions } from "../../services/retail/retailPromotions";
import { loadRetailSettings } from "../../services/retail/retailSettings";
import {
  createRetailReturnInTx,
  createRetailSaleInTx,
  ensureRetailVariant,
  loadSaleResponse,
  prepareRetailSalePricing,
  resolveRetailItemImages,
  type RetailSaleInput,
  type RetailSaleLineRequest,
} from "../../services/retail/retailSaleService";
import { aggregateRetailCartItems, nextRetailTransferQuantities } from "../../services/retail/retailStockMath";
import {
  postRetailRefundAccountingTx,
  refundRetailPaymentsTx,
  validateRetailShiftTx,
} from "../../services/retail/retailFinancialService";
import { registerRetailPosCancellationRoute } from "./retailPosCancellationRoutes";

const idempotencyKeySchema = z.string().trim().min(8).max(191);
const positiveQuantitySchema = z.coerce.number().finite().positive();

const paymentSchema = z.object({
  method: z.enum(["cash", "card", "bank", "mobile", "other"]),
  amount: z.coerce.number().finite().positive(),
  tenderedAmount: z.coerce.number().finite().positive().optional(),
  reference: z.string().trim().max(191).optional(),
});

const saleItemSchema = z.object({
  variantId: z.coerce.number().int().positive(),
  quantity: positiveQuantitySchema,
  priceOverride: z.coerce.number().finite().nonnegative().nullable().optional(),
  discountType: z.enum(["none", "percent", "fixed"]).optional(),
  discountValue: z.coerce.number().finite().nonnegative().optional(),
  discountReason: z.string().trim().max(500).nullable().optional(),
});

const saleSchema = z.object({
  locationId: z.coerce.number().int().positive(),
  idempotencyKey: idempotencyKeySchema,
  notes: z.string().trim().max(2000).optional(),
  shiftId: z.coerce.number().int().positive().optional(),
  payments: z.array(paymentSchema).min(1).max(8).optional(),
  customerId: z.coerce.number().int().positive().nullable().optional(),
  customerName: z.string().trim().max(191).nullable().optional(),
  orderDiscount: z
    .object({
      type: z.enum(["none", "percent", "fixed"]),
      value: z.coerce.number().finite().nonnegative().optional(),
      reason: z.string().trim().max(500).nullable().optional(),
    })
    .optional(),
  approvalToken: z.string().trim().max(4000).optional(),
  items: z.array(saleItemSchema).min(1).max(250),
});

const cartPreviewSchema = z.object({
  locationId: z.coerce.number().int().positive().optional(),
  items: z.array(saleItemSchema).min(1).max(250),
  orderDiscount: z
    .object({
      type: z.enum(["none", "percent", "fixed"]),
      value: z.coerce.number().finite().nonnegative().optional(),
      reason: z.string().trim().max(500).nullable().optional(),
    })
    .optional(),
});

const returnSchema = z.object({
  locationId: z.coerce.number().int().positive(),
  idempotencyKey: idempotencyKeySchema,
  shiftId: z.coerce.number().int().positive().optional(),
  notes: z.string().trim().max(2000).optional(),
  items: z
    .array(
      z.object({
        saleItemId: z.coerce.number().int().positive(),
        quantity: positiveQuantitySchema,
      })
    )
    .min(1)
    .max(250),
});

const transferSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  variantId: z.coerce.number().int().positive(),
  fromLocationId: z.coerce.number().int().positive(),
  toLocationId: z.coerce.number().int().positive(),
  quantity: positiveQuantitySchema,
  notes: z.string().trim().max(2000).optional(),
});

const adjustmentSchema = z.object({
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

function toNumber(value: string | number | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function registerRetailPosRoutes(app: Express): void {
  app.get("/api/pos/retail/items", requireAuth, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const locationId = Number(req.query.locationId);
      if (!Number.isInteger(locationId) || locationId <= 0)
        return res.status(400).json({ message: "Location is required" });
      await ensureCompanyLocation(companyId, locationId);
      const search = String(req.query.search ?? "").trim();
      const limit = Math.min(Math.max(Number(req.query.limit) || 40, 1), 100);

      const rows = await db
        .select({
          variantId: retailProductVariants.id,
          productId: retailProducts.id,
          code: retailProducts.code,
          name: retailProducts.name,
          brand: retailBrands.name,
          brandId: retailProducts.brandId,
          color: retailProductVariants.color,
          variantImageUrls: retailProductVariants.imageUrls,
          productImageUrls: retailProducts.imageUrls,
          size: retailProductVariants.size,
          sku: retailProductVariants.sku,
          barcode: retailProductVariants.barcode,
          price: retailProductVariants.sellingPrice,
          quantity: retailVariantInventory.quantity,
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
        .where(
          and(
            eq(retailProductVariants.companyId, companyId),
            eq(retailProducts.companyId, companyId),
            eq(retailProductVariants.active, true),
            eq(retailProducts.active, true),
            search
              ? or(
                  punctuationInsensitiveSearch(retailProducts.name, search),
                  punctuationInsensitiveSearch(retailProducts.code, search),
                  punctuationInsensitiveSearch(retailProductVariants.sku, search),
                  punctuationInsensitiveSearch(retailProductVariants.barcode, search),
                  punctuationInsensitiveSearch(retailProductVariants.color, search),
                  punctuationInsensitiveSearch(retailProductVariants.size, search),
                  punctuationInsensitiveSearch(retailBrands.name, search)
                )
              : undefined
          )
        )
        .orderBy(retailProducts.name, retailProductVariants.color, retailProductVariants.size)
        .limit(limit);

      const promotions = await listActiveRetailPromotions(companyId);
      res.json(
        rows.map((row) => {
          const { variantImageUrls, productImageUrls, ...rest } = row;
          const price = toNumber(row.price);
          const promotion = promotions.length
            ? bestPromotionForLine(
                promotions,
                { variantId: row.variantId, productId: row.productId, brandId: row.brandId ?? null },
                price
              )
            : null;
          const promotionRow = promotion ? (promotions.find((entry) => entry.id === promotion.id) ?? null) : null;
          const promotionPrice = promotion
            ? promotion.discountType === "percent"
              ? roundRetailMoney(price * (1 - promotion.value / 100), 2)
              : Math.max(0, roundRetailMoney(price - promotion.value, 2))
            : null;
          return {
            ...rest,
            imageUrls: resolveRetailItemImages(variantImageUrls, productImageUrls),
            brand: row.brand ?? "Other / No Brand",
            price,
            quantity: toNumber(row.quantity),
            promotion:
              promotion && promotionPrice !== null
                ? {
                    id: promotion.id,
                    name: promotionRow?.name ?? "Promotion",
                    discountType: promotion.discountType,
                    value: promotion.value,
                    promotionPrice,
                  }
                : null,
          };
        })
      );
    } catch (error) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  /**
   * Prices a cart without selling it. The POS uses this to render the exact
   * Subtotal → Discount → Tax → Total ladder and to warn the cashier that a manager
   * approval is required, so the client never re-implements the money math.
   */
  app.post("/api/pos/retail/cart-preview", requireAuth, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const body = cartPreviewSchema.parse(req.body ?? {});
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

  app.post("/api/pos/retail/sales", requireAuth, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const userId = currentUserId(req);
      const body = saleSchema.parse(req.body);
      await ensureCompanyLocation(companyId, body.locationId);
      const canSellNegativeStock = Boolean(req.user?.canSellNegativeStock);

      // One line per variant keeps line discounts unambiguous; plain Wave 1 carts may still
      // contain duplicate variants and keep working through the legacy aggregation.
      const hasAdjustments = body.items.some(
        (item) =>
          (item.priceOverride ?? null) !== null ||
          (item.discountType ?? "none") !== "none" ||
          Number(item.discountValue ?? 0) > 0
      );
      const requestedLines: RetailSaleLineRequest[] = hasAdjustments
        ? body.items.map((item) => ({
            variantId: item.variantId,
            quantity: item.quantity,
            priceOverride: item.priceOverride ?? null,
            discountType: item.discountType ?? "none",
            discountValue: item.discountValue ?? 0,
            discountReason: item.discountReason ?? null,
          }))
        : aggregateRetailCartItems(body.items).map((item) => ({ variantId: item.variantId, quantity: item.quantity }));
      if (hasAdjustments && new Set(requestedLines.map((line) => line.variantId)).size !== requestedLines.length) {
        return res.status(400).json({ message: "Each variant may appear only once when a discount is applied" });
      }

      const settings = await loadRetailSettings(companyId);
      const promotions = await listActiveRetailPromotions(companyId);
      const orderDiscount = {
        type: body.orderDiscount?.type ?? ("none" as const),
        value: body.orderDiscount?.value ?? 0,
        reason: body.orderDiscount?.reason ?? null,
      };

      // A reason is mandatory for every manual discount / price override.
      const missingReason = requestedLines.some(
        (line) =>
          ((line.priceOverride ?? null) !== null ||
            (line.discountType ?? "none") !== "none" ||
            Number(line.discountValue ?? 0) > 0) &&
          !line.discountReason?.trim()
      );
      if (missingReason || (orderDiscount.type !== "none" && !orderDiscount.reason?.trim())) {
        return res.status(400).json({
          code: "DISCOUNT_REASON_REQUIRED",
          message: "A reason is required for every discount or price override",
        });
      }

      const preview = await prepareRetailSalePricing(db, {
        companyId,
        items: requestedLines,
        orderDiscount,
        settings,
        promotions,
      });
      const manual = hasManualAdjustment(preview.priced, orderDiscount);
      const effectiveDiscountPercent = effectiveManualDiscountPercent(preview.priced);
      const hasPriceOverride = preview.priced.lines.some((line) => line.priceOverride);
      const policy = evaluateRetailDiscountPolicy({
        role: req.user?.role,
        discountLimitPercent: settings.discountLimitPercent,
        requireManagerApproval: settings.requireManagerApproval,
        priceOverrideRequiresApproval: settings.priceOverrideRequiresApproval,
        effectiveDiscountPercent,
        hasPriceOverride,
        hasManualDiscount: manual.any,
      });

      let approval: RetailSaleInput["approval"] = null;
      if (policy.requiresApproval) {
        if (!body.approvalToken) {
          return res.status(428).json({
            code: "DISCOUNT_APPROVAL_REQUIRED",
            message: "A manager must approve this discount or price override",
            reasons: policy.reasons,
            discountLimitPercent: settings.discountLimitPercent,
            effectiveDiscountPercent,
          });
        }
        let payload: ReturnType<typeof verifyRetailApprovalToken>;
        try {
          payload = verifyRetailApprovalToken(body.approvalToken);
        } catch (error) {
          const expired = error instanceof ExpiredRetailApprovalTokenError;
          return res.status(428).json({
            code: expired ? "DISCOUNT_APPROVAL_EXPIRED" : "DISCOUNT_APPROVAL_INVALID",
            message: getErrorMessage(error),
          });
        }
        const fingerprint = retailApprovalFingerprint(requestedLines, orderDiscount);
        const covers =
          payload.companyId === companyId &&
          payload.cashierUserId === userId &&
          payload.fingerprint === fingerprint &&
          approvalCoversRequest(payload, {
            companyId,
            cashierUserId: userId,
            effectiveDiscountPercent,
            hasPriceOverride,
          });
        if (!covers) {
          return res.status(428).json({
            code: "DISCOUNT_APPROVAL_INVALID",
            message:
              "This approval was issued for a different cart, cashier or company — ask the manager to approve again.",
          });
        }
        const [record] = await db
          .select({ id: retailDiscountApprovals.id })
          .from(retailDiscountApprovals)
          .where(
            and(eq(retailDiscountApprovals.companyId, companyId), eq(retailDiscountApprovals.tokenId, payload.tokenId))
          )
          .limit(1);
        if (!record) {
          return res.status(428).json({ code: "DISCOUNT_APPROVAL_INVALID", message: "Approval record not found" });
        }
        approval = {
          approvalId: record.id,
          approvedByUserId: payload.managerUserId,
          approvedByName: payload.managerName,
        };
      }

      // The customer is optional: walk-in stays the default and costs no extra query.
      let customer: RetailSaleInput["customer"] = null;
      if (body.customerId) {
        const [row] = await db
          .select({ id: customers.id, legalName: customers.legalName })
          .from(customers)
          .where(
            and(eq(customers.id, body.customerId), eq(customers.companyId, companyId), isNull(customers.deletedAt))
          )
          .limit(1);
        if (!row) return res.status(404).json({ message: "Customer not found" });
        customer = { id: row.id, name: row.legalName };
      } else if (body.customerName?.trim()) {
        customer = { id: null, name: body.customerName.trim() };
      }

      const result = await db.transaction((tx) =>
        createRetailSaleInTx(tx, {
          companyId,
          locationId: body.locationId,
          idempotencyKey: body.idempotencyKey,
          notes: body.notes ?? null,
          items: requestedLines,
          userId,
          username: req.user?.username ?? null,
          canSellNegativeStock,
          shiftId: body.shiftId ?? null,
          payments: body.payments,
          customer,
          orderDiscount,
          settings,
          promotions,
          approval,
        })
      );

      const sale = await loadSaleResponse(companyId, result.saleId);
      res.status(result.replayed ? 200 : 201).json({ replayed: result.replayed, sale });
    } catch (error) {
      if (error instanceof InvalidRetailApprovalTokenError) {
        return res.status(428).json({ code: "DISCOUNT_APPROVAL_INVALID", message: getErrorMessage(error) });
      }
      if (error instanceof RetailApprovalReuseError) {
        return res.status(409).json({ code: "DISCOUNT_APPROVAL_ALREADY_USED", message: getErrorMessage(error) });
      }
      const message = getErrorMessage(error);
      res.status(message.includes("Insufficient stock") ? 409 : 400).json({ message });
    }
  });

  app.get("/api/pos/retail/sales", requireAuth, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const locationId = Number(req.query.locationId);
      const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100);
      if (!Number.isInteger(locationId) || locationId <= 0)
        return res.status(400).json({ message: "Location is required" });
      await ensureCompanyLocation(companyId, locationId);
      const sales = await db
        .select({ id: retailPosSales.id })
        .from(retailPosSales)
        .where(and(eq(retailPosSales.companyId, companyId), eq(retailPosSales.locationId, locationId)))
        .orderBy(desc(retailPosSales.createdAt))
        .limit(limit);
      const details = await Promise.all(sales.map((sale) => loadSaleResponse(companyId, sale.id)));
      res.json(details.filter(Boolean));
    } catch (error) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/pos/retail/sales/:saleId/returns", requireAuth, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const saleId = Number(req.params.saleId);
      if (!Number.isInteger(saleId) || saleId <= 0) return res.status(400).json({ message: "Invalid sale" });
      const body = returnSchema.parse(req.body);
      await ensureCompanyLocation(companyId, body.locationId);
      const userId = currentUserId(req);

      const result = await db.transaction(async (tx) => {
        const returned = await createRetailReturnInTx(tx, {
          companyId,
          saleId,
          locationId: body.locationId,
          idempotencyKey: body.idempotencyKey,
          notes: body.notes ?? null,
          items: body.items,
          userId,
        });
        if (!returned.replayed) {
          const shift = await validateRetailShiftTx(tx, {
            companyId,
            locationId: body.locationId,
            userId,
            shiftId: body.shiftId ?? null,
          });
          const refunds = await refundRetailPaymentsTx(tx, {
            companyId,
            saleId,
            locationId: body.locationId,
            shiftId: shift?.id ?? null,
            refundAmount: returned.refundAmount,
            idempotencyKey: body.idempotencyKey,
            userId,
          });
          const refundVoucherId = await postRetailRefundAccountingTx(tx, {
            companyId,
            locationId: body.locationId,
            saleId,
            sourceType: "retail-pos-return",
            sourceId: String(returned.returnId),
            idempotencyKey: `retail-pos-return:${returned.returnId}`,
            refundAmount: returned.refundAmount,
            refundTaxAmount: returned.refundTaxAmount,
            restoredCost: returned.costValue,
            refunds,
            userId,
            username: req.user?.username ?? null,
          });
          // Wave 17 (D): what the refund journal did not put back on Retail inventory.
          await returned.stockValue?.post({
            kind: "return",
            sourceId: returned.returnId,
            description: `Retail return #${returned.returnId} for sale #${saleId}`,
            actor: { userId, username: req.user?.username ?? null },
            alreadyDebited: refundVoucherId ? returned.costValue : undefined,
          });
        }
        return returned;
      });

      res.status(result.replayed ? 200 : 201).json({
        ...result,
        // Exact amounts inside; a number only in the response.
        refundAmount: result.refundAmount.toDecimalPlaces(2).toNumber(),
        refundTaxAmount: result.refundTaxAmount.toDecimalPlaces(2).toNumber(),
        refundValue: result.refundValue.toNumber(),
        costValue: result.costValue.toNumber(),
        sale: await loadSaleResponse(companyId, saleId),
      });
    } catch (error) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/pos/retail/transfers", requireAuth, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const body = transferSchema.parse(req.body);
      if (req.user?.role === "POS") return res.status(403).json({ message: "POS users cannot transfer retail stock" });
      if (body.fromLocationId === body.toLocationId)
        return res.status(400).json({ message: "Transfer locations must be different" });
      await Promise.all([
        ensureCompanyLocation(companyId, body.fromLocationId),
        ensureCompanyLocation(companyId, body.toLocationId),
        ensureRetailVariant(db, companyId, body.variantId),
      ]);
      const userId = currentUserId(req);
      const canSellNegativeStock = Boolean(req.user?.canSellNegativeStock);

      const result = await db.transaction(async (tx) => {
        const [operation] = await tx
          .insert(retailStockOperations)
          .values({
            companyId,
            operationType: "transfer",
            idempotencyKey: body.idempotencyKey,
            createdBy: userId,
            metadata: {
              fromLocationId: body.fromLocationId,
              toLocationId: body.toLocationId,
              notes: body.notes ?? null,
            },
          })
          .onConflictDoNothing({ target: [retailStockOperations.companyId, retailStockOperations.idempotencyKey] })
          .returning({ id: retailStockOperations.id });
        if (!operation) return { replayed: true };

        const orderedLocationIds = [body.fromLocationId, body.toLocationId].sort((a, b) => a - b);
        for (const locationId of orderedLocationIds) await lockInventoryRow(tx, companyId, body.variantId, locationId);
        const source = await lockInventoryRow(tx, companyId, body.variantId, body.fromLocationId);
        const destination = await lockInventoryRow(tx, companyId, body.variantId, body.toLocationId);
        const stockValue = await trackRetailStockValueTx(tx, companyId, [
          { variantId: body.variantId, locationId: body.fromLocationId },
          { variantId: body.variantId, locationId: body.toLocationId },
        ]);
        let sourceAfter: number;
        let destinationAfter: number;
        try {
          ({ sourceAfter, destinationAfter } = nextRetailTransferQuantities(
            source.quantity,
            destination.quantity,
            body.quantity,
            canSellNegativeStock
          ));
        } catch {
          throw new Error(`Insufficient stock for transfer. Available: ${source.quantity}`);
        }
        await setInventoryQuantity(tx, companyId, body.variantId, body.fromLocationId, sourceAfter);
        // Wave 17 (D): the destination takes the units at the source's cost (value-exact), blended into its average.
        await setInventoryQuantity(
          tx,
          companyId,
          body.variantId,
          body.toLocationId,
          destinationAfter,
          nextAverageCost(destination.quantity, destination.averageCost, body.quantity, source.averageCost)
        );
        await addMovement(tx, {
          companyId,
          variantId: body.variantId,
          locationId: body.fromLocationId,
          movementType: "transfer_out",
          quantityDelta: -body.quantity,
          before: source.quantity,
          after: sourceAfter,
          eventKey: `transfer:${operation.id}:out`,
          referenceType: "retail_transfer",
          referenceId: operation.id,
          createdBy: userId,
          metadata: { toLocationId: body.toLocationId },
        });
        await addMovement(tx, {
          companyId,
          variantId: body.variantId,
          locationId: body.toLocationId,
          movementType: "transfer_in",
          quantityDelta: body.quantity,
          before: destination.quantity,
          after: destinationAfter,
          eventKey: `transfer:${operation.id}:in`,
          referenceType: "retail_transfer",
          referenceId: operation.id,
          createdBy: userId,
          metadata: { fromLocationId: body.fromLocationId },
        });
        await stockValue.post({
          kind: "transfer",
          sourceId: operation.id,
          description: `Retail stock transfer #${operation.id}`,
          actor: { userId, username: req.user?.username ?? null },
        });
        return {
          replayed: false,
          operationId: operation.id,
          sourceQuantity: sourceAfter,
          destinationQuantity: destinationAfter,
        };
      });
      res.status(result.replayed ? 200 : 201).json(result);
    } catch (error) {
      const message = getErrorMessage(error);
      res.status(message.includes("Insufficient stock") ? 409 : 400).json({ message });
    }
  });

  app.post("/api/pos/retail/adjustments", requireAuth, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      if (req.user?.role === "POS") return res.status(403).json({ message: "POS users cannot make stock adjustments" });
      const body = adjustmentSchema.parse(req.body);
      await Promise.all([
        ensureCompanyLocation(companyId, body.locationId),
        ensureRetailVariant(db, companyId, body.variantId),
      ]);
      const userId = currentUserId(req);
      const result = await db.transaction(async (tx) => {
        const [operation] = await tx
          .insert(retailStockOperations)
          .values({
            companyId,
            operationType: "adjustment",
            idempotencyKey: body.idempotencyKey,
            createdBy: userId,
            metadata: { reason: body.reason },
          })
          .onConflictDoNothing({ target: [retailStockOperations.companyId, retailStockOperations.idempotencyKey] })
          .returning({ id: retailStockOperations.id });
        if (!operation) return { replayed: true };
        const stock = await lockInventoryRow(tx, companyId, body.variantId, body.locationId);
        const stockValue = await trackRetailStockValueTx(tx, companyId, [
          { variantId: body.variantId, locationId: body.locationId },
        ]);
        const after = stock.quantity + body.quantityDelta;
        if (after < -0.000001 && !req.user?.canSellNegativeStock) {
          throw new Error(`Insufficient stock for adjustment. Available: ${stock.quantity}`);
        }
        await setInventoryQuantity(tx, companyId, body.variantId, body.locationId, after);
        await addMovement(tx, {
          companyId,
          variantId: body.variantId,
          locationId: body.locationId,
          movementType: "adjustment",
          quantityDelta: body.quantityDelta,
          before: stock.quantity,
          after,
          eventKey: `adjustment:${operation.id}`,
          referenceType: "retail_adjustment",
          referenceId: operation.id,
          createdBy: userId,
          metadata: { reason: body.reason, reference: body.reference ?? null },
        });
        // Wave 17 (D): Dr/Cr Retail inventory against RETAIL-INVENTORY-ADJUSTMENT at the row's cost.
        await stockValue.post({
          kind: "adjustment",
          sourceId: operation.id,
          description: `Retail stock adjustment #${operation.id} · ${body.reason}`,
          actor: { userId, username: req.user?.username ?? null },
        });
        return { replayed: false, operationId: operation.id, quantity: after };
      });
      res.status(result.replayed ? 200 : 201).json(result);
    } catch (error) {
      const message = getErrorMessage(error);
      res.status(message.includes("Insufficient stock") ? 409 : 400).json({ message });
    }
  });

  registerRetailPosCancellationRoute(app);

  app.get("/api/pos/retail/movements", requireAuth, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
      const locationId = Number(req.query.locationId);
      const rows = await db
        .select()
        .from(retailStockMovements)
        .where(
          and(
            eq(retailStockMovements.companyId, companyId),
            Number.isInteger(locationId) && locationId > 0 ? eq(retailStockMovements.locationId, locationId) : undefined
          )
        )
        .orderBy(desc(retailStockMovements.createdAt))
        .limit(limit);
      res.json(
        rows.map((row) => ({
          ...row,
          quantityDelta: toNumber(row.quantityDelta),
          quantityBefore: toNumber(row.quantityBefore),
          quantityAfter: toNumber(row.quantityAfter),
        }))
      );
    } catch (error) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });
}
