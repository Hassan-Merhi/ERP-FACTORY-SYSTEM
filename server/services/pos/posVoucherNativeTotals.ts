/**
 * POS read model: use the ORIGINAL posted Kwacha debit, never the USD voucher
 * total multiplied by the user's current exchange rate. No writes or backfill.
 */
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { voucherEntries } from "@shared/schema";
import { db } from "../../db";

export async function withPosZmwNativeTotals<T extends object>(
  vouchers: T[]
): Promise<Array<T & { nativeZmwTotal?: string }>> {
  const ids = vouchers
    .filter((voucher) => {
      const row = voucher as T & { id?: unknown; currency?: unknown; voucherType?: unknown };
      return typeof row.id === "number" && row.currency === "ZMW" && row.voucherType === "Sales";
    })
    .map((voucher) => (voucher as T & { id: number }).id);
  if (!ids.length) return vouchers;

  const totals = new Map<number, string>();
  // Batch to avoid an unbounded SQL IN parameter list on a wide Daybook range.
  for (let i = 0; i < ids.length; i += 200) {
    const rows = await db
      .select({
        voucherId: voucherEntries.voucherId,
        amount: sql<string>`max(${voucherEntries.transactionDebitAmount})`,
      })
      .from(voucherEntries)
      .where(
        and(
          inArray(voucherEntries.voucherId, ids.slice(i, i + 200)),
          eq(voucherEntries.transactionCurrency, "ZMW"),
          gt(voucherEntries.transactionDebitAmount, "0")
        )
      )
      .groupBy(voucherEntries.voucherId);
    for (const row of rows) {
      if (row.amount != null) totals.set(row.voucherId, row.amount);
    }
  }

  return vouchers.map((voucher) => {
    const row = voucher as T & { id?: unknown };
    const nativeZmwTotal = typeof row.id === "number" ? totals.get(row.id) : undefined;
    return nativeZmwTotal == null ? voucher : { ...voucher, nativeZmwTotal };
  });
}
