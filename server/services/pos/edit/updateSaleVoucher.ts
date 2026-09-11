/**
 * server/services/pos/edit/updateSaleVoucher.ts
 *
 * PHASE 20 structural split — moved (unchanged) from
 * server/routes/pos/posEditSaleRoutes.ts:
 *   - voucher description/total/location/date update
 *
 * Every message, status code, and query is byte-identical to the original —
 * only the code location changed.
 */
import type { DbTransaction } from "../../../db";
import { vouchers } from "@shared/schema";
import { logger } from "../../../lib/logger";
import { eq } from "drizzle-orm";

/** Updates voucher description, total amount, location, credit state, and optionally date. */
export async function updateVoucherRecord(
  tx: DbTransaction,
  params: {
    voucherId: number;
    description: string | null;
    grandTotal: number;
    locationChanged: boolean;
    targetLocationId: number;
    oldLocationId: number;
    voucherDate?: string;
    isCreditSale: boolean;
  }
): Promise<void> {
  const {
    voucherId,
    description,
    grandTotal,
    locationChanged,
    targetLocationId,
    oldLocationId,
    voucherDate,
    isCreditSale,
  } = params;

  const voucherUpdate: Partial<typeof vouchers.$inferInsert> = {
    description: description || null,
    totalAmount: grandTotal.toString(),
    isCreditSale,
  };
  if (locationChanged) {
    voucherUpdate.locationId = targetLocationId;
    logger.info(`[POS Sales Edit] Updated voucher ${voucherId} location from ${oldLocationId} to ${targetLocationId}`);
  }
  if (voucherDate) {
    voucherUpdate.voucherDate = voucherDate;
  }
  await tx.update(vouchers).set(voucherUpdate).where(eq(vouchers.id, voucherId));
}
