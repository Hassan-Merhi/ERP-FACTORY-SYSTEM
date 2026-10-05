import Decimal from "decimal.js";
import { and, eq, sql } from "drizzle-orm";
import { retailPosPayments, retailPosSaleItems, retailPosSales, retailStockOperations } from "@shared/schema";
import type { RetailPaymentMethod } from "@shared/schema";
import type { DbTransaction } from "../../db";
import { addMovement, lockInventoryRow, setInventoryQuantity } from "./retailStockLedger";
import { requireOpenRetailShiftTx } from "./retailShiftService";
import { allocateRetailRefund, calculateRetailReturnAmounts, retailMoney } from "./retailFinancialMath";
import { postRetailAccountingEventTx } from "./retailAccountingBridge";

function toNumber(value: string | number | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sumMoney(values: string[]): string {
  return values
    .reduce((sum, value) => sum.plus(value), new Decimal(0))
    .toDecimalPlaces(2)
    .toFixed(2);
}

export async function cancelRetailSaleInTx(
  tx: DbTransaction,
  input: {
    companyId: number;
    saleId: number;
    locationId: number;
    idempotencyKey: string;
    reason?: string | null;
    refundMethod?: RetailPaymentMethod;
    userId: string;
    username?: string | null;
  }
): Promise<{ replayed: boolean; operationId?: number; shiftId?: number }> {
  const [operation] = await tx
    .insert(retailStockOperations)
    .values({
      companyId: input.companyId,
      operationType: "cancellation",
      idempotencyKey: input.idempotencyKey,
      referenceId: String(input.saleId),
      createdBy: input.userId,
      metadata: { reason: input.reason ?? null },
    })
    .onConflictDoNothing({ target: [retailStockOperations.companyId, retailStockOperations.idempotencyKey] })
    .returning({ id: retailStockOperations.id });
  if (!operation) {
    const [previous] = await tx
      .select({ operationType: retailStockOperations.operationType, referenceId: retailStockOperations.referenceId })
      .from(retailStockOperations)
      .where(
        and(
          eq(retailStockOperations.companyId, input.companyId),
          eq(retailStockOperations.idempotencyKey, input.idempotencyKey)
        )
      )
      .limit(1);
    if (!previous || previous.operationType !== "cancellation" || previous.referenceId !== String(input.saleId)) {
      throw new Error("RETAIL_IDEMPOTENCY_CONFLICT: cancellation key is already bound to another operation");
    }
    return { replayed: true };
  }

  const shift = await requireOpenRetailShiftTx(tx, {
    companyId: input.companyId,
    locationId: input.locationId,
    cashierId: input.userId,
  });
  await tx.execute(
    sql`select id from retail_pos_sales where id = ${input.saleId} and company_id = ${input.companyId} for update`
  );
  const [sale] = await tx
    .select({
      id: retailPosSales.id,
      locationId: retailPosSales.locationId,
      status: retailPosSales.status,
      checkoutVersion: retailPosSales.checkoutVersion,
    })
    .from(retailPosSales)
    .where(and(eq(retailPosSales.id, input.saleId), eq(retailPosSales.companyId, input.companyId)))
    .limit(1);
  if (!sale) throw new Error("Retail sale not found");
  if (sale.locationId !== input.locationId)
    throw new Error("Cancellation location must match the original sale location");
  if (sale.status === "canceled") return { replayed: true, operationId: operation.id, shiftId: shift.id };
  if (sale.status !== "completed") throw new Error("Only a completed Retail sale can be canceled");

  const saleItems = await tx
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
    .where(and(eq(retailPosSaleItems.saleId, input.saleId), eq(retailPosSaleItems.companyId, input.companyId)))
    .orderBy(retailPosSaleItems.variantId, retailPosSaleItems.id);

  const gross: string[] = [];
  const discounts: string[] = [];
  const taxes: string[] = [];
  const totals: string[] = [];
  const costs: string[] = [];
  for (const item of saleItems) {
    const quantityToRestore = Math.max(0, toNumber(item.quantity) - toNumber(item.returnedQuantity));
    if (quantityToRestore <= 0) continue;
    const amounts = calculateRetailReturnAmounts({
      soldQuantity: item.quantity,
      returnedBefore: item.returnedQuantity,
      returnQuantity: quantityToRestore,
      grossAmount: toNumber(item.grossAmount) || toNumber(item.unitPrice) * toNumber(item.quantity),
      discountAmount: item.discountAmount,
      taxAmount: item.taxAmount,
      unitCost: item.unitCost,
    });
    const stock = await lockInventoryRow(tx, input.companyId, item.variantId, sale.locationId);
    const after = stock.quantity + quantityToRestore;
    await setInventoryQuantity(tx, input.companyId, item.variantId, sale.locationId, after);
    await addMovement(tx, {
      companyId: input.companyId,
      variantId: item.variantId,
      locationId: sale.locationId,
      movementType: "cancellation",
      quantityDelta: quantityToRestore,
      before: stock.quantity,
      after,
      eventKey: `cancellation:${operation.id}:${item.id}`,
      referenceType: "retail_pos_sale",
      referenceId: input.saleId,
      createdBy: input.userId,
      metadata: { saleItemId: item.id, reason: input.reason ?? null },
    });
    gross.push(amounts.grossAmount);
    discounts.push(amounts.discountAmount);
    taxes.push(amounts.taxAmount);
    totals.push(amounts.totalAmount);
    costs.push(amounts.cogsAmount);
  }

  const subtotalAmount = sumMoney(gross);
  const discountAmount = sumMoney(discounts);
  const taxAmount = sumMoney(taxes);
  const refundAmount = sumMoney(totals);
  const cogsAmount = sumMoney(costs);

  const hasFinancialActivity = [subtotalAmount, discountAmount, taxAmount, refundAmount, cogsAmount].some((value) =>
    new Decimal(value).gt(0)
  );
  if (hasFinancialActivity) {
    const originalPayments = await tx
      .select({
        method: retailPosPayments.method,
        operationType: retailPosPayments.operationType,
        amount: retailPosPayments.amount,
        reference: retailPosPayments.reference,
      })
      .from(retailPosPayments)
      .where(and(eq(retailPosPayments.companyId, input.companyId), eq(retailPosPayments.saleId, input.saleId)));
    const availableByMethod = new Map<string, Decimal>();
    const referenceByMethod = new Map<string, string | null>();
    for (const payment of originalPayments) {
      const current = availableByMethod.get(payment.method) ?? new Decimal(0);
      const amount = new Decimal(payment.amount ?? 0);
      availableByMethod.set(
        payment.method,
        payment.operationType === "sale" ? current.plus(amount) : current.minus(amount.abs())
      );
      if (payment.operationType === "sale" && payment.reference)
        referenceByMethod.set(payment.method, payment.reference);
    }
    const rails = [...availableByMethod.entries()]
      .map(([method, amount]) => ({
        method: method as RetailPaymentMethod,
        availableAmount: Decimal.max(amount, 0).toFixed(2),
        reference: referenceByMethod.get(method) ?? null,
      }))
      .filter((rail) => new Decimal(rail.availableAmount).gt(0));
    // Historical sales have no recorded tender rails. Their current cancellation
    // is recorded as an explicit refund (Cash by default), without rewriting
    // vouchers or payments from the original sale.
    const refundMethod = input.refundMethod ?? (sale.checkoutVersion === 1 ? undefined : "cash");
    const refunds = allocateRetailRefund(refundAmount, rails, refundMethod);
    if (refunds.length) {
      await tx.insert(retailPosPayments).values(
        refunds.map((refund, lineNumber) => ({
          companyId: input.companyId,
          saleId: input.saleId,
          shiftId: shift.id,
          locationId: sale.locationId,
          operationType: "cancellation",
          method: refund.method,
          amount: refund.amount,
          amountTendered: null,
          changeDue: "0.00",
          reference: refund.reference,
          cashierId: input.userId,
          idempotencyKey: `retail-cancel-${operation.id}`,
          lineNumber,
        }))
      );
    }
    await postRetailAccountingEventTx(tx, {
      companyId: input.companyId,
      saleId: input.saleId,
      locationId: sale.locationId,
      referenceKey: `cancellation:${input.saleId}`,
      postingType: "cancellation",
      amounts: { subtotalAmount, discountAmount, taxAmount, totalAmount: refundAmount, cogsAmount },
      payments: refunds.map((refund) => ({ method: refund.method, amount: refund.amount })),
      userId: input.userId,
      username: input.username,
    });
  }

  await tx
    .update(retailPosSales)
    .set({ status: "canceled", canceledAt: new Date(), updatedAt: new Date() })
    .where(and(eq(retailPosSales.id, input.saleId), eq(retailPosSales.companyId, input.companyId)));

  return { replayed: false, operationId: operation.id, shiftId: shift.id };
}

export function normalizeCancellationReason(reason?: string | null): string | null {
  const value = reason?.trim() ?? "";
  return value ? value.slice(0, 2000) : null;
}

export const retailCancellationMoney = retailMoney;
