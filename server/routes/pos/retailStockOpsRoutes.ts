import type { Express } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  locations,
  retailBrands,
  retailPosSales,
  retailProductVariants,
  retailProducts,
  retailStockMovements,
  retailStockOperations,
  retailVariantInventory,
  users,
} from "@shared/schema";
import { requireAuth, requireNonPOS } from "../../auth";
import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { lineAmount, moneyString, toMoney } from "../../lib/money";
import { RETAIL_GRNI_ACCOUNT, trackRetailStockValueTx } from "../../services/retail/retailInventoryJournal";
import { currentUserId, ensureCompanyLocation, requireRetailCompany } from "./retailPosContext";
import {
  addMovement,
  lockInventoryRow,
  nextAverageCost,
  setInventoryQuantity,
} from "../../services/retail/retailStockLedger";
import {
  createRetailReturnInTx,
  createRetailSaleInTx,
  ensureRetailVariant,
  loadSaleResponse,
} from "../../services/retail/retailSaleService";
import { aggregateRetailCartItems } from "../../services/retail/retailStockMath";
import {
  postRetailRefundAccountingTx,
  refundRetailPaymentsTx,
  validateRetailShiftTx,
} from "../../services/retail/retailFinancialService";

const toNumber = (value: unknown) => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

const idempotencyKeySchema = z.string().trim().min(8).max(191);

const paymentSchema = z.object({
  method: z.enum(["cash", "card", "bank", "mobile", "other"]),
  amount: z.coerce.number().finite().positive(),
  tenderedAmount: z.coerce.number().finite().positive().optional(),
  reference: z.string().trim().max(191).optional(),
});

const receiveSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  variantId: z.coerce.number().int().positive(),
  locationId: z.coerce.number().int().positive(),
  quantity: z.coerce.number().finite().positive().max(100000),
  unitCost: z.coerce.number().finite().nonnegative().optional(),
  reference: z.string().trim().max(191).optional(),
  notes: z.string().trim().max(1000).optional(),
});

export const retailExchangeSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  saleId: z.coerce.number().int().positive(),
  locationId: z.coerce.number().int().positive(),
  shiftId: z.coerce.number().int().positive().optional(),
  payments: z.array(paymentSchema).min(1).max(8).optional(),
  notes: z.string().trim().max(2000).optional(),
  returnItems: z
    .array(
      z.object({ saleItemId: z.coerce.number().int().positive(), quantity: z.coerce.number().finite().positive() })
    )
    .min(1)
    .max(100),
  newItems: z
    .array(z.object({ variantId: z.coerce.number().int().positive(), quantity: z.coerce.number().finite().positive() }))
    .min(1)
    .max(100),
});

/** Variant identity + stock at every location, used by barcode stock operations. */
async function loadVariantStock(companyId: number, match: ReturnType<typeof eq>) {
  const [variant] = await db
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
      cost: retailProductVariants.cost,
      sellingPrice: retailProductVariants.sellingPrice,
      imageUrls: retailProductVariants.imageUrls,
      productImageUrls: retailProducts.imageUrls,
      active: retailProductVariants.active,
      productActive: retailProducts.active,
    })
    .from(retailProductVariants)
    .innerJoin(retailProducts, eq(retailProducts.id, retailProductVariants.productId))
    .leftJoin(retailBrands, eq(retailBrands.id, retailProducts.brandId))
    .where(and(eq(retailProductVariants.companyId, companyId), match))
    .limit(1);
  if (!variant) return null;
  const stocks = await db
    .select({
      locationId: locations.id,
      locationName: locations.name,
      quantity: retailVariantInventory.quantity,
    })
    .from(retailVariantInventory)
    .innerJoin(locations, eq(locations.id, retailVariantInventory.locationId))
    .where(
      and(eq(retailVariantInventory.companyId, companyId), eq(retailVariantInventory.variantId, variant.variantId))
    )
    .orderBy(locations.name);
  const { productImageUrls, productActive, ...rest } = variant;
  const variantImages = Array.isArray(rest.imageUrls) ? rest.imageUrls : [];
  return {
    ...rest,
    brand: rest.brand ?? "Other / No Brand",
    active: Boolean(rest.active && productActive),
    imageUrls: variantImages.length ? variantImages : Array.isArray(productImageUrls) ? productImageUrls : [],
    cost: toNumber(rest.cost),
    sellingPrice: toNumber(rest.sellingPrice),
    stocks: stocks.map((stock) => ({ ...stock, quantity: toNumber(stock.quantity) })),
    totalQuantity: stocks.reduce((sum, stock) => sum + toNumber(stock.quantity), 0),
  };
}

