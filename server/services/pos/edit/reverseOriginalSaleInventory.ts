/**
 * server/services/pos/edit/reverseOriginalSaleInventory.ts
 *
 * Reversal of the original sale's inventory movements and removal of the old
 * sale rows before an edited sale is rebuilt.
 */
import Decimal from "decimal.js";
import type { DbTransaction } from "../../../db";
import { salesItems, voucherEntries } from "@shared/schema";
import { eq, sql } from "drizzle-orm";
import { firstRow, resultRows } from "../../../lib/queryResult";
import { inventoryQuantity, inventoryUnitCost, toInventoryDecimal } from "../../../lib/inventoryMath";
import { createDatabaseStockMovementAdapter } from "../../inventory/databaseStockMovementAdapter";
import { postStockMovementTx } from "../../inventory/stockMovementIntegrityService";

const canonicalStockMovementAdapter = createDatabaseStockMovementAdapter();
const ZERO = new Decimal(0);
const QTY_DP = 3;
const RATE_DP = 2;
const VALUE_DP = 2;
const QTY_EPSILON = new Decimal("0.0005");

type InventoryRow = {
  id: number;
  quantity: string | number | null;
  average_rate: string | number | null;
  total_value: string | number | null;
};

type NegativeLayerRow = {
  id: number;
  qty: string | number | null;
};

function decimal(value: string | number | null | undefined): Decimal {
  if (value === null || value === undefined || value === "") return ZERO;
  const parsed = new Decimal(value);
  return parsed.isFinite() ? parsed : ZERO;
}

/**
 * Undo only shortage layers that belong to the POS voucher being edited.
 * An edit is a reversal of a historical issue, not a new receipt, so it must
 * never settle an unrelated shortage merely because that layer is older.
 */
async function releaseVoucherNegativeLayers(
  tx: DbTransaction,
  companyId: number,
  locationId: number,
  stockItemId: number,
  voucherId: number,
  quantityToRestore: Decimal
): Promise<void> {
  const result = await tx.execute(sql`
    SELECT id, qty
    FROM inventory_negative_layers
    WHERE company_id = ${companyId}
      AND location_id = ${locationId}
      AND stock_item_id = ${stockItemId}
      AND source_voucher_type = 'pos-sale'
      AND source_voucher_id = ${voucherId}
    ORDER BY id ASC
    FOR UPDATE
  `);

  let remaining = quantityToRestore;

  for (const layer of resultRows<NegativeLayerRow>(result)) {
    if (remaining.lte(QTY_EPSILON)) break;

    const layerQty = decimal(layer.qty);
    const consume = Decimal.min(layerQty, remaining);
    const layerRemainder = layerQty.minus(consume);
    remaining = remaining.minus(consume);

    if (layerRemainder.lt(QTY_EPSILON)) {
      await tx.execute(sql`DELETE FROM inventory_negative_layers WHERE id = ${layer.id}`);
    } else {
      await tx.execute(sql`
        UPDATE inventory_negative_layers
        SET qty = ${layerRemainder.toFixed(QTY_DP)}, updated_at = NOW()
        WHERE id = ${layer.id}
      `);
    }
  }
}

/**
 * Restore inventory for an old POS sale line while preserving the live cost
 * basis and leaving unrelated shortage layers untouched.
 *
 * This deliberately does not use adjustInventory(): that helper's positive
 * branch is a real receipt and therefore settles all negative layers FIFO.
 */
async function restorePosSaleInventoryForEdit(
  tx: DbTransaction,
  params: {
    companyId: number;
    locationId: number;
    stockItemId: number;
    quantity: number;
    voucherId: number;
  }
): Promise<void> {
  const { companyId, locationId, stockItemId, quantity, voucherId } = params;
  const restoreQty = decimal(quantity);
  if (restoreQty.lte(ZERO)) return;

  const lockResult = await tx.execute(sql`
    SELECT id, quantity, average_rate, total_value
    FROM inventory
    WHERE company_id = ${companyId}
      AND location_id = ${locationId}
      AND stock_item_id = ${stockItemId}
    FOR UPDATE
  `);
  const existing = firstRow<InventoryRow>(lockResult);
  if (!existing) {
    throw Object.assign(new Error(), { code: "POS_SALE_REVERSAL_INVENTORY_MISSING" });
  }

  const currentQty = decimal(existing.quantity);
  const currentRate = Decimal.max(decimal(existing.average_rate), ZERO);
  const currentValue = Decimal.max(decimal(existing.total_value), ZERO);
  const newQty = currentQty.plus(restoreQty);

  await releaseVoucherNegativeLayers(tx, companyId, locationId, stockItemId, voucherId, restoreQty);

  let newValue = ZERO;
  let newRate = currentRate;

  if (newQty.gt(ZERO)) {
    if (currentQty.gt(ZERO)) {
      // Add back at the current stored cost. Re-issuing the same quantity then
      // subtracts the same amount, so an unchanged edit is valuation-neutral.
      newValue = currentValue.plus(restoreQty.times(currentRate));
    } else {
      // Negative/zero stock carries no asset value. If the reversal crosses
      // positive, value only the newly positive quantity at cost-memory rate.
      newValue = newQty.times(currentRate);
    }
    newRate = newValue.dividedBy(newQty);
  }

  await tx.execute(sql`
    UPDATE inventory
    SET quantity = ${newQty.toFixed(QTY_DP)},
        average_rate = ${Decimal.max(newRate, ZERO).toFixed(RATE_DP)},
        total_value = ${Decimal.max(newValue, ZERO).toFixed(VALUE_DP)},
        last_updated = NOW()
    WHERE id = ${existing.id}
  `);
}

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
