// Extracted from ./apply.ts: retires a post-offload charge voucher.
import type { DbTransaction } from "../../../db";
import { retireVouchersTx } from "../../accounting/voucherRetirement";
import { eq } from "drizzle-orm";
import { vouchers } from "../../../../shared/schema";

/** Retire a charge's voucher in its own company (audited; number and identity released). */
export async function retireChargeVoucherTx(tx: DbTransaction, voucherId: number, reason: string): Promise<void> {
  const [owner] = await tx.select({ companyId: vouchers.companyId }).from(vouchers).where(eq(vouchers.id, voucherId));
  if (!owner) return;
  await retireVouchersTx(tx, { companyId: owner.companyId, voucherIds: [voucherId], reason });
}
