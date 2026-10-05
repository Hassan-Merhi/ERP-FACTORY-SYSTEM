import Decimal from "decimal.js";
import { and, eq } from "drizzle-orm";
import { retailCashMovements, retailCashierShifts, retailPosPayments, type RetailPaymentMethod } from "@shared/schema";
import { db, type DbTransaction } from "../../db";
import { retailMoney } from "./retailFinancialMath";

const toNumber = (value: unknown) => {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
};

export interface RetailShiftMethodTotal {
  method: RetailPaymentMethod;
  sales: number;
  refunds: number;
  net: number;
}

export interface RetailShiftReport {
  shift: typeof retailCashierShifts.$inferSelect;
  cashSalesTotal: number;
  refundTotal: number;
  cashInTotal: number;
  cashOutTotal: number;
  expectedClosingCash: number;
  actualCountedCash: number | null;
  variance: number | null;
  paymentMethodTotals: RetailShiftMethodTotal[];
}

export async function requireOpenRetailShiftTx(
  tx: DbTransaction,
  input: { companyId: number; locationId: number; cashierId: string }
) {
  const [shift] = await tx
    .select()
    .from(retailCashierShifts)
    .where(
      and(
        eq(retailCashierShifts.companyId, input.companyId),
        eq(retailCashierShifts.locationId, input.locationId),
        eq(retailCashierShifts.cashierId, input.cashierId),
        eq(retailCashierShifts.status, "open")
      )
    )
    .limit(1)
    .for("update");
  if (!shift) throw new Error("Open a cashier shift before completing Retail payments");
  return shift;
}

export async function getRetailShiftReport(companyId: number, shiftId: number): Promise<RetailShiftReport | null> {
  const [shift] = await db
    .select()
    .from(retailCashierShifts)
    .where(and(eq(retailCashierShifts.companyId, companyId), eq(retailCashierShifts.id, shiftId)))
    .limit(1);
  if (!shift) return null;

  const [payments, cashMovements] = await Promise.all([
    db
      .select({
        method: retailPosPayments.method,
        operationType: retailPosPayments.operationType,
        amount: retailPosPayments.amount,
      })
      .from(retailPosPayments)
      .where(and(eq(retailPosPayments.companyId, companyId), eq(retailPosPayments.shiftId, shiftId))),
    db
      .select({ direction: retailCashMovements.direction, amount: retailCashMovements.amount })
      .from(retailCashMovements)
      .where(and(eq(retailCashMovements.companyId, companyId), eq(retailCashMovements.shiftId, shiftId))),
  ]);

  const methods = new Map<RetailPaymentMethod, { sales: Decimal; refunds: Decimal }>();
  let cashSalesAmount = new Decimal(0);
  let cashRefundAmount = new Decimal(0);
  for (const payment of payments) {
    const method = payment.method as RetailPaymentMethod;
    const totals = methods.get(method) ?? { sales: new Decimal(0), refunds: new Decimal(0) };
    const amount = new Decimal(payment.amount ?? 0);
    if (payment.operationType === "sale") {
      totals.sales = totals.sales.plus(amount);
      if (method === "cash") cashSalesAmount = cashSalesAmount.plus(amount);
    } else {
      totals.refunds = totals.refunds.plus(amount.abs());
      if (method === "cash") cashRefundAmount = cashRefundAmount.plus(amount.abs());
    }
    methods.set(method, totals);
  }

  let cashInAmount = new Decimal(0);
  let cashOutAmount = new Decimal(0);
  for (const movement of cashMovements) {
    const amount = new Decimal(movement.amount ?? 0);
    if (movement.direction === "cash_in") cashInAmount = cashInAmount.plus(amount);
    else cashOutAmount = cashOutAmount.plus(amount);
  }
  const expectedAmount = new Decimal(shift.openingCash ?? 0)
    .plus(cashSalesAmount)
    .minus(cashRefundAmount)
    .plus(cashInAmount)
    .minus(cashOutAmount);
  const cashSalesTotal = Number(retailMoney(cashSalesAmount));
  const refundTotal = Number(retailMoney(cashRefundAmount));
  const cashInTotal = Number(retailMoney(cashInAmount));
  const cashOutTotal = Number(retailMoney(cashOutAmount));
  const expectedClosingCash = Number(retailMoney(expectedAmount));
  const paymentMethodTotals = [...methods.entries()].map(([method, values]) => ({
    method,
    sales: Number(retailMoney(values.sales)),
    refunds: Number(retailMoney(values.refunds)),
    net: Number(retailMoney(values.sales.minus(values.refunds))),
  }));

  return {
    shift,
    cashSalesTotal,
    refundTotal,
    cashInTotal,
    cashOutTotal,
    expectedClosingCash,
    actualCountedCash: shift.actualCountedCash == null ? null : toNumber(shift.actualCountedCash),
    variance: shift.variance == null ? null : toNumber(shift.variance),
    paymentMethodTotals,
  };
}

export async function lockRetailShiftTx(tx: DbTransaction, companyId: number, shiftId: number) {
  const [shift] = await tx
    .select()
    .from(retailCashierShifts)
    .where(and(eq(retailCashierShifts.id, shiftId), eq(retailCashierShifts.companyId, companyId)))
    .limit(1)
    .for("update");
  return shift ?? null;
}
