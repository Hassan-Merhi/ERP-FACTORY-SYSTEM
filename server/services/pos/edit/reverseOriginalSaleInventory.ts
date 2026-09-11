/**
 * server/services/pos/edit/reverseOriginalSaleInventory.ts
 *
 * Reversal of the original sale's inventory movements and removal of the old
 * sale rows before an edited sale is rebuilt.
 */
import type { DbTransaction } from "../../../db";
import { salesItems, voucherEntries } from "@shared/schema";
import { eq } from "drizzle-orm";
import { inventoryQuantity, inventoryUnitCost, toInventoryDecimal } from "../../../lib/inventoryMath";
import { createDatabaseStockMovementAdapter } from "../../inventory/databaseStockMovementAdapter";
import { postStockMovementTx } from "../../inventory/stockMovementIntegrityService";
import { restorePosSaleInventoryForEdit } from "./restoreSaleInventory";

const canonicalStockMovementAdapter = createDatabaseStockMovementAdapter();

/**
 * Restore the old POS issue without treating the reversal as new stock.
 *
 * The normal incoming-stock path settles every negative layer FIFO. That is
 * correct for a receipt, but wrong for an edit: an edit must not consume a
 * shortage created by another sale. The POS-specific restoration preserves the
 * live cost basis and only releases shortage layers attributed to this voucher.
 */
export async function reverseOriginalSaleInventory(
  tx: DbTransaction,
  existingVoucher: any,
  oldSalesItems: any[],
  canonicalRevision?: number
): Promise<void> {
  for (const oldItem of oldSalesItems) {
    const oldQuantity = toInventoryDecimal(oldItem.quantity);
    await restorePosSaleInventoryForEdit(tx, {
      companyId: existingVoucher.companyId,
      locationId: existingVoucher.locationId!,
      stockItemId: oldItem.stockItemId,
      quantity: oldQuantity.toNumber(),
      voucherId: existingVoucher.id,
    });

    // Include the sales_item id in the canonical identity. A valid sale can
    // contain more than one row for the same stock item, and each row must post
    // its own reversal instead of being mistaken for an idempotent replay.
    if (canonicalRevision !== undefined && !oldQuantity.isZero()) {
      await postStockMovementTx(
        tx,
        {
          companyId: existingVoucher.companyId,
          stockItemId: oldItem.stockItemId,
          kind: "receipt",
          quantity: inventoryQuantity(oldQuantity),
          unitCost: inventoryUnitCost(toInventoryDecimal(oldItem.costPrice)),
          toLocationId: existingVoucher.locationId,
          occurredAt: new Date().toISOString(),
          source: {
            sourceType: "pos-sale",
            sourceId: String(existingVoucher.id),
            idempotencyKey: `pos-sale:${existingVoucher.id}:rev${canonicalRevision}:reverse:${oldItem.stockItemId}:line:${oldItem.id}`,
          },
          allowNegativeStock: true,
        },
        canonicalStockMovementAdapter
      );
    }
  }
}

export async function clearOldSaleRecords(tx: DbTransaction, voucherId: number): Promise<void> {
  await tx.delete(salesItems).where(eq(salesItems.voucherId, voucherId));
  await tx.delete(voucherEntries).where(eq(voucherEntries.voucherId, voucherId));
}
