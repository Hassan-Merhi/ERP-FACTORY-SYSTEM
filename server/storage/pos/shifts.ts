import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../../db";
import * as schema from "@shared/schema";
import { moneyString, parseMoneyInput, sumMoney, toMoney } from "../../lib/money";
import { postRetailShiftOverShortTx } from "../../services/retail/retailCashJournal";

export async function getCurrentShift(userId: string, locationId: number): Promise<schema.PosShift | undefined> {
  const [shift] = await db
    .select()
    .from(schema.posShifts)
    .where(
      and(
        eq(schema.posShifts.userId, userId),
        eq(schema.posShifts.locationId, locationId),
        eq(schema.posShifts.status, "open")
      )
    )
    .orderBy(desc(schema.posShifts.openedAt))
    .limit(1);
  return shift;
}

export async function getShiftById(id: number): Promise<schema.PosShift | undefined> {
  const [shift] = await db.select().from(schema.posShifts).where(eq(schema.posShifts.id, id));
  return shift;
}

export async function getShiftsByLocation(locationId: number, limit: number = 50): Promise<schema.PosShift[]> {
  return await db
    .select()
    .from(schema.posShifts)
    .where(eq(schema.posShifts.locationId, locationId))
    .orderBy(desc(schema.posShifts.openedAt))
    .limit(limit);
}

export async function openShift(shift: schema.InsertPosShift): Promise<schema.PosShift> {
  const [created] = await db.insert(schema.posShifts).values(shift).returning();
  return created;
}

export async function closeShift(
  id: number,
  closingCash: string,
  notes?: string,
  actor?: { userId: string; username?: string | null }
): Promise<schema.PosShift> {
  // Lock the shift first: retail checkouts and cash movements hold a shared lock on
  // it, so the totals below include every write committed before the shift closes.
  return db.transaction(async (tx) => {
    const [shift] = await tx.select().from(schema.posShifts).where(eq(schema.posShifts.id, id)).for("update");
    if (!shift) throw new Error("Shift not found");
    if (shift.status !== "open") throw new Error("Shift is already closed");

    const [company] = await tx
      .select({ companyType: schema.companies.companyType })
      .from(schema.companies)
      .where(eq(schema.companies.id, shift.companyId))
      .limit(1);

    let salesCount: number;
    // Exact sums, so the stored variance is closing cash minus expected cash to the cent.
    let salesTotal = toMoney(0);
    let expectedCash = toMoney(shift.openingCash);

    if (company?.companyType === "retail") {
      const payments = await tx
        .select({
          saleId: schema.retailPosPayments.saleId,
          paymentType: schema.retailPosPayments.paymentType,
          method: schema.retailPosPayments.method,
          amount: schema.retailPosPayments.amount,
        })
        .from(schema.retailPosPayments)
        .where(and(eq(schema.retailPosPayments.companyId, shift.companyId), eq(schema.retailPosPayments.shiftId, id)));
      const cashMovements = await tx
        .select({
          movementType: schema.retailCashMovements.movementType,
          amount: schema.retailCashMovements.amount,
        })
        .from(schema.retailCashMovements)
        .where(
          and(eq(schema.retailCashMovements.companyId, shift.companyId), eq(schema.retailCashMovements.shiftId, id))
        );

      const saleIds = new Set<number>();
      let cashNet = toMoney(0);
      for (const payment of payments) {
        const amount = toMoney(payment.amount);
        if (payment.paymentType === "payment") {
          saleIds.add(payment.saleId);
          salesTotal = salesTotal.plus(amount);
          if (payment.method === "cash") cashNet = cashNet.plus(amount);
        } else if (payment.paymentType === "refund" && payment.method === "cash") {
          cashNet = cashNet.minus(amount);
        }
      }
      for (const movement of cashMovements) {
        const amount = toMoney(movement.amount);
        cashNet = movement.movementType === "cash_in" ? cashNet.plus(amount) : cashNet.minus(amount);
      }
      salesCount = saleIds.size;
      expectedCash = expectedCash.plus(cashNet);
    } else {
      const salesVouchers = await tx
        .select()
        .from(schema.vouchers)
        .where(
          and(
            eq(schema.vouchers.shiftId, id),
            eq(schema.vouchers.voucherType, "Sales"),
            isNull(schema.vouchers.deletedAt)
          )
        );
      salesCount = salesVouchers.length;
      salesTotal = sumMoney(salesVouchers.map((voucher) => voucher.totalAmount));
      expectedCash = expectedCash.plus(salesTotal);
    }

    const actualClosing = parseMoneyInput(closingCash);
    if (!actualClosing) throw new Error("Invalid amount");
    const variance = actualClosing.minus(expectedCash);

    const [updated] = await tx
      .update(schema.posShifts)
      .set({
        status: "closed",
        closedAt: sql`now()`,
        closingCash,
        expectedCash: moneyString(expectedCash),
        variance: moneyString(variance),
        salesCount,
        salesTotal: moneyString(salesTotal),
        notes: notes || null,
      })
      .where(and(eq(schema.posShifts.id, id), eq(schema.posShifts.status, "open")))
      .returning();
    if (!updated) throw new Error("Shift is already closed");
    // Wave 17 (D): a Retail shift's counted-less-expected cash is journalled to
    // Cash Over/Short in the close's transaction.
    if (company?.companyType === "retail") {
      await postRetailShiftOverShortTx(tx, {
        companyId: shift.companyId,
        shift: { id: shift.id, locationId: shift.locationId, cashAccountId: shift.cashAccountId ?? null },
        variance,
        actor: actor ?? { userId: shift.userId, username: shift.username },
      });
    }
    return updated;
  });
}

export async function updateShiftStats(id: number, salesCount: number, salesTotal: string): Promise<void> {
  await db.update(schema.posShifts).set({ salesCount, salesTotal }).where(eq(schema.posShifts.id, id));
}
