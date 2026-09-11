import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../../../db";
import { firstRow, resultRows } from "../../../lib/queryResult";

const ZERO = new Decimal(0);
const QTY_DP = 3;
const RATE_DP = 2;
const VALUE_DP = 2;
const LAYER_RATE_EPSILON = new Decimal("0.0005");

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
 *
 * A POS edit is a reversal of a historical issue, not a new receipt. Running
 * it through the normal receipt path would settle the oldest negative layer,
 * including shortages created by unrelated sales. That is the valuation bug
 * that caused live average cost to collapse during otherwise harmless edits.
 */
async function releaseVoucherNegativeLayers(
  tx: DbTransaction,
  companyId: number,
  locationId: number,
  stockItemId: number,
  voucherId: number,
  quantityToRestore: Decimal
): Promise<Decimal> {
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
  let released = ZERO;

  for (const layer of resultRows<NegativeLayerRow>(result)) {
    if (remaining.lte(LAYER_RATE_EPSILON)) break;

    const layerQty = decimal(layer.qty);
    const consume = Decimal.min(layerQty, remaining);
    const layerRemainder = layerQty.minus(consume);

    released = released.plus(consume);
    remaining = remaining.minus(consume);

    if (layerRemainder.lt(LAYER_RATE_EPSILON)) {
      await tx.execute(sql`DELETE FROM inventory_negative_layers WHERE id = ${layer.id}`);
    } else {
      await tx.execute(sql`
        UPDATE inventory_negative_layers
        SET qty = ${layerRemainder.toFixed(QTY_DP)}, updated_at = NOW()
        WHERE id = ${layer.id}
      `);
    }
  }

  return released;
}

/**
 * Restore inventory for an old POS sale line while preserving the live cost
 * basis and leaving unrelated shortage layers untouched.
 *
 * This deliberately does not call adjustInventory(): its incoming-stock branch
 * performs FIFO settlement across every negative layer. A sale edit must only
 * reverse the sale being edited.
 */
export async function restorePosSaleInventoryForEdit(
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
  if (!existing) throw new Error("POS_SALE_REVERSAL_INVENTORY_MISSING");

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
      // subtracts the exact same amount, so a no-op edit is valuation-neutral.
      newValue = currentValue.plus(restoreQty.times(currentRate));
    } else {
      // While stock is zero/negative there is no asset value. If the reversal
      // crosses back above zero, value only the newly-positive balance at the
      // preserved cost-memory rate.
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
