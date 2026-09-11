/**
 * server/services/pos/edit/reverseOriginalSaleInventory.ts
 *
 * Reversal of the original sale's inventory movements and removal of the old
 * sale rows before an edited sale is rebuilt.
 */
import Decimal from "decimal.js";
import type { DbTransaction } from "../../../db";
import type { SalesItemRow, VoucherRow } from "./posEditSaleTypes";
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

export interface PosSaleInventoryRestoreResult {
  previousQuantity: number;
  newQuantity: number;
  previousTotalValue: number;
  newTotalValue: number;
  averageRate: number;
}

function decimal(value: string | number | null | undefined): Decimal {
  if (value === null || value === undefined || value === "") return ZERO;
  const parsed = new Decimal(value);
  return parsed.isFinite() ? parsed : ZERO;
}

/**
 * Release only the shortage quantity that the reversal actually resolves.
 *
 * If live stock is already positive, any open layer is historical/anomalous and
 * a reversal must leave it alone. If live stock is negative, restoring a sale
 * reduces the aggregate shortage. Layers owned by that voucher are removed
 * first; any remainder is removed FIFO from other layers so layer quantity stays
 * equal to the remaining negative balance.
 */
async function releaseResolvedNegativeLayers(
  tx: DbTransaction,
  companyId: number,
  locationId: number,
  stockItemId: number,
  voucherId: number,
  quantityToRelease: Decimal
): Promise<void> {
  if (quantityToRelease.lte(QTY_EPSILON)) return;

  const result = await tx.execute(sql`
    SELECT id, qty
    FROM inventory_negative_layers
    WHERE company_id = ${companyId}
      AND location_id = ${locationId}
      AND stock_item_id = ${stockItemId}
    ORDER BY
      CASE
        WHEN source_voucher_type = 'pos-sale' AND source_voucher_id = ${voucherId} THEN 0
        ELSE 1
      END,
      id ASC
    FOR UPDATE
  `);

  let remaining = quantityToRelease;

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
 * Restore inventory previously issued by a POS sale without treating the
 * reversal as a new receipt. Used by edit, single-delete and bulk-delete flows.
 *
 * The regular adjustInventory positive branch settles all negative layers FIFO;
 * that is correct for genuinely new stock but corrupts valuation when used to
 * undo a historical sale while unrelated shortage layers exist.
 */
export async function restorePosSaleInventoryForReversal(
  tx: DbTransaction,
  params: {
    companyId: number;
    locationId: number;
    stockItemId: number;
    quantity: number;
    voucherId: number;
  }
): Promise<PosSaleInventoryRestoreResult> {
  const { companyId, locationId, stockItemId, quantity, voucherId } = params;
  const restoreQty = decimal(quantity);
  if (restoreQty.lte(ZERO)) {
    throw Object.assign(new Error(), { code: "POS_SALE_REVERSAL_QUANTITY_INVALID" });
  }

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
  const shortageResolved = currentQty.isNegative() ? Decimal.min(currentQty.abs(), restoreQty) : ZERO;

  await releaseResolvedNegativeLayers(tx, companyId, locationId, stockItemId, voucherId, shortageResolved);

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

  return {
    previousQuantity: currentQty.toNumber(),
    newQuantity: newQty.toNumber(),
    previousTotalValue: currentValue.toNumber(),
    newTotalValue: newValue.toNumber(),
    averageRate: Decimal.max(newRate, ZERO).toNumber(),
  };
}

/**
 * Restore the old POS issue without treating the reversal as new stock.
 *
 * The normal incoming-stock path settles every negative layer FIFO. That is
 * correct for a receipt, but wrong for an edit: an edit must not consume a
 * shortage merely because an unrelated historical layer happens to be older.
 */
export async function reverseOriginalSaleInventory(
  tx: DbTransaction,
  existingVoucher: VoucherRow,
  oldSalesItems: SalesItemRow[],
  canonicalRevision?: number
): Promise<void> {
  for (const oldItem of oldSalesItems) {
    const oldQuantity = toInventoryDecimal(oldItem.quantity);
    await restorePosSaleInventoryForReversal(tx, {
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
