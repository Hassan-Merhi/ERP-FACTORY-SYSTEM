import Decimal from "decimal.js";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  retailAccountingPostings,
  retailBrands,
  retailPosPayments,
  retailPosReturnItems,
  retailPosReturns,
  retailPosSaleItems,
  retailPosSales,
  retailProductVariants,
  retailProducts,
} from "@shared/schema";
import { db } from "../../db";
import { addMovement, lockInventoryRow, setInventoryQuantity, type RetailTransaction } from "./retailStockLedger";
import {
  nextRetailReturnQuantity,
  nextRetailSaleQuantity,
  validateRetailReturnQuantity,
  type RetailCartItemInput,
} from "./retailStockMath";
import {
  calculateRetailReturnAmounts,
  calculateRetailSaleAmounts,
  finalizeRetailTender,
  retailCheckoutFingerprint,
  retailMoney,
  allocateRetailRefund,
  type RetailTenderInput,
} from "./retailFinancialMath";
import { calculateRetailCogs, postRetailAccountingEventTx } from "./retailAccountingBridge";
import { requireOpenRetailShiftTx } from "./retailShiftService";

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

/**
 * Finalized checkout view used by POS history, payment display and receipt
 * rendering. All tender and amount fields are snapshots returned by the same
 * server-side transaction; clients do not recompute settled totals.
 */
