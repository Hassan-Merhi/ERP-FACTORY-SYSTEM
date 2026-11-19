// Extracted from ./rentalAccrualConfigRoutes.ts to keep that module under the source-size cap.
import type { RentalModule } from "./shared";
import { db } from "../../db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { voucherEntries, vouchers } from "@shared/schema";
import { createHash } from "node:crypto";

/** A stable key for a set of ledger rows (the posting identity of a repair batch). */
export function ledgerRowsKey(ids: number[]): string {
  return createHash("sha256")
    .update([...ids].sort((a, b) => a - b).join(","))
    .digest("hex")
    .slice(0, 24);
}

/** Narrations of these per-row corrections already on a live voucher of the company. */
export async function correctedLedgerRowNarrations(companyId: number, narrations: string[]): Promise<Set<string>> {
  if (narrations.length === 0) return new Set();
  const rows = await db
    .selectDistinct({ narration: voucherEntries.narration })
    .from(voucherEntries)
    .innerJoin(vouchers, eq(vouchers.id, voucherEntries.voucherId))
    .where(
      and(eq(vouchers.companyId, companyId), isNull(vouchers.deletedAt), inArray(voucherEntries.narration, narrations))
    );
  return new Set(rows.map((row) => row.narration ?? ""));
}

export function registerRentalAccrualConfigRoutesStep1(module: RentalModule) {
  const tag = `[${module}/rental]`;
  return { tag };
}
