import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../../db";
import { firstRow } from "../../lib/queryResult";

const ZERO = new Decimal(0);
const QTY_DP = 3;
const RATE_DP = 2;
const VALUE_DP = 2;

type InventoryRow = {
  id: number;
  quantity: string | number | null;
  average_rate: string | number | null;
  total_value: string | number | null;
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
