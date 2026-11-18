import { and, eq, inArray, sql } from "drizzle-orm";
import { retailPosReturnItems, retailPosReturns, retailPosSaleItems, retailPosSales } from "@shared/schema";
import type Decimal from "decimal.js";
import {
  addMovement,
  lockInventoryRow,
  nextAverageCost,
  setInventoryQuantity,
  type RetailTransaction,
} from "./retailStockLedger";
import { trackRetailStockValueTx, type RetailStockValueTracker } from "./retailInventoryJournal";
import { nextRetailReturnQuantity, validateRetailReturnQuantity } from "./retailStockMath";
import { lineAmount, MoneyDecimal, toMoney } from "../../lib/money";
import { toNumber } from "./retailSaleServiceLoadSaleResponse";
export { ensureRetailVariant, loadSaleResponse, resolveRetailItemImages } from "./retailSaleServiceLoadSaleResponse";
export type {
  RetailSaleApprovalSnapshot,
  RetailSaleInput,
  RetailSaleLineRequest,
  RetailSalePricingInput,
  RetailSaleVariantRow,
} from "./retailSaleServiceLoadSaleResponse";
export { createRetailSaleInTx, prepareRetailSalePricing } from "./createRetailSaleInTx";

export interface RetailReturnInput {
  companyId: number;
  saleId: number;
  locationId: number;
  idempotencyKey: string;
  notes?: string | null;
  items: Array<{ saleItemId: number; quantity: number; restock?: boolean }>;
  userId: string;
  metadata?: Record<string, unknown>;
}

/**
 * Returns sold units to the original sale location, restoring the exact variant that
 * was sold and refunding the actual historical amount paid (`gross_unit_price`,
 * tax included) rather than the current or list price. Idempotent on (company, idempotencyKey).
 */
