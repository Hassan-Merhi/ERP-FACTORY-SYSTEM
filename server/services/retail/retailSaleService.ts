import { and, eq, inArray, sql } from "drizzle-orm";
import {
  retailBrands,
  retailDiscountApprovals,
  retailPosReturnItems,
  retailPosReturns,
  retailPosSaleItems,
  retailPosSales,
  retailProductVariants,
  retailProducts,
} from "@shared/schema";
import type Decimal from "decimal.js";
import type { RetailLineDiscountInputType, RetailOrderDiscountInput, RetailPricedCart } from "./retailPricing";
import { priceRetailCart, roundRetailMoney } from "./retailPricing";
import { RetailApprovalReuseError } from "./retailDiscountApproval";
import { bestPromotionForLine, type RetailPromotionRow } from "./retailPromotions";
import { DEFAULT_RETAIL_SELLING_SETTINGS, type RetailSellingSettings } from "./retailSettings";
import {
  addMovement,
  lockInventoryRow,
  nextAverageCost,
  setInventoryQuantity,
  type RetailTransaction,
} from "./retailStockLedger";
import { trackRetailStockValueTx, type RetailStockValueTracker } from "./retailInventoryJournal";
import { nextRetailReturnQuantity, nextRetailSaleQuantity, validateRetailReturnQuantity } from "./retailStockMath";
import { db } from "../../db";
import { lineAmount, MoneyDecimal, toMoney } from "../../lib/money";
import { settleRetailSaleTx, type RetailPaymentInput } from "./retailFinancialService";
import { loadRetailSalePayments } from "./retailFinancialQueries";

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
      originalUnitPrice: retailPosSaleItems.originalUnitPrice,
      unitPrice: retailPosSaleItems.unitPrice,
      grossUnitPrice: retailPosSaleItems.grossUnitPrice,
      lineDiscountAmount: retailPosSaleItems.lineDiscountAmount,
      lineDiscountType: retailPosSaleItems.lineDiscountType,
      lineDiscountValue: retailPosSaleItems.lineDiscountValue,
      discountReason: retailPosSaleItems.discountReason,
      priceOverride: retailPosSaleItems.priceOverride,
      promotionId: retailPosSaleItems.promotionId,
      taxAmount: retailPosSaleItems.taxAmount,
      lineTotal: retailPosSaleItems.lineTotal,
      approvedByUserId: retailPosSaleItems.approvedByUserId,
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
    payments,
    customerId: sale.customerId ?? null,
    customerName: sale.customerName ?? "Walk-in",
    listSubtotal: toNumber(sale.listSubtotal),
    discountTotal: toNumber(sale.discountTotal),
    subtotal: toNumber(sale.subtotal),
    orderDiscountType: sale.orderDiscountType ?? "none",
    orderDiscountValue: toNumber(sale.orderDiscountValue),
    orderDiscountAmount: toNumber(sale.orderDiscountAmount),
    orderDiscountReason: sale.orderDiscountReason ?? null,
    taxEnabled: Boolean(sale.taxEnabled),
    taxLabel: sale.taxLabel ?? "Tax",
    taxRate: toNumber(sale.taxRate),
    taxInclusive: Boolean(sale.taxInclusive),
    taxAmount: toNumber(sale.taxAmount),
    totalAmount: toNumber(sale.totalAmount),
    approvedByUserId: sale.approvedByUserId ?? null,
    approvedByName: sale.approvedByName ?? null,
    items: items.map((item) => {
      const { variantImageUrls, productImageUrls, ...rest } = item;
      return {
        ...rest,
        imageUrls: resolveRetailItemImages(variantImageUrls, productImageUrls),
        quantity: toNumber(item.quantity),
        returnedQuantity: toNumber(item.returnedQuantity),
        originalUnitPrice: toNumber(item.originalUnitPrice) || toNumber(item.unitPrice),
        unitPrice: toNumber(item.unitPrice),
        grossUnitPrice: toNumber(item.grossUnitPrice) || toNumber(item.unitPrice),
        lineDiscountAmount: toNumber(item.lineDiscountAmount),
        lineDiscountValue: toNumber(item.lineDiscountValue),
        taxAmount: toNumber(item.taxAmount),
        lineTotal: toNumber(item.lineTotal) || roundRetailMoney(toNumber(item.unitPrice) * toNumber(item.quantity)),
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

export interface RetailSaleLineRequest {
  variantId: number;
  quantity: number;
  priceOverride?: number | null;
  discountType?: RetailLineDiscountInputType | null;
  discountValue?: number | null;
  discountReason?: string | null;
}

export interface RetailSaleApprovalSnapshot {
  approvalId: number | null;
  approvedByUserId: string | null;
  approvedByName: string | null;
}

export interface RetailSaleInput {
  companyId: number;
  locationId: number;
  idempotencyKey: string;
  notes?: string | null;
  items: RetailSaleLineRequest[];
  userId: string;
  username?: string | null;
  canSellNegativeStock: boolean;
  shiftId?: number | null;
  payments?: RetailPaymentInput[];
  customer?: { id: number | null; name: string } | null;
  orderDiscount?: RetailOrderDiscountInput | null;
  /** Company selling settings snapshot (tax + policy). Defaults to Wave 1 behaviour. */
  settings?: RetailSellingSettings | null;
  /** Active promotions for the company; the best match per line is applied automatically. */
  promotions?: RetailPromotionRow[] | null;
  approval?: RetailSaleApprovalSnapshot | null;
}

export interface RetailSaleVariantRow {
  id: number;
  productId: number;
  brandId: number | null;
  color: string;
  size: string;
  sellingPrice: string | number;
  cost: string | number;
  productName: string;
}

export interface RetailSalePricingInput {
  companyId: number;
  items: RetailSaleLineRequest[];
  orderDiscount?: RetailOrderDiscountInput | null;
  settings?: RetailSellingSettings | null;
  promotions?: RetailPromotionRow[] | null;
}

/**
 * Loads the requested variants from the database and prices the cart exactly the way
 * checkout will. Routes use it to evaluate the approval policy before writing anything;
 * `createRetailSaleInTx` re-runs it inside the transaction so the snapshot is authoritative.
 */
export async function prepareRetailSalePricing(
  executor: Pick<typeof db, "select">,
  input: RetailSalePricingInput
): Promise<{ priced: RetailPricedCart; variantsById: Map<number, RetailSaleVariantRow> }> {
  const settings = input.settings ?? DEFAULT_RETAIL_SELLING_SETTINGS;
  const promotions = input.promotions ?? [];
  const variantRows = await executor
    .select({
      id: retailProductVariants.id,
      productId: retailProductVariants.productId,
      brandId: retailProducts.brandId,
      color: retailProductVariants.color,
      size: retailProductVariants.size,
      sellingPrice: retailProductVariants.sellingPrice,
      cost: retailProductVariants.cost,
      productName: retailProducts.name,
    })
    .from(retailProductVariants)
    .innerJoin(retailProducts, eq(retailProducts.id, retailProductVariants.productId))
    .where(
      and(
        eq(retailProductVariants.companyId, input.companyId),
        eq(retailProducts.companyId, input.companyId),
        eq(retailProductVariants.active, true),
        eq(retailProducts.active, true),
        inArray(
          retailProductVariants.id,
          input.items.map((item) => item.variantId)
        )
      )
    );
  const variantsById = new Map(variantRows.map((row) => [row.id, row]));
  const now = new Date();
  const priced = priceRetailCart(
    input.items.map((item) => {
      const variant = variantsById.get(item.variantId);
      if (!variant) throw new Error("Retail variant not found or inactive");
      const listUnitPrice = toNumber(variant.sellingPrice);
      const hasOverride = item.priceOverride !== null && item.priceOverride !== undefined;
      const promotion =
        !hasOverride && promotions.length
          ? bestPromotionForLine(
              promotions,
              { variantId: variant.id, productId: variant.productId, brandId: variant.brandId ?? null },
              listUnitPrice,
              now
            )
          : null;
      return {
        variantId: item.variantId,
        quantity: item.quantity,
        listUnitPrice,
        priceOverride: hasOverride ? Number(item.priceOverride) : null,
        discountType: item.discountType ?? ("none" as const),
        discountValue: item.discountValue ?? 0,
        discountReason: item.discountReason ?? null,
        promotion,
      };
    }),
    input.orderDiscount ?? { type: "none", value: 0 },
    {
      enabled: settings.taxEnabled,
      rate: settings.taxRate,
      inclusive: settings.taxInclusive,
      label: settings.taxLabel,
    }
  );
  return { priced, variantsById };
}

/**
 * Records a retail sale and deducts the exact variant at the exact location.
 *
 * Prices are re-derived from the variant rows loaded inside this transaction (list
 * price, promotion, discounts, order discount, tax) and snapshotted per line, so the
 * receipt/return/report history can never disagree with what was charged. Idempotent
 * on (company, idempotencyKey): a replay returns the original sale without deducting twice.
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
      customerId: input.customer?.id ?? null,
      customerName: input.customer?.name?.trim() ? input.customer.name.trim().slice(0, 191) : "Walk-in",
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

  const settings = input.settings ?? DEFAULT_RETAIL_SELLING_SETTINGS;
  const approval = input.approval ?? null;
  // Exact money (wave 17 C): the cost is a Decimal sum, never a float sum; the
  // priced cart is integer cents (retailPricing.ts).
  let totalCost = new MoneyDecimal(0);

  // ── Price the cart from the database ──────────────────────────────────────
  const { priced, variantsById } = await prepareRetailSalePricing(tx, {
    companyId,
    items: input.items,
    orderDiscount: input.orderDiscount,
    settings,
    promotions: input.promotions,
  });

  for (const line of priced.lines) {
    const variant = variantsById.get(line.variantId);
    if (!variant) throw new Error("Retail variant not found or inactive");
    const stock = await lockInventoryRow(tx, companyId, line.variantId, input.locationId);
    let after: number;
    try {
      after = nextRetailSaleQuantity(stock.quantity, line.quantity, input.canSellNegativeStock);
    } catch {
      throw new Error(
        `Insufficient stock for ${variant.productName} / ${variant.color} / ${variant.size}. Available: ${stock.quantity}`
      );
    }
    await setInventoryQuantity(tx, companyId, line.variantId, input.locationId, after);
    const [saleItem] = await tx
      .insert(retailPosSaleItems)
      .values({
        companyId,
        saleId: createdSale.id,
        variantId: line.variantId,
        quantity: String(line.quantity),
        returnedQuantity: "0",
        originalUnitPrice: String(line.originalUnitPrice),
        unitPrice: String(line.unitPrice),
        grossUnitPrice: String(line.grossUnitPrice),
        lineDiscountAmount: String(line.lineDiscountAmount),
        lineDiscountType: line.lineDiscountType,
        lineDiscountValue: String(line.lineDiscountValue),
        discountReason: line.discountReason,
        priceOverride: line.priceOverride,
        promotionId: line.promotionId,
        taxAmount: String(line.taxAmount),
        lineTotal: String(line.lineTotal),
        approvedByUserId: approval?.approvedByUserId ?? null,
        // Snapshot cost at sale time so profit reports use the cost of the exact unit sold.
        unitCost: String(stock.averageCost > 0 ? stock.averageCost : toNumber(variant.cost)),
      })
      .returning({ id: retailPosSaleItems.id });
    await addMovement(tx, {
      companyId,
      variantId: line.variantId,
      locationId: input.locationId,
      movementType: "sale",
      quantityDelta: -line.quantity,
      before: stock.quantity,
      after,
      eventKey: `sale:${createdSale.id}:${saleItem.id}`,
      referenceType: "retail_pos_sale",
      referenceId: createdSale.id,
      createdBy: input.userId,
      metadata: { saleItemId: saleItem.id },
    });
    totalCost = totalCost.plus(lineAmount(line.quantity, stock.averageCost > 0 ? stock.averageCost : variant.cost));
  }

  await tx
    .update(retailPosSales)
    .set({
      listSubtotal: String(priced.listSubtotal),
      discountTotal: String(priced.discountTotal),
      subtotal: String(priced.subtotal),
      orderDiscountType: input.orderDiscount?.type ?? "none",
      orderDiscountValue: String(input.orderDiscount?.value ?? 0),
      orderDiscountAmount: String(priced.orderDiscountAmount),
      orderDiscountReason: input.orderDiscount?.reason?.trim() ? input.orderDiscount.reason.trim() : null,
      taxEnabled: settings.taxEnabled,
      taxLabel: settings.taxLabel,
      taxRate: String(settings.taxRate),
      taxInclusive: settings.taxInclusive,
      taxAmount: String(priced.taxAmount),
      totalAmount: String(priced.totalAmount),
      approvalId: approval?.approvalId ?? null,
      approvedByUserId: approval?.approvedByUserId ?? null,
      approvedByName: approval?.approvedByName ?? null,
      updatedAt: new Date(),
    })
    .where(eq(retailPosSales.id, createdSale.id));

  // Consume the manager approval inside the same transaction: a consumed approval can
  // never be replayed for a different sale, while retrying the same sale is allowed.
  if (approval?.approvalId) {
    const consumed = await tx
      .update(retailDiscountApprovals)
      .set({ consumedSaleId: createdSale.id, consumedAt: new Date() })
      .where(
        and(
          eq(retailDiscountApprovals.id, approval.approvalId),
          eq(retailDiscountApprovals.companyId, companyId),
          sql`(${retailDiscountApprovals.consumedSaleId} IS NULL OR ${retailDiscountApprovals.consumedSaleId} = ${createdSale.id})`
        )
      )
      .returning({ id: retailDiscountApprovals.id });
    if (!consumed.length) throw new RetailApprovalReuseError();
  }
  await settleRetailSaleTx(tx, {
    companyId,
    locationId: input.locationId,
    saleId: createdSale.id,
    saleIdempotencyKey: input.idempotencyKey,
    totalAmount: priced.totalAmount,
    taxAmount: priced.taxAmount,
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
        refundAmount: retailPosReturns.refundAmount,
        refundTaxAmount: retailPosReturns.refundTaxAmount,
      })
      .from(retailPosReturns)
      .where(and(eq(retailPosReturns.companyId, companyId), eq(retailPosReturns.idempotencyKey, input.idempotencyKey)))
      .limit(1);
    if (!existing) throw new Error("Return retry could not be resolved");
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
  for (const [saleItemId, quantity] of aggregate) {
    const saleItem = saleItemsById.get(saleItemId);
    if (!saleItem) throw new Error(`Sale item ${saleItemId} not found`);
    const sold = toNumber(saleItem.quantity);
    const alreadyReturned = toNumber(saleItem.returnedQuantity);
    const nextReturnedQuantity = validateRetailReturnQuantity(sold, alreadyReturned, quantity);

    const stock = await lockInventoryRow(tx, companyId, saleItem.variantId, sale.locationId);
    const after = nextRetailReturnQuantity(stock.quantity, quantity);
    // Wave 17 (D): the units come back at the cost they left with (value-exact), blended into the average.
    await setInventoryQuantity(
      tx,
      companyId,
      saleItem.variantId,
      sale.locationId,
      after,
      nextAverageCost(stock.quantity, stock.averageCost, quantity, toNumber(saleItem.unitCost))
    );
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
    costValue = costValue.plus(lineAmount(quantity, saleItem.unitCost));

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
      createdBy: input.userId,
      metadata: { saleId, saleItemId: saleItem.id, ...input.metadata },
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
