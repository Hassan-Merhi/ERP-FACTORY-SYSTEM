import Decimal from "decimal.js";
import { and, eq } from "drizzle-orm";
import { retailCashMovements, retailCashierShifts, retailPosPayments } from "@shared/schema";
import type { DbTransaction } from "../../db";
import { retailMoney } from "./retailFinancialMath";
import { lockRetailShiftTx, requireOpenRetailShiftTx } from "./retailShiftService";

function amount(value: string | number | null | undefined, label: string): Decimal {
  const parsed = new Decimal(value ?? 0);
  if (!parsed.isFinite()) throw new Error(`${label} must be a finite amount`);
  return parsed;
}

export async function openRetailCashierShiftInTx(
  tx: DbTransaction,
  input: {
    companyId: number;
    locationId: number;
    cashierId: string;
    openingCash: string | number;
    idempotencyKey: string;
  }
): Promise<{ shiftId: number; replayed: boolean }> {
  const openingCash = amount(input.openingCash, "Opening cash").toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  if (openingCash.lt(0)) throw new Error("Opening cash cannot be negative");
  const openingCashText = openingCash.toFixed(2);
  const [existingByKey] = await tx
    .select()
    .from(retailCashierShifts)
    .where(
      and(
        eq(retailCashierShifts.companyId, input.companyId),
        eq(retailCashierShifts.openIdempotencyKey, input.idempotencyKey)
      )
    )
    .limit(1);
  if (existingByKey) {
    if (
      existingByKey.locationId !== input.locationId ||
      existingByKey.cashierId !== input.cashierId ||
      !amount(existingByKey.openingCash, "Opening cash").eq(openingCash)
    ) {
      throw new Error("RETAIL_IDEMPOTENCY_CONFLICT: shift key is already bound to different opening details");
    }
    return { shiftId: existingByKey.id, replayed: true };
  }

  const [created] = await tx
    .insert(retailCashierShifts)
    .values({
      companyId: input.companyId,
      locationId: input.locationId,
      cashierId: input.cashierId,
      openingCash: openingCashText,
      openIdempotencyKey: input.idempotencyKey,
    })
    .onConflictDoNothing()
    .returning({ id: retailCashierShifts.id });
  if (created) return { shiftId: created.id, replayed: false };

  const [openShift] = await tx
    .select({
      id: retailCashierShifts.id,
      openIdempotencyKey: retailCashierShifts.openIdempotencyKey,
      openingCash: retailCashierShifts.openingCash,
    })
    .from(retailCashierShifts)
    .where(
      and(
        eq(retailCashierShifts.companyId, input.companyId),
        eq(retailCashierShifts.locationId, input.locationId),
        eq(retailCashierShifts.cashierId, input.cashierId),
        eq(retailCashierShifts.status, "open")
      )
    )
    .limit(1);
  if (
    openShift?.openIdempotencyKey === input.idempotencyKey &&
    amount(openShift.openingCash, "Opening cash").eq(openingCash)
  ) {
    return { shiftId: openShift.id, replayed: true };
  }
  if (openShift) throw new Error("This cashier already has an open shift at the selected Retail location");
  throw new Error("Retail shift retry could not be resolved");
}

export async function recordRetailCashMovementInTx(
  tx: DbTransaction,
  input: {
    companyId: number;
    locationId: number;
    cashierId: string;
    shiftId: number;
    direction: "cash_in" | "cash_out";
    amount: string | number;
    reason: string;
    idempotencyKey: string;
  }
): Promise<{ movementId: number; replayed: boolean }> {
  const movementAmount = amount(input.amount, "Cash movement amount").toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const reason = input.reason.trim();
  if (movementAmount.lte(0)) throw new Error("Cash movement amount must be greater than zero");
  if (!reason) throw new Error("A reason is required for manual Cash In / Cash Out");

  const [existing] = await tx
    .select()
    .from(retailCashMovements)
    .where(
      and(
        eq(retailCashMovements.companyId, input.companyId),
        eq(retailCashMovements.idempotencyKey, input.idempotencyKey)
      )
    )
    .limit(1);
  if (existing) {
    if (
      existing.shiftId !== input.shiftId ||
      existing.locationId !== input.locationId ||
      existing.direction !== input.direction ||
      !amount(existing.amount, "Cash movement amount").eq(movementAmount) ||
      existing.reason !== reason ||
      existing.createdBy !== input.cashierId
    ) {
      throw new Error("RETAIL_IDEMPOTENCY_CONFLICT: cash movement key is already bound to different details");
    }
    return { movementId: existing.id, replayed: true };
  }

  const shift = await requireOpenRetailShiftTx(tx, {
    companyId: input.companyId,
    locationId: input.locationId,
    cashierId: input.cashierId,
  });
  if (shift.id !== input.shiftId) throw new Error("Cash movement shift does not match the cashier's open shift");
  const [created] = await tx
    .insert(retailCashMovements)
    .values({
      companyId: input.companyId,
      shiftId: input.shiftId,
      locationId: input.locationId,
      direction: input.direction,
      amount: movementAmount.toFixed(2),
      reason,
      idempotencyKey: input.idempotencyKey,
      createdBy: input.cashierId,
    })
    .onConflictDoNothing({ target: [retailCashMovements.companyId, retailCashMovements.idempotencyKey] })
    .returning({ id: retailCashMovements.id });
  if (created) return { movementId: created.id, replayed: false };

  const [retry] = await tx
    .select({
      id: retailCashMovements.id,
      shiftId: retailCashMovements.shiftId,
      locationId: retailCashMovements.locationId,
      direction: retailCashMovements.direction,
      amount: retailCashMovements.amount,
      reason: retailCashMovements.reason,
      createdBy: retailCashMovements.createdBy,
    })
    .from(retailCashMovements)
    .where(
      and(
        eq(retailCashMovements.companyId, input.companyId),
        eq(retailCashMovements.idempotencyKey, input.idempotencyKey)
      )
    )
    .limit(1);
  if (
    !retry ||
    retry.shiftId !== input.shiftId ||
    retry.locationId !== input.locationId ||
    retry.direction !== input.direction ||
    !amount(retry.amount, "Cash movement amount").eq(movementAmount) ||
    retry.reason !== reason ||
    retry.createdBy !== input.cashierId
  ) {
    throw new Error("RETAIL_IDEMPOTENCY_CONFLICT: cash movement retry could not be resolved");
  }
  return { movementId: retry.id, replayed: true };
}

