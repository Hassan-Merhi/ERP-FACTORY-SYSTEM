import { punctuationInsensitiveSearch } from "../../lib/searchNormalization";
import type { Express, Request, Response } from "express";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  companies,
  locations,
  retailBrands,
  retailPosReturnItems,
  retailPosReturns,
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
import {
  aggregateRetailCartItems,
  nextRetailReturnQuantity,
  nextRetailSaleQuantity,
  nextRetailTransferQuantities,
  validateRetailReturnQuantity,
} from "../../services/retail/retailStockMath";

const idempotencyKeySchema = z.string().trim().min(8).max(191);
const positiveQuantitySchema = z.coerce.number().finite().positive();

const saleSchema = z.object({
  locationId: z.coerce.number().int().positive(),
  idempotencyKey: idempotencyKeySchema,
  notes: z.string().trim().max(2000).optional(),
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
});

const cancelSchema = z.object({
  locationId: z.coerce.number().int().positive(),
  idempotencyKey: idempotencyKeySchema,
  reason: z.string().trim().min(1).max(500).optional(),
});

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

function toNumber(value: string | number | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function currentCompanyId(req: Request): number | null {
  const companyId = Number(req.session.currentCompanyId);
  return Number.isInteger(companyId) && companyId > 0 ? companyId : null;
}

function currentUserId(req: Request): string {
  const userId = req.user?.id ?? req.session.userId;
  if (!userId) throw new Error("Authenticated user is required");
  return String(userId);
}

async function requireRetailCompany(req: Request, res: Response): Promise<number | null> {
  const companyId = currentCompanyId(req);
  if (!companyId) {
    res.status(400).json({ message: "No company selected" });
    return null;
  }
  const [company] = await db
    .select({ id: companies.id, companyType: companies.companyType })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  if (!company || company.companyType !== "retail") {
    res.status(409).json({ message: "Retail POS is only available for Retail / Variant Inventory companies" });
    return null;
  }
  return companyId;
}

async function ensureCompanyLocation(companyId: number, locationId: number): Promise<void> {
  const [location] = await db
    .select({ id: locations.id })
    .from(locations)
    .where(and(eq(locations.id, locationId), eq(locations.companyId, companyId), eq(locations.active, true)))
    .limit(1);
  if (!location) throw new Error("Location is not active or does not belong to the selected company");
}

async function ensureVariant(companyId: number, variantId: number) {
  const [variant] = await db
    .select({
      id: retailProductVariants.id,
      productId: retailProductVariants.productId,
      size: retailProductVariants.size,
      barcode: retailProductVariants.barcode,
      sku: retailProductVariants.sku,
      sellingPrice: retailProductVariants.sellingPrice,
      active: retailProductVariants.active,
      productName: retailProducts.name,
      productCode: retailProducts.code,
    })
    .from(retailProductVariants)
    .innerJoin(retailProducts, eq(retailProducts.id, retailProductVariants.productId))
    .where(
      and(
        eq(retailProductVariants.id, variantId),
        eq(retailProductVariants.companyId, companyId),
        eq(retailProducts.companyId, companyId),
        eq(retailProductVariants.active, true),
        eq(retailProducts.active, true)
      )
    )
    .limit(1);
  if (!variant) throw new Error("Retail variant not found or inactive");
  return variant;
}

async function lockInventoryRow(
  tx: Transaction,
  companyId: number,
  variantId: number,
  locationId: number
): Promise<{ quantity: number; averageCost: number }> {
  await tx
    .insert(retailVariantInventory)
    .values({ companyId, variantId, locationId, quantity: "0", averageCost: "0" })
    .onConflictDoNothing({ target: [retailVariantInventory.variantId, retailVariantInventory.locationId] });

  await tx.execute(
    sql`select id from retail_variant_inventory where company_id = ${companyId} and variant_id = ${variantId} and location_id = ${locationId} for update`
  );

  const [inventory] = await tx
    .select({ quantity: retailVariantInventory.quantity, averageCost: retailVariantInventory.averageCost })
    .from(retailVariantInventory)
    .where(
      and(
        eq(retailVariantInventory.companyId, companyId),
        eq(retailVariantInventory.variantId, variantId),
        eq(retailVariantInventory.locationId, locationId)
      )
    )
    .limit(1);

  if (!inventory) throw new Error("Retail inventory row could not be created");
  return { quantity: toNumber(inventory.quantity), averageCost: toNumber(inventory.averageCost) };
}

async function setInventoryQuantity(
  tx: Transaction,
  companyId: number,
  variantId: number,
  locationId: number,
  quantity: number
): Promise<void> {
  await tx
    .update(retailVariantInventory)
    .set({ quantity: String(quantity), updatedAt: new Date() })
    .where(
      and(
        eq(retailVariantInventory.companyId, companyId),
        eq(retailVariantInventory.variantId, variantId),
        eq(retailVariantInventory.locationId, locationId)
      )
    );
}

async function addMovement(
  tx: Transaction,
  input: {
    companyId: number;
    variantId: number;
    locationId: number;
    movementType: string;
    quantityDelta: number;
    before: number;
    after: number;
    eventKey: string;
    referenceType?: string;
    referenceId?: string | number;
    createdBy: string;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  await tx.insert(retailStockMovements).values({
    companyId: input.companyId,
    variantId: input.variantId,
    locationId: input.locationId,
    movementType: input.movementType,
    quantityDelta: String(input.quantityDelta),
    quantityBefore: String(input.before),
    quantityAfter: String(input.after),
    eventKey: input.eventKey,
    referenceType: input.referenceType ?? null,
    referenceId: input.referenceId == null ? null : String(input.referenceId),
    createdBy: input.createdBy,
    metadata: input.metadata ?? {},
  });
}

async function loadSaleResponse(companyId: number, saleId: number) {
  const [sale] = await db
    .select()
    .from(retailPosSales)
    .where(and(eq(retailPosSales.id, saleId), eq(retailPosSales.companyId, companyId)))
    .limit(1);
  if (!sale) return null;
  const items = await db
    .select({
      id: retailPosSaleItems.id,
      variantId: retailPosSaleItems.variantId,
      quantity: retailPosSaleItems.quantity,
      returnedQuantity: retailPosSaleItems.returnedQuantity,
      unitPrice: retailPosSaleItems.unitPrice,
      name: retailProducts.name,
      code: retailProducts.code,
      size: retailProductVariants.size,
      barcode: retailProductVariants.barcode,
      sku: retailProductVariants.sku,
      imageUrls: retailProducts.imageUrls,
      brand: retailBrands.name,
    })
    .from(retailPosSaleItems)
    .innerJoin(retailProductVariants, eq(retailProductVariants.id, retailPosSaleItems.variantId))
    .innerJoin(retailProducts, eq(retailProducts.id, retailProductVariants.productId))
    .leftJoin(retailBrands, eq(retailBrands.id, retailProducts.brandId))
    .where(and(eq(retailPosSaleItems.saleId, saleId), eq(retailPosSaleItems.companyId, companyId)));
  return {
    ...sale,
    totalAmount: toNumber(sale.totalAmount),
    items: items.map((item) => ({
      ...item,
      quantity: toNumber(item.quantity),
      returnedQuantity: toNumber(item.returnedQuantity),
      unitPrice: toNumber(item.unitPrice),
      brand: item.brand ?? "Other / No Brand",
    })),
  };
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
      const pattern = `%${search.replace(/[%_]/g, "\\      const pattern = `%${search.replace(/[%_]/g, "\\$&")}%`;")}%`;

      const rows = await db
        .select({
          variantId: retailProductVariants.id,
          productId: retailProducts.id,
          code: retailProducts.code,
          name: retailProducts.name,
          brand: retailBrands.name,
          imageUrls: retailProducts.imageUrls,
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
                  punctuationInsensitiveSearch(retailProductVariants.size, search),
                  punctuationInsensitiveSearch(retailBrands.name, search)
                )
              : undefined
          )
        )
        .orderBy(retailProducts.name, retailProductVariants.size)
        .limit(limit);

      res.json(
        rows.map((row) => ({
          ...row,
          brand: row.brand ?? "Other / No Brand",
          price: toNumber(row.price),
          quantity: toNumber(row.quantity),
        }))
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

      const [row] = await db
        .select({
          variantId: retailProductVariants.id,
          productId: retailProducts.id,
          code: retailProducts.code,
          name: retailProducts.name,
          brand: retailBrands.name,
          imageUrls: retailProducts.imageUrls,
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
            eq(retailProductVariants.barcode, barcode),
            eq(retailProductVariants.active, true),
            eq(retailProducts.active, true)
          )
        )
        .limit(1);
      if (!row) return res.status(404).json({ message: "Barcode not found" });
      res.json({
        ...row,
        brand: row.brand ?? "Other / No Brand",
        price: toNumber(row.price),
        quantity: toNumber(row.quantity),
      });
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

      const result = await db.transaction(async (tx) => {
        const [createdSale] = await tx
          .insert(retailPosSales)
          .values({
            companyId,
            locationId: body.locationId,
            idempotencyKey: body.idempotencyKey,
            totalAmount: "0",
            createdBy: userId,
            notes: body.notes ?? null,
          })
          .onConflictDoNothing({ target: [retailPosSales.companyId, retailPosSales.idempotencyKey] })
          .returning({ id: retailPosSales.id });

        if (!createdSale) {
          const [existing] = await tx
            .select({ id: retailPosSales.id })
            .from(retailPosSales)
            .where(and(eq(retailPosSales.companyId, companyId), eq(retailPosSales.idempotencyKey, body.idempotencyKey)))
            .limit(1);
          if (!existing) throw new Error("Sale retry could not be resolved");
          return { saleId: existing.id, replayed: true };
        }

        let totalAmount = 0;
        for (const item of items) {
          const variant = await ensureVariant(companyId, item.variantId);
          const stock = await lockInventoryRow(tx, companyId, item.variantId, body.locationId);
          let after: number;
          try {
            after = nextRetailSaleQuantity(stock.quantity, item.quantity, canSellNegativeStock);
          } catch {
            throw new Error(
              `Insufficient stock for ${variant.productName} / ${variant.size}. Available: ${stock.quantity}`
            );
          }
          await setInventoryQuantity(tx, companyId, item.variantId, body.locationId, after);
          const unitPrice = toNumber(variant.sellingPrice);
          const [saleItem] = await tx
            .insert(retailPosSaleItems)
            .values({
              companyId,
              saleId: createdSale.id,
              variantId: item.variantId,
              quantity: String(item.quantity),
              returnedQuantity: "0",
              unitPrice: String(unitPrice),
            })
            .returning({ id: retailPosSaleItems.id });
          await addMovement(tx, {
            companyId,
            variantId: item.variantId,
            locationId: body.locationId,
            movementType: "sale",
            quantityDelta: -item.quantity,
            before: stock.quantity,
            after,
            eventKey: `sale:${createdSale.id}:${saleItem.id}`,
            referenceType: "retail_pos_sale",
            referenceId: createdSale.id,
            createdBy: userId,
            metadata: { saleItemId: saleItem.id },
          });
          totalAmount += unitPrice * item.quantity;
        }

        await tx
          .update(retailPosSales)
          .set({ totalAmount: String(totalAmount), updatedAt: new Date() })
          .where(eq(retailPosSales.id, createdSale.id));
        return { saleId: createdSale.id, replayed: false };
      });

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
        const [createdReturn] = await tx
          .insert(retailPosReturns)
          .values({
            companyId,
            saleId,
            idempotencyKey: body.idempotencyKey,
            createdBy: userId,
            notes: body.notes ?? null,
          })
          .onConflictDoNothing({ target: [retailPosReturns.companyId, retailPosReturns.idempotencyKey] })
          .returning({ id: retailPosReturns.id });
        if (!createdReturn) {
          const [existing] = await tx
            .select({ id: retailPosReturns.id })
            .from(retailPosReturns)
            .where(
              and(eq(retailPosReturns.companyId, companyId), eq(retailPosReturns.idempotencyKey, body.idempotencyKey))
            )
            .limit(1);
          if (!existing) throw new Error("Return retry could not be resolved");
          return { returnId: existing.id, replayed: true };
        }

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
          throw new Error("Return location must match the original sale location");
        if (sale.status !== "completed") throw new Error("Canceled sales cannot receive additional returns");

        const aggregate = new Map<number, number>();
        for (const item of body.items)
          aggregate.set(item.saleItemId, (aggregate.get(item.saleItemId) ?? 0) + item.quantity);

        // Lock and preload every referenced sale item in one statement. Locking in a
        // deterministic id order also keeps concurrent returns from deadlocking each other.
        const saleItemIds = [...aggregate.keys()].sort((a, b) => a - b);
        const saleItemRows = await tx
          .select({
            id: retailPosSaleItems.id,
            variantId: retailPosSaleItems.variantId,
            quantity: retailPosSaleItems.quantity,
            returnedQuantity: retailPosSaleItems.returnedQuantity,
            unitPrice: retailPosSaleItems.unitPrice,
          })
          .from(retailPosSaleItems)
          .where(
            and(
              inArray(retailPosSaleItems.id, saleItemIds),
              eq(retailPosSaleItems.saleId, saleId),
              eq(retailPosSaleItems.companyId, companyId)
            )
          )
          .orderBy(retailPosSaleItems.id)
          .for("update");
        const saleItemsById = new Map(saleItemRows.map((row) => [row.id, row]));

        for (const [saleItemId, quantity] of aggregate) {
          const saleItem = saleItemsById.get(saleItemId);
          if (!saleItem) throw new Error(`Sale item ${saleItemId} not found`);
          const sold = toNumber(saleItem.quantity);
          const alreadyReturned = toNumber(saleItem.returnedQuantity);
          const nextReturnedQuantity = validateRetailReturnQuantity(sold, alreadyReturned, quantity);

          const stock = await lockInventoryRow(tx, companyId, saleItem.variantId, sale.locationId);
          const after = nextRetailReturnQuantity(stock.quantity, quantity);
          await setInventoryQuantity(tx, companyId, saleItem.variantId, sale.locationId, after);
          await tx
            .update(retailPosSaleItems)
            .set({ returnedQuantity: String(nextReturnedQuantity) })
            .where(eq(retailPosSaleItems.id, saleItem.id));
          const [returnItem] = await tx
            .insert(retailPosReturnItems)
            .values({
              companyId,
              returnId: createdReturn.id,
              saleItemId: saleItem.id,
              variantId: saleItem.variantId,
              locationId: sale.locationId,
              quantity: String(quantity),
              unitPrice: saleItem.unitPrice,
            })
            .returning({ id: retailPosReturnItems.id });
          await addMovement(tx, {
            companyId,
            variantId: saleItem.variantId,
            locationId: sale.locationId,
            movementType: "return",
            quantityDelta: quantity,
            before: stock.quantity,
            after,
            eventKey: `return:${createdReturn.id}:${returnItem.id}`,
            referenceType: "retail_pos_return",
            referenceId: createdReturn.id,
            createdBy: userId,
            metadata: { saleId, saleItemId: saleItem.id },
          });
        }
        return { returnId: createdReturn.id, replayed: false };
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
        ensureVariant(companyId, body.variantId),
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
      await Promise.all([ensureCompanyLocation(companyId, body.locationId), ensureVariant(companyId, body.variantId)]);
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
          metadata: { reason: body.reason },
        });
        return { replayed: false, operationId: operation.id, quantity: after };
      });
      res.status(result.replayed ? 200 : 201).json(result);
    } catch (error) {
      res.status(400).json({ message: getErrorMessage(error) });
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
          })
          .from(retailPosSaleItems)
          .where(and(eq(retailPosSaleItems.saleId, saleId), eq(retailPosSaleItems.companyId, companyId)));

        for (const item of saleItems) {
          const quantityToRestore = Math.max(0, toNumber(item.quantity) - toNumber(item.returnedQuantity));
          if (quantityToRestore <= 0) continue;
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
        return { replayed: false, operationId: operation.id };
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
