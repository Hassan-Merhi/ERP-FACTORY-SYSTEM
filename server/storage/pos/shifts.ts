import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../../db";
import * as schema from "@shared/schema";

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

export async function closeShift(id: number, closingCash: string, notes?: string): Promise<schema.PosShift> {
  const shift = await getShiftById(id);
  if (!shift) throw new Error("Shift not found");

  const [company] = await db
    .select({ companyType: schema.companies.companyType })
    .from(schema.companies)
    .where(eq(schema.companies.id, shift.companyId))
    .limit(1);

  let salesCount = 0;
  let salesTotal = 0;
  let expectedCash = parseFloat(shift.openingCash || "0");

  if (company?.companyType === "retail") {
    const payments = await db
      .select({
        saleId: schema.retailPosPayments.saleId,
        paymentType: schema.retailPosPayments.paymentType,
        method: schema.retailPosPayments.method,
        amount: schema.retailPosPayments.amount,
      })
      .from(schema.retailPosPayments)
      .where(
        and(
          eq(schema.retailPosPayments.companyId, shift.companyId),
          eq(schema.retailPosPayments.shiftId, id)
        )
      );
    const cashMovements = await db
      .select({
        movementType: schema.retailCashMovements.movementType,
        amount: schema.retailCashMovements.amount,
      })
      .from(schema.retailCashMovements)
      .where(
        and(
          eq(schema.retailCashMovements.companyId, shift.companyId),
          eq(schema.retailCashMovements.shiftId, id)
        )
      );

    const saleIds = new Set<number>();
    let cashNet = 0;
    for (const payment of payments) {
      const amount = parseFloat(payment.amount || "0");
      if (payment.paymentType === "payment") {
        saleIds.add(payment.saleId);
        salesTotal += amount;
        if (payment.method === "cash") cashNet += amount;
      } else if (payment.paymentType === "refund" && payment.method === "cash") {
        cashNet -= amount;
      }
    }
    for (const movement of cashMovements) {
      const amount = parseFloat(movement.amount || "0");
      cashNet += movement.movementType === "cash_in" ? amount : -amount;
    }
    salesCount = saleIds.size;
    expectedCash += cashNet;
  } else {
    const salesVouchers = await db
      .select()
      .from(schema.vouchers)
      .where(
        and(eq(schema.vouchers.shiftId, id), eq(schema.vouchers.voucherType, "Sales"), isNull(schema.vouchers.deletedAt))
      );
    salesCount = salesVouchers.length;
    salesTotal = salesVouchers.reduce((sum, voucher) => sum + parseFloat(voucher.totalAmount || "0"), 0);
    expectedCash += salesTotal;
  }

  const actualClosing = parseFloat(closingCash);
  if (!Number.isFinite(actualClosing)) throw new Error("Closing cash must be a valid amount");
  const variance = actualClosing - expectedCash;

  const [updated] = await db
    .update(schema.posShifts)
    .set({
      status: "closed",
      closedAt: sql`now()`,
      closingCash,
      expectedCash: expectedCash.toFixed(2),
      variance: variance.toFixed(2),
      salesCount,
      salesTotal: salesTotal.toFixed(2),
      notes: notes || null,
    })
    .where(and(eq(schema.posShifts.id, id), eq(schema.posShifts.status, "open")))
    .returning();
  if (!updated) throw new Error("Shift is already closed");
  return updated;
}

export async function updateShiftStats(id: number, salesCount: number, salesTotal: string): Promise<void> {
  await db
    .update(schema.posShifts)
    .set({ salesCount, salesTotal })
    .where(eq(schema.posShifts.id, id));
}
