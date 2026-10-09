import { punctuationInsensitiveSearch } from "../../lib/searchNormalization";
import type { Express } from "express";
import { and, desc, eq, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  locations,
  retailBrands,
  retailPosSaleItems,
  retailPosSales,
  retailProductVariants,
  retailProducts,
  retailStockMovements,
  retailStockOperations,
  retailVariantInventory,
} from "@shared/schema";
import { requireAuth } from "../../auth";
import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { currentUserId, ensureCompanyLocation, requireRetailCompany } from "./retailPosContext";
import { addMovement, lockInventoryRow, setInventoryQuantity } from "../../services/retail/retailStockLedger";
import {
  createRetailReturnInTx,
  createRetailSaleInTx,
  ensureRetailVariant,
  loadSaleResponse,
  resolveRetailItemImages,
} from "../../services/retail/retailSaleService";
import { aggregateRetailCartItems, nextRetailTransferQuantities } from "../../services/retail/retailStockMath";
import {
  postRetailRefundAccountingTx,
  refundRetailPaymentsTx,
  validateRetailShiftTx,
} from "../../services/retail/retailFinancialService";

const idempotencyKeySchema = z.string().trim().min(8).max(191);
const positiveQuantitySchema = z.coerce.number().finite().positive();

const paymentSchema = z.object({
  method: z.enum(["cash", "card", "bank", "mobile", "other"]),
  amount: z.coerce.number().finite().positive(),
  tenderedAmount: z.coerce.number().finite().positive().optional(),
  reference: z.string().trim().max(191).optional(),
});

