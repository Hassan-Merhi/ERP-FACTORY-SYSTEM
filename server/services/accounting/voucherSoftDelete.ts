import { and, eq, isNull } from "drizzle-orm";
import { vouchers } from "@shared/schema";

import type { DbTransaction } from "../../db";

/**
 * Takes a posted voucher out of the books without destroying it: every
 * balance and report excludes vouchers with deleted_at set, while the voucher
 * and its entries stay available to the audit trail and the deleted-items
 * screen. Use this instead of deleting voucher and entry rows when a user
 * deletes a transaction. Idempotent; the closed-period guard still applies.
 */
export async function softDeleteVoucherTx(tx: DbTransaction, voucherId: number): Promise<void> {
  await tx
    .update(vouchers)
    .set({ deletedAt: new Date() })
    .where(and(eq(vouchers.id, voucherId), isNull(vouchers.deletedAt)));
}