export async function loadSaleResponse(companyId: number, saleId: number) {
  const [sale] = await db
    .select()
    .from(retailPosSales)
    .where(and(eq(retailPosSales.id, saleId), eq(retailPosSales.companyId, companyId)))
    .limit(1);
  if (!sale) return null;
  const [items, payments, accountingPostings] = await Promise.all([
    db
      .select({
        id: retailPosSaleItems.id,
        variantId: retailPosSaleItems.variantId,
        quantity: retailPosSaleItems.quantity,
        returnedQuantity: retailPosSaleItems.returnedQuantity,
        unitPrice: retailPosSaleItems.unitPrice,
        unitCost: retailPosSaleItems.unitCost,
        grossAmount: retailPosSaleItems.grossAmount,
        discountAmount: retailPosSaleItems.discountAmount,
        taxAmount: retailPosSaleItems.taxAmount,
        totalAmount: retailPosSaleItems.totalAmount,
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
      .where(and(eq(retailPosSaleItems.saleId, saleId), eq(retailPosSaleItems.companyId, companyId))),
    db
      .select({
        id: retailPosPayments.id,
        operationType: retailPosPayments.operationType,
        method: retailPosPayments.method,
        amount: retailPosPayments.amount,
        amountTendered: retailPosPayments.amountTendered,
        changeDue: retailPosPayments.changeDue,
        reference: retailPosPayments.reference,
        cashierId: retailPosPayments.cashierId,
        locationId: retailPosPayments.locationId,
        shiftId: retailPosPayments.shiftId,
        createdAt: retailPosPayments.createdAt,
      })
      .from(retailPosPayments)
      .where(and(eq(retailPosPayments.saleId, saleId), eq(retailPosPayments.companyId, companyId)))
      .orderBy(retailPosPayments.id),
    db
      .select({ postingType: retailAccountingPostings.postingType, voucherId: retailAccountingPostings.voucherId })
      .from(retailAccountingPostings)
      .where(and(eq(retailAccountingPostings.saleId, saleId), eq(retailAccountingPostings.companyId, companyId)))
      .orderBy(retailAccountingPostings.id),
  ]);

  const returnRows = items.length
    ? await db
        .select({ saleItemId: retailPosReturnItems.saleItemId, totalAmount: retailPosReturnItems.totalAmount })
        .from(retailPosReturnItems)
        .where(
          and(
            eq(retailPosReturnItems.companyId, companyId),
            inArray(
              retailPosReturnItems.saleItemId,
              items.map((item) => item.id)
            )
          )
        )
    : [];
  const returnedAmountBySaleItem = new Map<number, Decimal>();
  for (const returnRow of returnRows) {
    const amount = returnedAmountBySaleItem.get(returnRow.saleItemId) ?? new Decimal(0);
    returnedAmountBySaleItem.set(returnRow.saleItemId, amount.plus(returnRow.totalAmount ?? 0));
  }

  const paymentMethodTotals = new Map<string, { sales: Decimal; refunds: Decimal }>();
  for (const payment of payments) {
    const totals = paymentMethodTotals.get(payment.method) ?? { sales: new Decimal(0), refunds: new Decimal(0) };
    const amount = new Decimal(payment.amount ?? 0);
    if (payment.operationType === "sale") totals.sales = totals.sales.plus(amount);
    else totals.refunds = totals.refunds.plus(amount.abs());
    paymentMethodTotals.set(payment.method, totals);
  }

  const salePayments = payments.filter((payment) => payment.operationType === "sale");
  const refundPayments = payments.filter((payment) => payment.operationType !== "sale");
  const changeDue = salePayments.reduce((sum, payment) => sum.plus(payment.changeDue ?? 0), new Decimal(0));
  const paidAmount = salePayments.reduce((sum, payment) => sum.plus(payment.amount), new Decimal(0));
  const refundedAmount = refundPayments.reduce(
    (sum, payment) => sum.plus(new Decimal(payment.amount ?? 0).abs()),
    new Decimal(0)
  );

  return {
    ...sale,
    subtotalAmount: toNumber(sale.subtotalAmount),
    discountAmount: toNumber(sale.discountAmount),
    taxAmount: toNumber(sale.taxAmount),
    totalAmount: toNumber(sale.totalAmount),
    changeDue: Number(retailMoney(changeDue)),
    paidAmount: Number(retailMoney(paidAmount)),
    refundedAmount: Number(retailMoney(refundedAmount)),
    payments: payments.map((payment) => ({
      ...payment,
      amount: toNumber(payment.amount),
      amountTendered: payment.amountTendered == null ? null : toNumber(payment.amountTendered),
      changeDue: toNumber(payment.changeDue),
    })),
    paymentMethodTotals: [...paymentMethodTotals.entries()].map(([method, totals]) => ({
      method,
      sales: Number(retailMoney(totals.sales)),
      refunds: Number(retailMoney(totals.refunds)),
      net: Number(retailMoney(totals.sales.minus(totals.refunds))),
    })),
    accountingVoucherId: accountingPostings.find((posting) => posting.postingType === "sale")?.voucherId ?? null,
    accountingPostings,
    items: items.map((item) => {
      const { variantImageUrls, productImageUrls, ...rest } = item;
      return {
        ...rest,
        imageUrls: resolveRetailItemImages(variantImageUrls, productImageUrls),
        quantity: toNumber(item.quantity),
        returnedQuantity: toNumber(item.returnedQuantity),
        returnedAmount: Number(retailMoney(returnedAmountBySaleItem.get(item.id) ?? 0)),
        unitPrice: toNumber(item.unitPrice),
        unitCost: toNumber(item.unitCost),
        grossAmount: toNumber(item.grossAmount),
        discountAmount: toNumber(item.discountAmount),
        taxAmount: toNumber(item.taxAmount),
        totalAmount: toNumber(item.totalAmount),
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
  canSellNegativeStock: boolean;
  discountAmount?: number | string;
  taxAmount?: number | string;
  shiftId?: number | null;
  checkoutVersion?: number | null;
  requestFingerprint?: string;
}

export type RetailSaleCreationResult = {
  saleId: number;
  replayed: boolean;
  amounts: ReturnType<typeof calculateRetailSaleAmounts> | null;
};

/**
 * Persists the one authoritative sale amount snapshot and deducts the exact
 * variant stock. Its idempotency key and request fingerprint are committed
 * together with inventory, payment and accounting work by the caller.
 */
export async function createRetailSaleInTx(
  tx: RetailTransaction,
  input: RetailSaleInput
): Promise<RetailSaleCreationResult> {
  const { companyId } = input;
  const aggregate = new Map<number, number>();
  for (const item of input.items) aggregate.set(item.variantId, (aggregate.get(item.variantId) ?? 0) + item.quantity);
  const items = [...aggregate.entries()]
    .map(([variantId, quantity]) => ({ variantId, quantity }))
    .sort((a, b) => a.variantId - b.variantId);
  if (!items.length) throw new Error("A Retail sale needs at least one item");

  const requestFingerprint =
    input.requestFingerprint ??
    retailCheckoutFingerprint({
      locationId: input.locationId,
      items,
      discountAmount: retailMoney(input.discountAmount ?? 0),
      taxAmount: retailMoney(input.taxAmount ?? 0),
    });
  const [createdSale] = await tx
    .insert(retailPosSales)
    .values({
      companyId,
      locationId: input.locationId,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint,
      checkoutVersion: input.checkoutVersion ?? null,
      shiftId: input.shiftId ?? null,
      subtotalAmount: "0",
      discountAmount: "0",
      taxAmount: "0",
      totalAmount: "0",
      createdBy: input.userId,
      notes: input.notes ?? null,
    })
    .onConflictDoNothing({ target: [retailPosSales.companyId, retailPosSales.idempotencyKey] })
    .returning({ id: retailPosSales.id });

  if (!createdSale) {
    const [existing] = await tx
      .select({ id: retailPosSales.id, requestFingerprint: retailPosSales.requestFingerprint })
      .from(retailPosSales)
      .where(and(eq(retailPosSales.companyId, companyId), eq(retailPosSales.idempotencyKey, input.idempotencyKey)))
      .limit(1);
    if (!existing) throw new Error("Sale retry could not be resolved");
    if (existing.requestFingerprint !== requestFingerprint) {
      throw new Error("RETAIL_IDEMPOTENCY_CONFLICT: checkout key is already bound to different sale/payment details");
    }
    return { saleId: existing.id, replayed: true, amounts: null };
  }

  const variants = new Map<number, Awaited<ReturnType<typeof ensureRetailVariant>>>();
  for (const item of items) variants.set(item.variantId, await ensureRetailVariant(tx, companyId, item.variantId));

  // Lock all stock rows in a deterministic variant order so split-variant
  // checkouts cannot deadlock each other.
  const stockByVariant = new Map<number, Awaited<ReturnType<typeof lockInventoryRow>>>();
  for (const item of items) {
    const stock = await lockInventoryRow(tx, companyId, item.variantId, input.locationId);
    const variant = variants.get(item.variantId)!;
    try {
      nextRetailSaleQuantity(stock.quantity, item.quantity, input.canSellNegativeStock);
    } catch {
      throw new Error(
        `Insufficient stock for ${variant.productName} / ${variant.color} / ${variant.size}. Available: ${stock.quantity}`
      );
    }
    stockByVariant.set(item.variantId, stock);
  }

  const amounts = calculateRetailSaleAmounts(
    items.map((item) => {
      const variant = variants.get(item.variantId)!;
      const stock = stockByVariant.get(item.variantId)!;
      return {
        variantId: item.variantId,
        quantity: item.quantity,
        unitPrice: variant.sellingPrice,
        // Use the exact location cost snapshot used by this sale, falling back
        // only when the location has no weighted average yet.
        unitCost: stock.averageCost > 0 ? stock.averageCost : toNumber(variant.cost),
      };
    }),
    input.discountAmount ?? 0,
    input.taxAmount ?? 0
  );

  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    const variant = variants.get(item.variantId)!;
    const stock = stockByVariant.get(item.variantId)!;
    const line = amounts.lines[index];
    const after = nextRetailSaleQuantity(stock.quantity, item.quantity, input.canSellNegativeStock);
    await setInventoryQuantity(tx, companyId, item.variantId, input.locationId, after);
    const [saleItem] = await tx
      .insert(retailPosSaleItems)
      .values({
        companyId,
        saleId: createdSale.id,
        variantId: item.variantId,
        quantity: String(item.quantity),
        returnedQuantity: "0",
        unitPrice: String(variant.sellingPrice),
        unitCost: String(line.unitCost),
        grossAmount: line.grossAmount,
        discountAmount: line.discountAmount,
        taxAmount: line.taxAmount,
        totalAmount: line.totalAmount,
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
  }

  await tx
    .update(retailPosSales)
    .set({
      subtotalAmount: amounts.subtotalAmount,
      discountAmount: amounts.discountAmount,
      taxAmount: amounts.taxAmount,
      totalAmount: amounts.totalAmount,
      updatedAt: new Date(),
    })
    .where(eq(retailPosSales.id, createdSale.id));
  return { saleId: createdSale.id, replayed: false, amounts };
}

export async function finalizeRetailSalePaymentsInTx(
  tx: RetailTransaction,
  input: {
    companyId: number;
    saleId: number;
    locationId: number;
    shiftId: number;
    idempotencyKey: string;
    userId: string;
    username?: string | null;
    amounts: ReturnType<typeof calculateRetailSaleAmounts>;
    paymentLines: RetailTenderInput[];
  }
): Promise<{ changeDue: string }> {
  const payments = finalizeRetailTender(input.amounts.totalAmount, input.paymentLines);
  await tx.insert(retailPosPayments).values(
    payments.map((payment, lineNumber) => ({
      companyId: input.companyId,
      saleId: input.saleId,
      shiftId: input.shiftId,
      locationId: input.locationId,
      operationType: "sale",
      method: payment.method,
      amount: payment.amount,
      amountTendered: payment.amountTendered,
      changeDue: payment.changeDue,
      reference: payment.reference,
      cashierId: input.userId,
      idempotencyKey: input.idempotencyKey,
      lineNumber,
    }))
  );

  const costLines = await tx
    .select({ quantity: retailPosSaleItems.quantity, unitCost: retailPosSaleItems.unitCost })
    .from(retailPosSaleItems)
    .where(and(eq(retailPosSaleItems.companyId, input.companyId), eq(retailPosSaleItems.saleId, input.saleId)));
  const cogsAmount = calculateRetailCogs(
    costLines.map((line) => ({
      quantity: String(line.quantity),
      unitCost: String(line.unitCost),
    }))
  );
  await postRetailAccountingEventTx(tx, {
    companyId: input.companyId,
    saleId: input.saleId,
    locationId: input.locationId,
    referenceKey: `sale:${input.saleId}`,
    postingType: "sale",
    amounts: {
      subtotalAmount: input.amounts.subtotalAmount,
      discountAmount: input.amounts.discountAmount,
      taxAmount: input.amounts.taxAmount,
      totalAmount: input.amounts.totalAmount,
      cogsAmount,
    },
    payments: payments.map((payment) => ({ method: payment.method, amount: payment.amount })),
    userId: input.userId,
    username: input.username,
  });

  return {
    changeDue: retailMoney(payments.reduce((sum, payment) => sum.plus(payment.changeDue), new Decimal(0))),
  };
}

export interface RetailCheckoutInput extends RetailSaleInput {
  paymentLines?: RetailTenderInput[];
  username?: string | null;
}

async function loadRetailCheckoutReplayDetailsTx(
  tx: RetailTransaction,
  input: { companyId: number; saleId: number; requestFingerprint: string }
): Promise<{ shiftId: number; changeDue: string }> {
  const [sale] = await tx
    .select({
      requestFingerprint: retailPosSales.requestFingerprint,
      checkoutVersion: retailPosSales.checkoutVersion,
      shiftId: retailPosSales.shiftId,
    })
    .from(retailPosSales)
    .where(and(eq(retailPosSales.companyId, input.companyId), eq(retailPosSales.id, input.saleId)))
    .limit(1);
  if (!sale || sale.checkoutVersion !== 1 || sale.requestFingerprint !== input.requestFingerprint || !sale.shiftId) {
    throw new Error("RETAIL_IDEMPOTENCY_CONFLICT: checkout key does not identify a completed Wave 1 checkout");
  }
  const payments = await tx
    .select({ changeDue: retailPosPayments.changeDue })
    .from(retailPosPayments)
    .where(
      and(
        eq(retailPosPayments.companyId, input.companyId),
        eq(retailPosPayments.saleId, input.saleId),
        eq(retailPosPayments.operationType, "sale")
      )
    );
  const changeDue = retailMoney(payments.reduce((sum, payment) => sum.plus(payment.changeDue ?? 0), new Decimal(0)));
  return { shiftId: sale.shiftId, changeDue };
}

/**
 * Finalizes a Retail checkout as one transaction result: exact-variant stock,
 * sale amount snapshots, tender rows, cashier shift and accounting voucher.
 */
export async function createRetailCheckoutInTx(
  tx: RetailTransaction,
  input: RetailCheckoutInput
): Promise<{ saleId: number; replayed: boolean; shiftId: number; changeDue: string }> {
  const fingerprint =
    input.requestFingerprint ??
    retailCheckoutFingerprint({
      locationId: input.locationId,
      items: [...input.items].sort((a, b) => a.variantId - b.variantId),
      discountAmount: retailMoney(input.discountAmount ?? 0),
      taxAmount: retailMoney(input.taxAmount ?? 0),
      paymentLines: input.paymentLines?.map((payment) => ({
        method: payment.method,
        amount: retailMoney(payment.amount),
        amountTendered: payment.method === "cash" ? retailMoney(payment.amountTendered ?? payment.amount) : null,
        reference: payment.reference?.trim() || null,
      })) ?? [{ method: "cash", amount: "auto-full-cash-tender" }],
    });
  const [alreadyCheckedOut] = await tx
    .select({ id: retailPosSales.id })
    .from(retailPosSales)
    .where(and(eq(retailPosSales.companyId, input.companyId), eq(retailPosSales.idempotencyKey, input.idempotencyKey)))
    .limit(1);
  if (alreadyCheckedOut) {
    const replayDetails = await loadRetailCheckoutReplayDetailsTx(tx, {
      companyId: input.companyId,
      saleId: alreadyCheckedOut.id,
      requestFingerprint: fingerprint,
    });
    return { saleId: alreadyCheckedOut.id, replayed: true, ...replayDetails };
  }
  const shift = await requireOpenRetailShiftTx(tx, {
    companyId: input.companyId,
    locationId: input.locationId,
    cashierId: input.userId,
  });
  const created = await createRetailSaleInTx(tx, {
    ...input,
    shiftId: shift.id,
    checkoutVersion: 1,
    requestFingerprint: fingerprint,
  });
  if (created.replayed) {
    const replayDetails = await loadRetailCheckoutReplayDetailsTx(tx, {
      companyId: input.companyId,
      saleId: created.saleId,
      requestFingerprint: fingerprint,
    });
    return { saleId: created.saleId, replayed: true, ...replayDetails };
  }
  if (!created.amounts) throw new Error("Retail checkout total was not finalized");

  const tenderInput = input.paymentLines?.length
    ? input.paymentLines
    : [{ method: "cash" as const, amount: created.amounts.totalAmount, amountTendered: created.amounts.totalAmount }];
  const settled = await finalizeRetailSalePaymentsInTx(tx, {
    companyId: input.companyId,
    saleId: created.saleId,
    locationId: input.locationId,
    shiftId: shift.id,
    idempotencyKey: input.idempotencyKey,
    userId: input.userId,
    username: input.username,
    amounts: created.amounts,
    paymentLines: tenderInput,
  });

  return {
    saleId: created.saleId,
    replayed: false,
    shiftId: shift.id,
    changeDue: settled.changeDue,
  };
}

export interface RetailReturnInput {
  companyId: number;
  saleId: number;
  locationId: number;
  idempotencyKey: string;
  notes?: string | null;
  items: Array<{ saleItemId: number; quantity: number }>;
  userId: string;
  username?: string | null;
  refundMethod?: import("@shared/schema").RetailPaymentMethod;
  metadata?: Record<string, unknown>;
}

export interface RetailReturnResult {
  returnId: number;
  replayed: boolean;
  refundAmount: string;
  subtotalAmount: string;
  discountAmount: string;
  taxAmount: string;
  cogsAmount: string;
  shiftId: number | null;
}

/**
 * Returns sold units to their original exact variants and appends a financial
 * reversal for the current return event. Legacy sale rows and any historical
 * vouchers remain untouched; only new return/payment/posting records are added.
 */
export async function createRetailReturnInTx(
  tx: RetailTransaction,
  input: RetailReturnInput
): Promise<RetailReturnResult> {
  const { companyId, saleId } = input;
  const [alreadyRecorded] = await tx
    .select({ id: retailPosReturns.id, saleId: retailPosReturns.saleId, totalAmount: retailPosReturns.totalAmount })
    .from(retailPosReturns)
    .where(and(eq(retailPosReturns.companyId, companyId), eq(retailPosReturns.idempotencyKey, input.idempotencyKey)))
    .limit(1);
  if (alreadyRecorded) {
    if (alreadyRecorded.saleId !== saleId) {
      throw new Error("RETAIL_IDEMPOTENCY_CONFLICT: return key is already bound to another Retail sale");
    }
    const [sale] = await tx
      .select({ shiftId: retailPosSales.shiftId })
      .from(retailPosSales)
      .where(and(eq(retailPosSales.id, saleId), eq(retailPosSales.companyId, companyId)))
      .limit(1);
    return {
      returnId: alreadyRecorded.id,
      replayed: true,
      refundAmount: retailMoney(alreadyRecorded.totalAmount),
      subtotalAmount: "0.00",
      discountAmount: "0.00",
      taxAmount: "0.00",
      cogsAmount: "0.00",
      shiftId: sale?.shiftId ?? null,
    };
  }

  const shift = await requireOpenRetailShiftTx(tx, {
    companyId,
    locationId: input.locationId,
    cashierId: input.userId,
  });
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
      .select({ id: retailPosReturns.id, saleId: retailPosReturns.saleId, totalAmount: retailPosReturns.totalAmount })
      .from(retailPosReturns)
      .where(and(eq(retailPosReturns.companyId, companyId), eq(retailPosReturns.idempotencyKey, input.idempotencyKey)))
      .limit(1);
    if (!existing) throw new Error("Return retry could not be resolved");
    if (existing.saleId !== saleId) {
      throw new Error("RETAIL_IDEMPOTENCY_CONFLICT: return key is already bound to another Retail sale");
    }
    return {
      returnId: existing.id,
      replayed: true,
      refundAmount: retailMoney(existing.totalAmount),
      subtotalAmount: "0.00",
      discountAmount: "0.00",
      taxAmount: "0.00",
      cogsAmount: "0.00",
      shiftId: shift.id,
    };
  }

  await tx.execute(sql`select id from retail_pos_sales where id = ${saleId} and company_id = ${companyId} for update`);
  const [sale] = await tx
    .select({
      id: retailPosSales.id,
      locationId: retailPosSales.locationId,
      status: retailPosSales.status,
      checkoutVersion: retailPosSales.checkoutVersion,
    })
    .from(retailPosSales)
    .where(and(eq(retailPosSales.id, saleId), eq(retailPosSales.companyId, companyId)))
    .limit(1);
  if (!sale) throw new Error("Retail sale not found");
  if (sale.locationId !== input.locationId) throw new Error("Return location must match the original sale location");
  if (sale.status !== "completed") throw new Error("Canceled sales cannot receive additional returns");

  const aggregate = new Map<number, number>();
  for (const item of input.items) aggregate.set(item.saleItemId, (aggregate.get(item.saleItemId) ?? 0) + item.quantity);
  const saleItemIds = [...aggregate.keys()].sort((a, b) => a - b);
  const saleItemRows = await tx
    .select({
      id: retailPosSaleItems.id,
      variantId: retailPosSaleItems.variantId,
      quantity: retailPosSaleItems.quantity,
      returnedQuantity: retailPosSaleItems.returnedQuantity,
      unitPrice: retailPosSaleItems.unitPrice,
      unitCost: retailPosSaleItems.unitCost,
      grossAmount: retailPosSaleItems.grossAmount,
      discountAmount: retailPosSaleItems.discountAmount,
      taxAmount: retailPosSaleItems.taxAmount,
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
  const grossValues: string[] = [];
  const discountValues: string[] = [];
  const taxValues: string[] = [];
  const totalValues: string[] = [];
  const cogsValues: string[] = [];

  for (const [saleItemId, quantity] of [...aggregate.entries()].sort(([a], [b]) => a - b)) {
    const saleItem = saleItemsById.get(saleItemId);
    if (!saleItem) throw new Error(`Sale item ${saleItemId} not found`);
    const sold = toNumber(saleItem.quantity);
    const alreadyReturned = toNumber(saleItem.returnedQuantity);
    const nextReturnedQuantity = validateRetailReturnQuantity(sold, alreadyReturned, quantity);
    const grossAmount = toNumber(saleItem.grossAmount) || toNumber(saleItem.unitPrice) * sold;
    const amounts = calculateRetailReturnAmounts({
      soldQuantity: saleItem.quantity,
      returnedBefore: saleItem.returnedQuantity,
      returnQuantity: quantity,
      grossAmount,
      discountAmount: saleItem.discountAmount,
      taxAmount: saleItem.taxAmount,
      unitCost: saleItem.unitCost,
    });

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
        grossAmount: amounts.grossAmount,
        discountAmount: amounts.discountAmount,
        taxAmount: amounts.taxAmount,
        totalAmount: amounts.totalAmount,
        unitCost: saleItem.unitCost,
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
    grossValues.push(amounts.grossAmount);
    discountValues.push(amounts.discountAmount);
    taxValues.push(amounts.taxAmount);
    totalValues.push(amounts.totalAmount);
    cogsValues.push(amounts.cogsAmount);
  }

  const sumMoney = (values: string[]) =>
    values
      .reduce((sum, value) => sum.plus(value), new Decimal(0))
      .toDecimalPlaces(2)
      .toFixed(2);
  const subtotalAmount = sumMoney(grossValues);
  const discountAmount = sumMoney(discountValues);
  const taxAmount = sumMoney(taxValues);
  const refundAmount = sumMoney(totalValues);
  const cogsAmount = sumMoney(cogsValues);
  await tx.update(retailPosReturns).set({ totalAmount: refundAmount }).where(eq(retailPosReturns.id, createdReturn.id));

  const existingPayments = await tx
    .select({
      method: retailPosPayments.method,
      operationType: retailPosPayments.operationType,
      amount: retailPosPayments.amount,
      reference: retailPosPayments.reference,
    })
    .from(retailPosPayments)
    .where(and(eq(retailPosPayments.companyId, companyId), eq(retailPosPayments.saleId, saleId)));
  const availableByMethod = new Map<string, Decimal>();
  const referenceByMethod = new Map<string, string | null>();
  for (const payment of existingPayments) {
    const current = availableByMethod.get(payment.method) ?? new Decimal(0);
    const amount = new Decimal(payment.amount ?? 0);
    availableByMethod.set(
      payment.method,
      payment.operationType === "sale" ? current.plus(amount) : current.minus(amount.abs())
    );
    if (payment.operationType === "sale" && payment.reference) referenceByMethod.set(payment.method, payment.reference);
  }
  const originalRails = [...availableByMethod.entries()]
    .map(([method, availableAmount]) => ({
      method: method as import("@shared/schema").RetailPaymentMethod,
      availableAmount: Decimal.max(availableAmount, 0).toFixed(2),
      reference: referenceByMethod.get(method) ?? null,
    }))
    .filter((rail) => new Decimal(rail.availableAmount).gt(0));
  // Legacy sales have no persisted tender rails. A current return still gets a
  // new auditable refund/posting; default it to cash unless the cashier chooses
  // another method. Existing historical vouchers are never edited.
  const refundMethod = input.refundMethod ?? (sale.checkoutVersion === 1 ? undefined : "cash");
  const refundLines = allocateRetailRefund(refundAmount, originalRails, refundMethod);
  const paymentRows = refundLines.map((line, lineNumber) => ({
    companyId,
    saleId,
    returnId: createdReturn.id,
    shiftId: shift.id,
    locationId: sale.locationId,
    operationType: "refund",
    method: line.method,
    amount: line.amount,
    amountTendered: null,
    changeDue: "0.00",
    reference: line.reference,
    cashierId: input.userId,
    idempotencyKey: `retail-return-${createdReturn.id}`,
    lineNumber,
  }));
  if (paymentRows.length) await tx.insert(retailPosPayments).values(paymentRows);

  const hasFinancialActivity = [subtotalAmount, discountAmount, taxAmount, refundAmount, cogsAmount].some((value) =>
    new Decimal(value).gt(0)
  );
  if (hasFinancialActivity) {
    await postRetailAccountingEventTx(tx, {
      companyId,
      saleId,
      locationId: sale.locationId,
      referenceKey: `return:${saleId}:${createdReturn.id}`,
      postingType: "return",
      amounts: {
        subtotalAmount,
        discountAmount,
        taxAmount,
        totalAmount: refundAmount,
        cogsAmount,
      },
      payments: refundLines.map((line) => ({ method: line.method, amount: line.amount })),
      userId: input.userId,
      username: input.username,
    });
  }

  return {
    returnId: createdReturn.id,
    replayed: false,
    refundAmount,
    subtotalAmount,
    discountAmount,
    taxAmount,
    cogsAmount,
    shiftId: shift.id,
  };
}