const saleSchema = z.object({
  locationId: z.coerce.number().int().positive(),
  idempotencyKey: idempotencyKeySchema,
  notes: z.string().trim().max(2000).optional(),
  shiftId: z.coerce.number().int().positive().optional(),
  payments: z.array(paymentSchema).min(1).max(8).optional(),
  items: z
    .array(
      z.object({
        variantId: z.coerce.number().int().positive(),
        quantity: positiveQuantitySchema,
      })
    )
    .min(1)
    .max(250),
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

const cancelSchema = z.object({
  locationId: z.coerce.number().int().positive(),
  idempotencyKey: idempotencyKeySchema,
  shiftId: z.coerce.number().int().positive().optional(),
  reason: z.string().trim().min(1).max(500).optional(),
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

      res.json(
        rows.map((row) => {
          const { variantImageUrls, productImageUrls, ...rest } = row;
          return {
            ...rest,
            imageUrls: resolveRetailItemImages(variantImageUrls, productImageUrls),
            brand: row.brand ?? "Other / No Brand",
            price: toNumber(row.price),
            quantity: toNumber(row.quantity),
          };
        })
      );
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
      const items = aggregateRetailCartItems(body.items);

      const result = await db.transaction((tx) =>
        createRetailSaleInTx(tx, {
          companyId,
          locationId: body.locationId,
          idempotencyKey: body.idempotencyKey,
          notes: body.notes ?? null,
          items,
          userId,
          username: req.user?.username ?? null,
          canSellNegativeStock,
          shiftId: body.shiftId ?? null,
          payments: body.payments,
        })
      );

      const sale = await loadSaleResponse(companyId, result.saleId);
      res.status(result.replayed ? 200 : 201).json({ replayed: result.replayed, sale });
    } catch (error) {
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
            refundAmount: returned.refundValue,
            idempotencyKey: body.idempotencyKey,
            userId,
          });
          await postRetailRefundAccountingTx(tx, {
            companyId,
            locationId: body.locationId,
            saleId,
            sourceType: "retail-pos-return",
            sourceId: String(returned.returnId),
            idempotencyKey: `retail-pos-return:${returned.returnId}`,
            refundAmount: returned.refundValue,
            restoredCost: returned.costValue,
            refunds,
            userId,
            username: req.user?.username ?? null,
          });
        }
        return returned;
      });

      res.status(result.replayed ? 200 : 201).json({ ...result, sale: await loadSaleResponse(companyId, saleId) });
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
        await setInventoryQuantity(tx, companyId, body.variantId, body.toLocationId, destinationAfter);
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
        return { replayed: false, operationId: operation.id, quantity: after };
      });
      res.status(result.replayed ? 200 : 201).json(result);
    } catch (error) {
      const message = getErrorMessage(error);
      res.status(message.includes("Insufficient stock") ? 409 : 400).json({ message });
    }
  });

  app.post("/api/pos/retail/sales/:saleId/cancel", requireAuth, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const saleId = Number(req.params.saleId);
      if (!Number.isInteger(saleId) || saleId <= 0) return res.status(400).json({ message: "Invalid sale" });
      const body = cancelSchema.parse(req.body);
      await ensureCompanyLocation(companyId, body.locationId);
      const userId = currentUserId(req);
      const result = await db.transaction(async (tx) => {
        const [operation] = await tx
          .insert(retailStockOperations)
          .values({
            companyId,
            operationType: "cancellation",
            idempotencyKey: body.idempotencyKey,
            referenceId: String(saleId),
            createdBy: userId,
            metadata: { reason: body.reason ?? null },
          })
          .onConflictDoNothing({ target: [retailStockOperations.companyId, retailStockOperations.idempotencyKey] })
          .returning({ id: retailStockOperations.id });
        if (!operation) return { replayed: true };

        await tx.execute(
          sql`select id from retail_pos_sales where id = ${saleId} and company_id = ${companyId} for update`
        );
        const [sale] = await tx
          .select({ id: retailPosSales.id, locationId: retailPosSales.locationId, status: retailPosSales.status })
          .from(retailPosSales)
          .where(and(eq(retailPosSales.id, saleId), eq(retailPosSales.companyId, companyId)))
          .limit(1);
        if (!sale) throw new Error("Retail sale not found");
        if (sale.locationId !== body.locationId)
          throw new Error("Cancellation location must match the original sale location");
        if (sale.status === "canceled") return { replayed: true };

        const saleItems = await tx
          .select({
            id: retailPosSaleItems.id,
            variantId: retailPosSaleItems.variantId,
            quantity: retailPosSaleItems.quantity,
            returnedQuantity: retailPosSaleItems.returnedQuantity,
            unitPrice: retailPosSaleItems.unitPrice,
            unitCost: retailPosSaleItems.unitCost,
          })
          .from(retailPosSaleItems)
          .where(and(eq(retailPosSaleItems.saleId, saleId), eq(retailPosSaleItems.companyId, companyId)));

        let refundAmount = 0;
        let restoredCost = 0;
        for (const item of saleItems) {
          const quantityToRestore = Math.max(0, toNumber(item.quantity) - toNumber(item.returnedQuantity));
          if (quantityToRestore <= 0) continue;
          refundAmount += quantityToRestore * toNumber(item.unitPrice);
          restoredCost += quantityToRestore * toNumber(item.unitCost);
          const stock = await lockInventoryRow(tx, companyId, item.variantId, sale.locationId);
          const after = stock.quantity + quantityToRestore;
          await setInventoryQuantity(tx, companyId, item.variantId, sale.locationId, after);
          await addMovement(tx, {
            companyId,
            variantId: item.variantId,
            locationId: sale.locationId,
            movementType: "cancellation",
            quantityDelta: quantityToRestore,
            before: stock.quantity,
            after,
            eventKey: `cancellation:${operation.id}:${item.id}`,
            referenceType: "retail_pos_sale",
            referenceId: saleId,
            createdBy: userId,
            metadata: { saleItemId: item.id, reason: body.reason ?? null },
          });
        }
        await tx
          .update(retailPosSales)
          .set({ status: "canceled", canceledAt: new Date(), updatedAt: new Date() })
          .where(eq(retailPosSales.id, saleId));
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
          refundAmount,
          idempotencyKey: body.idempotencyKey,
          userId,
        });
        await postRetailRefundAccountingTx(tx, {
          companyId,
          locationId: body.locationId,
          saleId,
          sourceType: "retail-pos-cancel",
          sourceId: String(saleId),
          idempotencyKey: `retail-pos-cancel:${saleId}`,
          refundAmount,
          restoredCost,
          refunds,
          userId,
          username: req.user?.username ?? null,
        });
        return { replayed: false, operationId: operation.id, refundAmount, restoredCost };
      });
      res.status(result.replayed ? 200 : 201).json({ ...result, sale: await loadSaleResponse(companyId, saleId) });
    } catch (error) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

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