export function registerRetailStockOpsRoutes(app: Express): void {
  /** Barcode lookup for stock operations: exact variant plus its stock at every location (archived included). */
  app.get("/api/retail/stock/lookup", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const barcode = String(req.query.barcode ?? "").trim();
      const variantId = Number(req.query.variantId);
      let result = null;
      if (barcode) {
        result =
          (await loadVariantStock(companyId, eq(retailProductVariants.barcode, barcode))) ??
          (await loadVariantStock(companyId, sql`lower(${retailProductVariants.barcode}) = lower(${barcode})`));
      } else if (Number.isInteger(variantId) && variantId > 0) {
        result = await loadVariantStock(companyId, eq(retailProductVariants.id, variantId));
      } else {
        return res.status(400).json({ message: "Barcode is required" });
      }
      if (!result) return res.status(404).json({ code: "BARCODE_NOT_FOUND", message: "Barcode not found" });
      res.json(result);
    } catch (error) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  /** Receive / restock: increases the exact variant at one location and updates its average cost. */
  app.post("/api/pos/retail/receipts", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const body = receiveSchema.parse(req.body);
      const userId = currentUserId(req);
      await ensureCompanyLocation(companyId, body.locationId);
      const variant = await ensureRetailVariant(db, companyId, body.variantId);
      const unitCost = body.unitCost ?? toNumber(variant.cost);

      const result = await db.transaction(async (tx) => {
        const [operation] = await tx
          .insert(retailStockOperations)
          .values({
            companyId,
            operationType: "receive",
            idempotencyKey: body.idempotencyKey,
            referenceId: body.reference ?? null,
            createdBy: userId,
            metadata: { locationId: body.locationId, variantId: body.variantId, unitCost, notes: body.notes ?? null },
          })
          .onConflictDoNothing({ target: [retailStockOperations.companyId, retailStockOperations.idempotencyKey] })
          .returning({ id: retailStockOperations.id });
        if (!operation) return { replayed: true };
        const stock = await lockInventoryRow(tx, companyId, body.variantId, body.locationId);
        // Wave 17 (D): the value received is journalled once the Retail inventory opening is applied.
        const stockValue = await trackRetailStockValueTx(tx, companyId, [
          { variantId: body.variantId, locationId: body.locationId },
        ]);
        const after = stock.quantity + body.quantity;
        const averageCost = nextAverageCost(stock.quantity, stock.averageCost, body.quantity, unitCost);
        await setInventoryQuantity(tx, companyId, body.variantId, body.locationId, after, averageCost);
        await addMovement(tx, {
          companyId,
          variantId: body.variantId,
          locationId: body.locationId,
          movementType: "receive",
          quantityDelta: body.quantity,
          before: stock.quantity,
          after,
          eventKey: `receive:${operation.id}`,
          referenceType: "retail_receive",
          referenceId: operation.id,
          createdBy: userId,
          metadata: { reason: body.notes || "Stock received", reference: body.reference ?? null, unitCost },
        });
        const receivedValue = lineAmount(body.quantity, unitCost);
        await stockValue.post({
          kind: "receipt",
          sourceId: operation.id,
          description: `Retail stock receipt #${operation.id}`,
          actor: { userId, username: req.user?.username ?? null },
          contra: [
            {
              accountCode: RETAIL_GRNI_ACCOUNT,
              amount: receivedValue.negated(),
              narration: `Retail stock receipt #${operation.id} · received not invoiced`,
            },
          ],
        });
        return { replayed: false, operationId: operation.id, quantity: after };
      });
      res.status(result.replayed ? 200 : 201).json(result);
    } catch (error) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  /**
   * Exchange: return items from an earlier sale and sell replacement items in one
   * transaction. Both sides stay separate, traceable records (a return on the
   * original sale and a new sale); nothing historical is rewritten.
   */
  app.post("/api/pos/retail/exchanges", requireAuth, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const body = retailExchangeSchema.parse(req.body);
      const userId = currentUserId(req);
      await ensureCompanyLocation(companyId, body.locationId);
      const canSellNegativeStock = Boolean(req.user?.canSellNegativeStock);

      const result = await db.transaction(async (tx) => {
        const [operation] = await tx
          .insert(retailStockOperations)
          .values({
            companyId,
            operationType: "exchange",
            idempotencyKey: body.idempotencyKey,
            referenceId: String(body.saleId),
            createdBy: userId,
            metadata: { originalSaleId: body.saleId },
          })
          .onConflictDoNothing({ target: [retailStockOperations.companyId, retailStockOperations.idempotencyKey] })
          .returning({ id: retailStockOperations.id });
        if (!operation) {
          const [previous] = await tx
            .select({ metadata: retailStockOperations.metadata })
            .from(retailStockOperations)
            .where(
              and(
                eq(retailStockOperations.companyId, companyId),
                eq(retailStockOperations.idempotencyKey, body.idempotencyKey)
              )
            )
            .limit(1);
          const meta = previous?.metadata ?? {};
          return {
            replayed: true,
            operationId: 0,
            returnId: Number(meta.returnId ?? 0),
            newSaleId: Number(meta.newSaleId ?? 0),
            refundValue: toMoney(meta.refundValue as string | number | null | undefined),
          };
        }

        const returned = await createRetailReturnInTx(tx, {
          companyId,
          saleId: body.saleId,
          locationId: body.locationId,
          idempotencyKey: `${body.idempotencyKey}:return`.slice(0, 191),
          notes: "Exchange #" + operation.id + (body.notes ? " · " + body.notes : ""),
          items: body.returnItems,
          userId,
          metadata: { exchangeOperationId: operation.id },
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
            saleId: body.saleId,
            locationId: body.locationId,
            shiftId: shift?.id ?? null,
            refundAmount: returned.refundValue,
            idempotencyKey: `${body.idempotencyKey}:return`.slice(0, 191),
            userId,
          });
          const refundVoucherId = await postRetailRefundAccountingTx(tx, {
            companyId,
            locationId: body.locationId,
            saleId: body.saleId,
            sourceType: "retail-pos-return",
            sourceId: String(returned.returnId),
            idempotencyKey: `retail-pos-return:${returned.returnId}`,
            refundAmount: returned.refundValue,
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
            description: `Retail return #${returned.returnId} for sale #${body.saleId}`,
            actor: { userId, username: req.user?.username ?? null },
            alreadyDebited: refundVoucherId ? returned.costValue : undefined,
          });
        }

        const sold = await createRetailSaleInTx(tx, {
          companyId,
          locationId: body.locationId,
          idempotencyKey: `${body.idempotencyKey}:sale`.slice(0, 191),
          notes: `Exchange #${operation.id} for sale #${body.saleId}`,
          items: aggregateRetailCartItems(body.newItems),
          userId,
          username: req.user?.username ?? null,
          canSellNegativeStock,
          shiftId: body.shiftId ?? null,
          payments: body.payments,
        });

        const refundValue = returned.refundValue;
        await tx
          .update(retailStockOperations)
          .set({
            metadata: {
              originalSaleId: body.saleId,
              returnId: returned.returnId,
              newSaleId: sold.saleId,
              refundValue: refundValue.toFixed(),
            },
          })
          .where(eq(retailStockOperations.id, operation.id));
        await tx
          .update(retailPosSales)
          .set({ updatedAt: new Date() })
          .where(and(eq(retailPosSales.id, sold.saleId), eq(retailPosSales.companyId, companyId)));
        return {
          replayed: false,
          operationId: operation.id,
          returnId: returned.returnId,
          newSaleId: sold.saleId,
          refundValue,
        };
      });

      const newSale = await loadSaleResponse(companyId, result.newSaleId);
      const newTotal = toNumber(newSale?.totalAmount);
      res.status(result.replayed ? 200 : 201).json({
        ...result,
        newSaleTotal: newTotal,
        sale: newSale,
        // Positive: customer pays the difference. Negative: refund the difference.
        refundValue: result.refundValue.toNumber(),
        balanceDue: Number(moneyString(toMoney(newSale?.totalAmount).minus(result.refundValue))),
      });
    } catch (error) {
      const message = getErrorMessage(error);
      res.status(message.includes("Insufficient stock") ? 409 : 400).json({ message });
    }
  });

  /** Full audit trail for one exact variant: every movement with before/after, location, user and reason. */
  app.get("/api/retail/variants/:id/movements", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const variantId = Number(req.params.id);
      if (!Number.isInteger(variantId) || variantId <= 0) return res.status(400).json({ message: "Invalid variant" });
      const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
      const rows = await db
        .select({
          id: retailStockMovements.id,
          movementType: retailStockMovements.movementType,
          locationId: retailStockMovements.locationId,
          locationName: locations.name,
          quantityDelta: retailStockMovements.quantityDelta,
          quantityBefore: retailStockMovements.quantityBefore,
          quantityAfter: retailStockMovements.quantityAfter,
          referenceType: retailStockMovements.referenceType,
          referenceId: retailStockMovements.referenceId,
          metadata: retailStockMovements.metadata,
          createdAt: retailStockMovements.createdAt,
          createdBy: users.username,
        })
        .from(retailStockMovements)
        .leftJoin(locations, eq(locations.id, retailStockMovements.locationId))
        .leftJoin(users, eq(users.id, retailStockMovements.createdBy))
        .where(and(eq(retailStockMovements.companyId, companyId), eq(retailStockMovements.variantId, variantId)))
        .orderBy(desc(retailStockMovements.createdAt), desc(retailStockMovements.id))
        .limit(limit);
      const locationNames = new Map(
        (
          await db
            .select({ id: locations.id, name: locations.name })
            .from(locations)
            .where(eq(locations.companyId, companyId))
        ).map((row) => [row.id, row.name])
      );
      res.json(
        rows.map((row) => {
          const meta = (row.metadata ?? {}) as Record<string, unknown>;
          const counterpartId = Number(meta.toLocationId ?? meta.fromLocationId ?? 0);
          return {
            ...row,
            quantityDelta: toNumber(row.quantityDelta),
            quantityBefore: toNumber(row.quantityBefore),
            quantityAfter: toNumber(row.quantityAfter),
            reason: typeof meta.reason === "string" ? meta.reason : null,
            counterpartLocation: counterpartId ? (locationNames.get(counterpartId) ?? null) : null,
          };
        })
      );
    } catch (error) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });
}
