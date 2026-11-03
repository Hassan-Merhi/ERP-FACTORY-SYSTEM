/**
 * Keep a CLOSED ordinary ERP POS shift's saved totals consistent when an
 * already-posted sale is suspended or reactivated. Live open shifts calculate
 * totals at close; this helper does not change a cashier's opening or counted
 * closing cash, nor does it simulate a physical refund.
 *
 * Called inside the same transaction as the sale's optional flag and stock
 * reversal, so the shift values cannot be updated for a failed reversal.
 */
import { and, eq, isNull } from "drizzle-orm";
import { posShifts, vouchers } from "@shared/schema";
import type { DbTransaction } from "../../db";
import { moneyString, sumMoney, toMoney } from "../../lib/money";

export async function recalculateClosedPosShiftForOptionalToggleTx(
  tx: DbTransaction,
  params: { companyId: number; shiftId?: number | null; voucherType: string }
): Promise<void> {
  if (params.voucherType !== "Sales" || !params.shiftId) return;

  const [shift] = await tx.select().from(posShifts).where(and(
    eq(posShifts.id, params.shiftId),
    eq(posShifts.companyId, params.companyId)
  )).for("update");
  if (!shift || shift.status !== "closed") return;

  const sales = await tx.select({ totalAmount: vouchers.totalAmount })
    .from(vouchers).where(and(
      eq(vouchers.companyId, params.companyId),
      eq(vouchers.shiftId, shift.id),
      eq(vouchers.voucherType, "Sales"),
      eq(vouchers.optional, false),
      isNull(vouchers.deletedAt)
    ));

  const total = sumMoney(sales.map((sale) => sale.totalAmount));
  const expected = toMoney(shift.openingCash).plus(total);
  const variance = toMoney(shift.closingCash ?? "0").minus(expected);

  await tx.update(posShifts).set({
    salesCount: sales.length,
    salesTotal: moneyString(total),
    expectedCash: moneyString(expected),
    variance: moneyString(variance),
  }).where(eq(posShifts.id, shift.id));
}
