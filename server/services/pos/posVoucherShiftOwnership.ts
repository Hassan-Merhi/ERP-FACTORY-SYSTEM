import { and, eq, inArray } from "drizzle-orm";
import { posShifts } from "@shared/schema";
import { db } from "../../db";

/** Display ownership only. Permission checks still happen on individual reads/writes. */
export async function withPosVoucherShiftUserIds<T extends { shiftId?: number | null }>(
  vouchers: T[],
  companyId: number
): Promise<Array<T & { userId: string | null }>> {
  const shiftIds = [...new Set(vouchers.map((voucher) => voucher.shiftId).filter((id): id is number => !!id))];
  const owners = new Map<number, string>();
  for (let index = 0; index < shiftIds.length; index += 250) {
    const rows = await db
      .select({ shiftId: posShifts.id, userId: posShifts.userId })
      .from(posShifts)
      .where(and(eq(posShifts.companyId, companyId), inArray(posShifts.id, shiftIds.slice(index, index + 250))));
    rows.forEach((row) => owners.set(row.shiftId, row.userId));
  }
  return vouchers.map((voucher) => ({ ...voucher, userId: owners.get(voucher.shiftId ?? 0) ?? null }));
}