export async function closeRetailCashierShiftInTx(
  tx: DbTransaction,
  input: {
    companyId: number;
    shiftId: number;
    closingUserId: string;
    actualCountedCash: string | number;
    closeNotes?: string | null;
    mayCloseAnotherCashier?: boolean;
  }
): Promise<{
  shiftId: number;
  replayed: boolean;
  expectedClosingCash: string;
  actualCountedCash: string;
  variance: string;
}> {
  const actual = amount(input.actualCountedCash, "Counted closing cash").toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  if (actual.lt(0)) throw new Error("Counted closing cash cannot be negative");
  const shift = await lockRetailShiftTx(tx, input.companyId, input.shiftId);
  if (!shift) throw new Error("Retail cashier shift not found");
  if (!input.mayCloseAnotherCashier && shift.cashierId !== input.closingUserId) {
    throw new Error("Cashiers can only close their own Retail shift");
  }
  if (shift.status === "closed") {
    if (shift.actualCountedCash == null || !amount(shift.actualCountedCash, "Counted closing cash").eq(actual)) {
      throw new Error("RETAIL_IDEMPOTENCY_CONFLICT: shift is already closed with a different counted amount");
    }
    return {
      shiftId: shift.id,
      replayed: true,
      expectedClosingCash: retailMoney(shift.expectedClosingCash),
      actualCountedCash: retailMoney(shift.actualCountedCash),
      variance: retailMoney(shift.variance),
    };
  }

  // Read within this transaction after the shift row lock so no checkout or
  // cash movement can slip between the totals snapshot and the closed status.
  const [paymentRows, cashRows] = await Promise.all([
    tx
      .select({
        method: retailPosPayments.method,
        operationType: retailPosPayments.operationType,
        amount: retailPosPayments.amount,
      })
      .from(retailPosPayments)
      .where(and(eq(retailPosPayments.companyId, input.companyId), eq(retailPosPayments.shiftId, input.shiftId))),
    tx
      .select({ direction: retailCashMovements.direction, amount: retailCashMovements.amount })
      .from(retailCashMovements)
      .where(and(eq(retailCashMovements.companyId, input.companyId), eq(retailCashMovements.shiftId, input.shiftId))),
  ]);
  let cashSales = new Decimal(0);
  let cashRefunds = new Decimal(0);
  for (const payment of paymentRows) {
    if (payment.method !== "cash") continue;
    if (payment.operationType === "sale") cashSales = cashSales.plus(payment.amount);
    else cashRefunds = cashRefunds.plus(new Decimal(payment.amount).abs());
  }
  let cashIn = new Decimal(0);
  let cashOut = new Decimal(0);
  for (const movement of cashRows) {
    if (movement.direction === "cash_in") cashIn = cashIn.plus(movement.amount);
    else cashOut = cashOut.plus(movement.amount);
  }
  const expected = amount(shift.openingCash, "Opening cash")
    .plus(cashSales)
    .minus(cashRefunds)
    .plus(cashIn)
    .minus(cashOut)
    .toDecimalPlaces(2);
  const variance = actual.minus(expected).toDecimalPlaces(2);
  const closedAt = new Date();
  await tx
    .update(retailCashierShifts)
    .set({
      status: "closed",
      cashSalesTotal: cashSales.toFixed(2),
      refundTotal: cashRefunds.toFixed(2),
      cashInTotal: cashIn.toFixed(2),
      cashOutTotal: cashOut.toFixed(2),
      expectedClosingCash: expected.toFixed(2),
      actualCountedCash: actual.toFixed(2),
      variance: variance.toFixed(2),
      closedBy: input.closingUserId,
      closedAt,
      closeNotes: input.closeNotes?.trim() || null,
      updatedAt: closedAt,
    })
    .where(and(eq(retailCashierShifts.id, input.shiftId), eq(retailCashierShifts.companyId, input.companyId)));

  return {
    shiftId: input.shiftId,
    replayed: false,
    expectedClosingCash: expected.toFixed(2),
    actualCountedCash: actual.toFixed(2),
    variance: variance.toFixed(2),
  };
}
