import { and, eq, inArray, sql } from "drizzle-orm";
import {
  retailBrands,
  retailPosReturnItems,
  retailPosReturns,
  retailPosSaleItems,
  retailPosSales,
  retailProductVariants,
  retailProducts,
} from "@shared/schema";
import { db } from "../../db";
import { addMovement, lockInventoryRow, setInventoryQuantity, type RetailTransaction } from "./retailStockLedger";
import { settleRetailSaleTx, type RetailPaymentInput } from "./retailFinancialService";
import { loadRetailSalePayments } from "./retailFinancialQueries";
import {
  nextRetailReturnQuantity,
  nextRetailSaleQuantity,
  validateRetailReturnQuantity,
  type RetailCartItemInput,
} from "./retailStockMath";

function toNumber(value: string | number | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

export function resolveRetailItemImages(variantImageUrls: unknown, productImageUrls: unknown): string[] {
  const variantImages = stringArray(variantImageUrls);
  return variantImages.length ? variantImages : stringArray(productImageUrls);
}

/** Sale with its exact-variant lines (color, size, barcode, photo) as shown on receipts and history. */
export async function loadSaleResponse(companyId: number, saleId: number) {
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
      color: retailProductVariants.color,
      size: retailProductVariants.size,
      barcode: retailProductVariants.barcode,
      sku: retailProductVariants.sku,
      variantImageUrls: retailProductVariants.imageUrls,
      productImageUrls: retailProducts.imageUrls,
      brand: retailBrands.name,
    })
    .from(retailPosSaleItems)
    .innerJoin(retailProductVariants, eq(retailProductVariants.id, retailPosSaleItems.variantId))
    .innerJoin(retailProducts, eq(retailProducts.id, retailProductVariants.productId))
    .leftJoin(retailBrands, eq(retailBrands.id, retailProducts.brandId))
    .where(and(eq(retailPosSaleItems.saleId, saleId), eq(retailPosSaleItems.companyId, companyId)));
  const payments = await loadRetailSalePayments(companyId, saleId);
  return {
    ...sale,
    totalAmount: toNumber(sale.totalAmount),
    payments,
    items: items.map((item) => {
      const { variantImageUrls, productImageUrls, ...rest } = item;
      return {
        ...rest,
        imageUrls: resolveRetailItemImages(variantImageUrls, productImageUrls),
        quantity: toNumber(item.quantity),
        returnedQuantity: toNumber(item.returnedQuantity),
        unitPrice: toNumber(item.unitPrice),
        brand: item.brand ?? "Other / No Brand",
      };
    }),
  };
}

