import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../../db";
import { firstRow, resultRows } from "../../lib/queryResult";

const ZERO = new Decimal(0);
const QTY_DP = 3;
/** inventory.average_rate is numeric(20,7) since wave 11 (display / cost memory). */
const RATE_DP = 7;
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
  /** Signed change of the stored total_value (2dp): the value restored. */
  valueDelta: string;
}

/**
 * Release only the shortage quantity that an incoming historical reversal
 * actually resolves. A historical reversal is not a new receipt, so no cost
 * variance is booked; this only keeps the shortage ledger quantity aligned with
 * the live negative inventory balance.
 */
async function releaseResolvedNegativeLayers(
  tx: DbTransaction,
  companyId: number,
  locationId: number,
  stockItemId: number,
  quantityToRelease: Decimal
): Promise<void> {
  if (quantityToRelease.lte(QTY_EPSILON)) return;

  const result = await tx.execute(sql`
    SELECT id, qty
    FROM inventory_negative_layers
    WHERE company_id = ${companyId}
      AND location_id = ${locationId}
      AND stock_item_id = ${stockItemId}
    ORDER BY id ASC
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
 * Restore a historical inventory issue using its exact stored quantity and value.
 *
 * This is intentionally different from a normal receipt. It does not recost the
 * historical issue or rebuild value from today's average: the row takes back
 * exactly the quantity and value the issue relieved, because the reversal of the
 * issue's ledger posting (its COGS or stock journal) takes back exactly that
 * value, and the sub-ledger and the INVENTORY account must move together
 * (wave 11). That holds whatever the row's state:
 *   - stock on hand: value + restored value;
 *   - short (negative value under the negative-stock policy): the negative value
 *     moves up by the restored value, and the matching shortage quantity is
 *     released from the negative layer ledger. A historical reversal is not a new
 *     receipt, so no settlement variance is booked: the restored units carry the
 *     value they left with, and the row's average becomes value / quantity.
 * The previous implementation valued a reversal that crossed back above zero at
 * its rate for the newly positive quantity only, dropping the rest of the value
 * from the sub-ledger while the ledger reversal restored all of it.
 */
export async function restoreInventoryByExactValue(
  tx: DbTransaction,
  companyId: number,
  locationId: number,
  stockItemId: number,
  quantityToRestore: number,
  valueToRestore: number | string
): Promise<ExactInventoryRestoreResult> {
  const restoreQty = Decimal.max(decimal(quantityToRestore), ZERO);
  // Kept clamp: a restore puts back what an issue relieved, which is never negative.
  const restoreValue = Decimal.max(decimal(valueToRestore), ZERO).toDecimalPlaces(VALUE_DP);
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
        valueDelta: "0.00",
      };
    }

    await tx.execute(sql`
      INSERT INTO inventory
        (company_id, location_id, stock_item_id, quantity, average_rate, total_value, last_updated)
      VALUES
        (${companyId}, ${locationId}, ${stockItemId}, ${restoreQty.toFixed(QTY_DP)},
         ${restoreRate.toFixed(RATE_DP)}, ${restoreValue.toFixed(VALUE_DP)}, NOW())
    `);

    return {
      previousQuantity: 0,
      newQuantity: restoreQty.toNumber(),
      previousTotalValue: 0,
      newTotalValue: restoreValue.toNumber(),
      averageRate: restoreRate.toNumber(),
      created: true,
      valueDelta: restoreValue.toFixed(VALUE_DP),
    };
  }

  const currentQty = decimal(existing.quantity);
  const currentRate = Decimal.max(decimal(existing.average_rate), ZERO);
  const currentValue = decimal(existing.total_value).toDecimalPlaces(VALUE_DP);
  const newQty = currentQty.plus(restoreQty);
  const shortageResolved = currentQty.isNegative() ? Decimal.min(currentQty.abs(), restoreQty) : ZERO;

  await releaseResolvedNegativeLayers(tx, companyId, locationId, stockItemId, shortageResolved);

  const newValue = currentValue.plus(restoreValue);
  let newRate = restoreRate.gt(ZERO) ? restoreRate : currentRate;
  if (newQty.gt(QTY_EPSILON) && newValue.gt(ZERO)) newRate = newValue.dividedBy(newQty);
  else if (newQty.lt(QTY_EPSILON.negated()) && newValue.isNegative()) newRate = newValue.dividedBy(newQty);

  await tx.execute(sql`
    UPDATE inventory
    SET quantity = ${newQty.toFixed(QTY_DP)},
        average_rate = ${Decimal.max(newRate, ZERO).toFixed(RATE_DP)},
        total_value = ${newValue.toFixed(VALUE_DP)},
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
    valueDelta: restoreValue.toFixed(VALUE_DP),
  };
}
