import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../../db";
import { firstRow, resultRows } from "../../lib/queryResult";

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

export interface ExactInventoryRestoreResult {
  previousQuantity: number;
  newQuantity: number;
  previousTotalValue: number;
  newTotalValue: number;
  averageRate: number;
  created: boolean;
}

/**
 * Restore a historical inventory issue using its exact stored quantity and value.
 *
 * This is intentionally different from a normal receipt. A receipt may settle
 * FIFO negative-stock layers; reversing an existing document must not consume
 * unrelated shortage layers or rebuild historical value from today's rounded
 * average rate.
 */
export async function restoreInventoryByExactValue(
  tx: DbTransaction,
  companyId: number,
  locationId: number,
  stockItemId: number,
  quantityToRestore: number,
  valueToRestore: number
): Promise<ExactInventoryRestoreResult> {
  const restoreQty = Decimal.max(decimal(quantityToRestore), ZERO);
  const restoreValue = Decimal.max(decimal(valueToRestore), ZERO);
  const restoreRate = restoreQty.gt(ZERO) ? restoreValue.dividedBy(restoreQty) : ZERO;

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
    if (restoreQty.isZero()) {
      return {
        previousQuantity: 0,
        newQuantity: 0,
        previousTotalValue: 0,
        newTotalValue: 0,
        averageRate: 0,
        created: false,
      };
    }

    const initialValue = restoreQty.gt(ZERO) ? restoreValue : ZERO;
    const initialRate = restoreQty.gt(ZERO) ? restoreRate : ZERO;
    await tx.execute(sql`
      INSERT INTO inventory
        (company_id, location_id, stock_item_id, quantity, average_rate, total_value, last_updated)
      VALUES
        (${companyId}, ${locationId}, ${stockItemId}, ${restoreQty.toFixed(QTY_DP)},
         ${initialRate.toFixed(RATE_DP)}, ${initialValue.toFixed(VALUE_DP)}, NOW())
    `);

    return {
      previousQuantity: 0,
      newQuantity: restoreQty.toNumber(),
      previousTotalValue: 0,
      newTotalValue: initialValue.toNumber(),
      averageRate: initialRate.toNumber(),
      created: true,
    };
  }

  const currentQty = decimal(existing.quantity);
  const currentRate = Decimal.max(decimal(existing.average_rate), ZERO);
  const currentValue = Decimal.max(decimal(existing.total_value), ZERO);
  const newQty = currentQty.plus(restoreQty);

  let newValue = ZERO;
  let newRate = restoreRate.gt(ZERO) ? restoreRate : currentRate;

  if (newQty.gt(ZERO)) {
    if (currentQty.gt(ZERO)) {
      newValue = currentValue.plus(restoreValue);
    } else {
      // There is no asset value while stock is zero/negative. If this exact
      // reversal crosses back above zero, value only the newly-positive balance
      // at the historical restoration rate.
      newValue = newQty.times(newRate);
    }
    newRate = newValue.gt(ZERO) ? newValue.dividedBy(newQty) : newRate;
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
    averageRate: newRate.toNumber(),
    created: false,
  };
}

/**
 * Remove only the negative-layer quantity resolved by a historical issue
 * reversal. Layers tied to the same voucher are preferred; legacy rows without
 * source metadata fall back to FIFO so aggregate layer quantity remains aligned
 * with the live negative balance.
 */
async function releaseHistoricalIssueNegativeLayers(
  tx: DbTransaction,
  companyId: number,
  locationId: number,
  stockItemId: number,
  quantityToRelease: Decimal,
  sourceVoucherId?: number
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
        WHEN ${sourceVoucherId ?? null}::int IS NOT NULL
          AND source_voucher_id = ${sourceVoucherId ?? null}
        THEN 0
        ELSE 1
      END,
      id ASC
    FOR UPDATE
  `);

  let remaining = quantityToRelease;
  for (const layer of resultRows<NegativeLayerRow>(result)) {
    if (remaining.lte(QTY_EPSILON)) break;
    const layerQty = Decimal.max(decimal(layer.qty), ZERO);
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
 * Reverse a historical stock issue while preserving its exact stored value and
 * keeping the negative-stock layer ledger in sync.
 *
 * This is the correct inverse of an issue that may have crossed below zero:
 * quantity/value are restored exactly, and only the shortage actually resolved
 * by the reversal is removed from inventory_negative_layers.
 */
export async function restoreHistoricalIssueByExactValue(
  tx: DbTransaction,
  input: {
    companyId: number;
    locationId: number;
    stockItemId: number;
    quantity: number;
    value: number;
    sourceVoucherId?: number;
  }
): Promise<ExactInventoryRestoreResult> {
  const restoreQty = Decimal.max(decimal(input.quantity), ZERO);
  const lockResult = await tx.execute(sql`
    SELECT id, quantity
    FROM inventory
    WHERE company_id = ${input.companyId}
      AND location_id = ${input.locationId}
      AND stock_item_id = ${input.stockItemId}
    FOR UPDATE
  `);
  const existing = firstRow<Pick<InventoryRow, "id" | "quantity">>(lockResult);
  const currentQty = decimal(existing?.quantity);
  const shortageResolved = currentQty.isNegative() ? Decimal.min(currentQty.abs(), restoreQty) : ZERO;

  await releaseHistoricalIssueNegativeLayers(
    tx,
    input.companyId,
    input.locationId,
    input.stockItemId,
    shortageResolved,
    input.sourceVoucherId
  );

  return restoreInventoryByExactValue(
    tx,
    input.companyId,
    input.locationId,
    input.stockItemId,
    restoreQty.toNumber(),
    input.value
  );
}