/** Loads an active, company-owned variant or throws; used before every stock write. */
export async function ensureRetailVariant(executor: Pick<typeof db, "select">, companyId: number, variantId: number) {
  const [variant] = await executor
    .select({
      id: retailProductVariants.id,
      productId: retailProductVariants.productId,
      color: retailProductVariants.color,
      size: retailProductVariants.size,
      barcode: retailProductVariants.barcode,
      sku: retailProductVariants.sku,
      sellingPrice: retailProductVariants.sellingPrice,
      cost: retailProductVariants.cost,
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

export interface RetailSaleInput {
  companyId: number;
  locationId: number;
  idempotencyKey: string;
  notes?: string | null;
  items: RetailCartItemInput[];
  userId: string;
  username?: string | null;
  canSellNegativeStock: boolean;
  shiftId?: number | null;
  payments?: RetailPaymentInput[];
}

/**
 * Records a retail sale and deducts the exact variant at the exact location.
 * Idempotent on (company, idempotencyKey): a replay returns the original sale.
 */
export async function createRetailSaleInTx(
  tx: RetailTransaction,
  input: RetailSaleInput
): Promise<{ saleId: number; replayed: boolean }> {
  const { companyId } = input;
  const [createdSale] = await tx
    .insert(retailPosSales)
    .values({
      companyId,
      locationId: input.locationId,
      idempotencyKey: input.idempotencyKey,
      totalAmount: "0",
      createdBy: input.userId,
      notes: input.notes ?? null,
      shiftId: input.shiftId ?? null,
    })
    .onConflictDoNothing({ target: [retailPosSales.companyId, retailPosSales.idempotencyKey] })
    .returning({ id: retailPosSales.id });

  if (!createdSale) {
    const [existing] = await tx
      .select({ id: retailPosSales.id })
      .from(retailPosSales)
      .where(and(eq(retailPosSales.companyId, companyId), eq(retailPosSales.idempotencyKey, input.idempotencyKey)))
      .limit(1);
    if (!existing) throw new Error("Sale retry could not be resolved");
    return { saleId: existing.id, replayed: true };
  }

  let totalAmount = 0;
  let totalCost = 0;
  for (const item of input.items) {
    const variant = await ensureRetailVariant(tx, companyId, item.variantId);
    const stock = await lockInventoryRow(tx, companyId, item.variantId, input.locationId);
    let after: number;
    try {
      after = nextRetailSaleQuantity(stock.quantity, item.quantity, input.canSellNegativeStock);
    } catch {
      throw new Error(
        `Insufficient stock for ${variant.productName} / ${variant.color} / ${variant.size}. Available: ${stock.quantity}`
      );
    }
    await setInventoryQuantity(tx, companyId, item.variantId, input.locationId, after);
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
        // Snapshot cost at sale time so profit reports use the cost of the exact unit sold.
        unitCost: String(stock.averageCost > 0 ? stock.averageCost : toNumber(variant.cost)),
      })
      .returning({ id: retailPosSaleItems.id });
    await addMovement(tx, {
      companyId,
      variantId: item.variantId,
      locationId: input.locationId,
      movementType: "sale",
      quantityDelta: -item.quantity,
      before: stock.quantity,
      after,
      eventKey: `sale:${createdSale.id}:${saleItem.id}`,
      referenceType: "retail_pos_sale",
      referenceId: createdSale.id,
      createdBy: input.userId,
      metadata: { saleItemId: saleItem.id },
    });
    totalAmount += unitPrice * item.quantity;
    totalCost += toNumber(stock.averageCost > 0 ? stock.averageCost : variant.cost) * item.quantity;
  }

  await tx
    .update(retailPosSales)
    .set({ totalAmount: String(totalAmount), updatedAt: new Date() })
    .where(eq(retailPosSales.id, createdSale.id));

  await settleRetailSaleTx(tx, {
    companyId,
    locationId: input.locationId,
    saleId: createdSale.id,
    saleIdempotencyKey: input.idempotencyKey,
    totalAmount,
    totalCost,
    userId: input.userId,
    username: input.username ?? null,
    shiftId: input.shiftId ?? null,
    payments: input.payments,
  });

  return { saleId: createdSale.id, replayed: false };
}

export interface RetailReturnInput {
  companyId: number;
  saleId: number;
  locationId: number;
  idempotencyKey: string;
  notes?: string | null;
  items: Array<{ saleItemId: number; quantity: number }>;
  userId: string;
  metadata?: Record<string, unknown>;
}

/**
 * Returns sold units to the original sale location, restoring the exact variant
 * that was sold. Idempotent on (company, idempotencyKey).
 */
export async function createRetailReturnInTx(
  tx: RetailTransaction,
  input: RetailReturnInput
): Promise<{ returnId: number; replayed: boolean; refundValue: number; costValue: number }> {
  const { companyId, saleId } = input;
  const [createdReturn] = await tx
    .insert(retailPosReturns)
    .values({
      companyId,
      saleId,
      idempotencyKey: input.idempotencyKey,
      createdBy: input.userId,
      notes: input.notes ?? null,
    })
    .onConflictDoNothing({ target: [retailPosReturns.companyId, retailPosReturns.idempotencyKey] })
    .returning({ id: retailPosReturns.id });
  if (!createdReturn) {
    const [existing] = await tx
      .select({ id: retailPosReturns.id })
      .from(retailPosReturns)
      .where(and(eq(retailPosReturns.companyId, companyId), eq(retailPosReturns.idempotencyKey, input.idempotencyKey)))
      .limit(1);
    if (!existing) throw new Error("Return retry could not be resolved");
    return { returnId: existing.id, replayed: true, refundValue: 0, costValue: 0 };
  }

  await tx.execute(sql`select id from retail_pos_sales where id = ${saleId} and company_id = ${companyId} for update`);
  const [sale] = await tx
    .select({ id: retailPosSales.id, locationId: retailPosSales.locationId, status: retailPosSales.status })
    .from(retailPosSales)
    .where(and(eq(retailPosSales.id, saleId), eq(retailPosSales.companyId, companyId)))
    .limit(1);
  if (!sale) throw new Error("Retail sale not found");
  if (sale.locationId !== input.locationId) throw new Error("Return location must match the original sale location");
  if (sale.status !== "completed") throw new Error("Canceled sales cannot receive additional returns");

  const aggregate = new Map<number, number>();
  for (const item of input.items) aggregate.set(item.saleItemId, (aggregate.get(item.saleItemId) ?? 0) + item.quantity);

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
      unitCost: retailPosSaleItems.unitCost,
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

  let refundValue = 0;
  let costValue = 0;
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
        unitCost: saleItem.unitCost,
      })
      .returning({ id: retailPosReturnItems.id });
    refundValue += quantity * toNumber(saleItem.unitPrice);
    costValue += quantity * toNumber(saleItem.unitCost);
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
      createdBy: input.userId,
      metadata: { saleId, saleItemId: saleItem.id, ...input.metadata },
    });
  }
  return { returnId: createdReturn.id, replayed: false, refundValue, costValue };
}
