import { eq } from "drizzle-orm";
import { db, type DbTransaction } from "../../db";
import * as schema from "@shared/schema";
import { insertInfrastructureVoucherTx } from "../../services/accounting/infrastructureVoucherIdentity";
import type { PostingSourceIdentity } from "../../services/accounting/centralPostingEngine";
import type { StockAdjustmentInputItem, StockAdjustmentType } from "./createStockTransfer";
import { createStockAdjustmentTx } from "./createStockAdjustmentTx";
export {
  DuplicateStockAdjustmentError,
  DuplicateStockTransferError,
  StockTransferPolicyError,
  applyStockTransferInventoryTx,
  assertTransferCompanyScopeTx,
} from "./applyStockTransferInventoryTx";
export { createStockTransfer } from "./createStockTransfer";

export async function createStockAdjustment(
  voucherId: number,
  locationId: number,
  adjustmentType: StockAdjustmentType,
  notes: string,
  items: StockAdjustmentInputItem[],
  _consumptionAccountOverride?: { code: string; name: string },
  voucherHeader?: { currency?: string; voucherDate?: string; description?: string },
  storedAdjustmentType?: string,
  // Phase 21 (B): the caller's audit, written on this transaction so a failed
  // audit rolls the adjustment back.
  afterWriteTx?: (tx: DbTransaction, result: Awaited<ReturnType<typeof createStockAdjustmentTx>>) => Promise<void>
) {
  return await db.transaction(async (tx) => {
    const result = await createStockAdjustmentTx(
      tx,
      voucherId,
      locationId,
      adjustmentType,
      notes,
      items,
      voucherHeader,
      storedAdjustmentType
    );
    if (afterWriteTx) await afterWriteTx(tx, result);
    return result;
  });
}

/**
 * Creates a stock adjustment voucher and its adjustment in one transaction
 * (wave 12): the stock adjustment writers are the only creators of the stock
 * voucher types, so the voucher, its stock document and its one-sided line
 * commit together and the balance guard sees the stock document that exempts it.
 */
export async function createStockAdjustmentWithVoucher(
  voucher: Omit<schema.InsertVoucher, "voucherType"> & { voucherType: StockAdjustmentType },
  postingSource: PostingSourceIdentity,
  locationId: number,
  notes: string,
  items: StockAdjustmentInputItem[],
  voucherHeader?: { currency?: string }
) {
  return await db.transaction((tx) =>
    createStockAdjustmentWithVoucherTx(tx, voucher, postingSource, locationId, notes, items, voucherHeader)
  );
}

/**
 * createStockAdjustmentWithVoucher in the caller's transaction (wave 15): the
 * waste dispatch writes its dispatch rows in the same transaction as the
 * voucher and its adjustment.
 */
export async function createStockAdjustmentWithVoucherTx(
  tx: DbTransaction,
  voucher: Omit<schema.InsertVoucher, "voucherType"> & { voucherType: StockAdjustmentType },
  postingSource: PostingSourceIdentity,
  locationId: number,
  notes: string,
  items: StockAdjustmentInputItem[],
  voucherHeader?: { currency?: string }
) {
  const { voucher: created } = await insertInfrastructureVoucherTx(tx, voucher, postingSource, voucher);
  const result = await createStockAdjustmentTx(
    tx,
    created.id,
    locationId,
    voucher.voucherType,
    notes,
    items,
    voucherHeader
  );
  const [stored] = await tx.select().from(schema.vouchers).where(eq(schema.vouchers.id, created.id));
  return { ...result, voucher: stored ?? result.voucher };
}