export async function createRetailReturnInTx(
  tx: RetailTransaction,
  input: RetailReturnInput
): Promise<{
  returnId: number;
  replayed: boolean;
  refundAmount: Decimal;
  refundTaxAmount: Decimal;
  refundValue: Decimal;
  costValue: Decimal;
  /** Wave 17 (D): journals the stock value returned, after the refund journal (null on a replay). */
  stockValue?: RetailStockValueTracker;
}> {
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
      .select({
        id: retailPosReturns.id,
        saleId: retailPosReturns.saleId,
        refundAmount: retailPosReturns.refundAmount,
        refundTaxAmount: retailPosReturns.refundTaxAmount,
      })
      .from(retailPosReturns)
      .where(and(eq(retailPosReturns.companyId, companyId), eq(retailPosReturns.idempotencyKey, input.idempotencyKey)))
      .limit(1);
    if (!existing) throw new Error("Return retry could not be resolved");
    if (existing.saleId !== saleId) {
      throw new Error("Return idempotency key was already used for another sale");
    }
    const priorLines = await tx
      .select({
        saleItemId: retailPosReturnItems.saleItemId,
        quantity: retailPosReturnItems.quantity,
        restocked: retailPosReturnItems.restocked,
      })
      .from(retailPosReturnItems)
      .where(and(eq(retailPosReturnItems.companyId, companyId), eq(retailPosReturnItems.returnId, existing.id)));
    const expected = new Map<number, { quantity: number; restock: boolean }>();
    for (const line of input.items) {
      const restock = line.restock !== false;
      const previous = expected.get(line.saleItemId);
      if (previous && previous.restock !== restock) throw new Error("Conflicting restock disposition on return retry");
      expected.set(line.saleItemId, { quantity: (previous?.quantity ?? 0) + line.quantity, restock });
    }
    if (
      priorLines.length !== expected.size ||
      priorLines.some((line) => {
        const requested = expected.get(line.saleItemId);
        return (
          !requested ||
          Math.abs(toNumber(line.quantity) - requested.quantity) > 0.000001 ||
          line.restocked !== requested.restock
        );
      })
    ) {
      throw new Error("Return idempotency key was already used for different items or quantities");
    }
    return {
      returnId: existing.id,
      replayed: true,
      refundAmount: toMoney(existing.refundAmount),
      refundTaxAmount: toMoney(existing.refundTaxAmount),
      refundValue: toMoney(existing.refundAmount),
      costValue: new MoneyDecimal(0),
    };
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

  const aggregate = new Map<number, { quantity: number; restock: boolean }>();
  for (const item of input.items) {
    const restock = item.restock !== false;
    const previous = aggregate.get(item.saleItemId);
    if (previous && previous.restock !== restock) {
      throw new Error("One sale line cannot have mixed restock dispositions in the same return");
    }
    aggregate.set(item.saleItemId, { quantity: (previous?.quantity ?? 0) + item.quantity, restock });
  }

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
      grossUnitPrice: retailPosSaleItems.grossUnitPrice,
      taxAmount: retailPosSaleItems.taxAmount,
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
  const stockValue = await trackRetailStockValueTx(
    tx,
    companyId,
    saleItemRows.map((row) => ({ variantId: row.variantId, locationId: sale.locationId }))
  );

  let refundAmount = new MoneyDecimal(0);
  let refundTaxAmount = new MoneyDecimal(0);
  let costValue = new MoneyDecimal(0);
  for (const [saleItemId, { quantity, restock }] of aggregate) {
    const saleItem = saleItemsById.get(saleItemId);
    if (!saleItem) throw new Error(`Sale item ${saleItemId} not found`);
    const sold = toNumber(saleItem.quantity);
    const alreadyReturned = toNumber(saleItem.returnedQuantity);
    const nextReturnedQuantity = validateRetailReturnQuantity(sold, alreadyReturned, quantity);

    const stock = await lockInventoryRow(tx, companyId, saleItem.variantId, sale.locationId);
    // Damaged/non-sellable goods are financially returned, but never reintroduced
    // into available stock. Keep the original COGS expense for written-off goods.
    const after = restock ? nextRetailReturnQuantity(stock.quantity, quantity) : stock.quantity;
    if (restock) {
      await setInventoryQuantity(
        tx,
        companyId,
        saleItem.variantId,
        sale.locationId,
        after,
        nextAverageCost(stock.quantity, stock.averageCost, quantity, toNumber(saleItem.unitCost))
      );
    }
    await tx
      .update(retailPosSaleItems)
      .set({ returnedQuantity: String(nextReturnedQuantity) })
      .where(eq(retailPosSaleItems.id, saleItem.id));

    // Refund basis: the historic tax-inclusive price paid for this line.
    // Exact money (wave 17 C): Decimal, never a float product.
    const grossPerUnit = toMoney(saleItem.grossUnitPrice).gt(0)
      ? toMoney(saleItem.grossUnitPrice)
      : toMoney(saleItem.unitPrice);
    const lineRefund = lineAmount(quantity, grossPerUnit).toDecimalPlaces(6);
    const lineRefundTax =
      sold > 0 ? toMoney(saleItem.taxAmount).times(quantity).div(sold).toDecimalPlaces(6) : new MoneyDecimal(0);
    refundAmount = refundAmount.plus(lineRefund);
    refundTaxAmount = refundTaxAmount.plus(lineRefundTax);
    if (restock) costValue = costValue.plus(lineAmount(quantity, saleItem.unitCost));

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
        grossUnitPrice: grossPerUnit.toFixed(),
        taxAmount: lineRefundTax.toFixed(),
        restocked: restock,
      })
      .returning({ id: retailPosReturnItems.id });
    await addMovement(tx, {
      companyId,
      variantId: saleItem.variantId,
      locationId: sale.locationId,
      movementType: "return",
      // Keep a zero-delta audit movement even for an un-restocked return. This
      // preserves the chain without pretending damaged goods are sellable.
      quantityDelta: restock ? quantity : 0,
      before: stock.quantity,
      after,
      eventKey: `return:${createdReturn.id}:${returnItem.id}`,
      referenceType: "retail_pos_return",
      referenceId: createdReturn.id,
      createdBy: input.userId,
      metadata: { saleId, saleItemId: saleItem.id, restocked: restock, returnedQuantity: quantity, ...input.metadata },
    });
  }
  refundAmount = refundAmount.toDecimalPlaces(6);
  refundTaxAmount = refundTaxAmount.toDecimalPlaces(6);
  await tx
    .update(retailPosReturns)
    .set({ refundAmount: refundAmount.toFixed(), refundTaxAmount: refundTaxAmount.toFixed() })
    .where(eq(retailPosReturns.id, createdReturn.id));
  return {
    returnId: createdReturn.id,
    replayed: false,
    refundAmount,
    refundTaxAmount,
    refundValue: refundAmount,
    costValue,
    stockValue,
  };
}
