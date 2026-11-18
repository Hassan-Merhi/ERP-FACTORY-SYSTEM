// Extracted from ./retailSaleService.ts to keep that module under the source-size cap.
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  retailDiscountApprovals,
  retailPosSaleItems,
  retailPosSales,
  retailProducts,
  retailProductVariants,
} from "@shared/schema";
import { priceRetailCart, type RetailPricedCart } from "./retailPricing";
import { RetailApprovalReuseError } from "./retailDiscountApproval";
import { bestPromotionForLine } from "./retailPromotions";
import { DEFAULT_RETAIL_SELLING_SETTINGS } from "./retailSettings";
import { addMovement, lockInventoryRow, type RetailTransaction, setInventoryQuantity } from "./retailStockLedger";
import { nextRetailSaleQuantity } from "./retailStockMath";
import { db } from "../../db";
import { lineAmount, MoneyDecimal } from "../../lib/money";
import { settleRetailSaleTx } from "./retailFinancialService";
import {
  toNumber,
  type RetailSaleInput,
  type RetailSalePricingInput,
  type RetailSaleVariantRow,
} from "./retailSaleServiceLoadSaleResponse";

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
    customerId: input.customer?.id ?? null,
  });
  return { saleId: createdSale.id, replayed: false };
}
