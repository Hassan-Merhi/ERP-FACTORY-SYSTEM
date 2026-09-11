import Decimal from "decimal.js";
import { sql, type SQL } from "drizzle-orm";
import { logger } from "./lib/logger";
import { firstRow, resultRows } from "./lib/queryResult";

/**
 * The only surface these helpers need from their connection. Typing it
 * structurally rather than as the concrete Drizzle database keeps both real
 * callers working — `db` and a transaction `tx` alike — without naming a
 * generic that would drag the whole schema in. `select`/`insert`/`update`/
 * `delete` were dropped because this module only ever calls `execute`.
 */
type TxOrDb = {
  execute: (query: SQL) => Promise<unknown>;
};

/** Row shape for the `inventory` lock/read in the costing path. */
type InventoryRow = {
  id: number;
  quantity: string | number | null;
  average_rate: string | number | null;
  total_value: string | number | null;
};

/** Row shape for the `inventory_negative_layers` FIFO settlement read. */
type NegativeLayerRow = {
  id: number;
  qty: string | number | null;
  provisional_rate: string | number | null;
};

export interface AdjustInventoryResult {
  previousQuantity: number;
  newQuantity: number;
  previousTotalValue: number;
  newTotalValue: number;
  averageRate: number;
  created: boolean;
}

// ─────────────────────────────────────────────────────────────
// Precision
// ─────────────────────────────────────────────────────────────
//
// This module used to do its arithmetic in JavaScript floats while the rest of
// the accounting core used decimal.js. That produced wrong last digits at
// rounding boundaries: a rate of 1.005 is really 1.00499999999999989 in binary,
// so `(1.005).toFixed(2)` returned "1.00" and the stored average rate was a half
// cent light. Decimal rounds it to "1.01".
//
// Only the arithmetic changed. The public signature still takes and returns
// numbers, so none of the ~100 call sites move.

/** Scale of each column these values are written to. */
const QTY_DP = 3;
const RATE_DP = 2;
const VALUE_DP = 2;
const LAYER_RATE_DP = 4;

/**
 * Half of the quantity column's last place. A residue smaller than this cannot
 * survive being written at 3dp, so the engine treats it as zero rather than
 * carrying a layer that rounds away to nothing. This was already the rule; it is
 * now exact rather than approximate.
 */
const QTY_EPSILON = new Decimal("0.0005");

/** Cost variance worth a log line, in currency units. */
const VARIANCE_LOG_THRESHOLD = new Decimal("0.01");

const ZERO = new Decimal(0);

/**
 * decimal.js parses a number through its shortest round-trip decimal form, so
 * `toDecimal(0.1)` is exactly 0.1 rather than the binary value 0.1 denotes.
 * That is what we want: callers are expressing decimal intent.
 */
function toDecimal(value: number | string | null | undefined): Decimal {
  if (value === null || value === undefined || value === "") return ZERO;
  const parsed = new Decimal(value);
  return parsed.isNaN() ? ZERO : parsed;
}

// ─────────────────────────────────────────────────────────────
// Private helpers
// ─────────────────────────────────────────────────────────────

async function createNegativeLayer(
  tx: TxOrDb,
  companyId: number,
  locationId: number,
  stockItemId: number,
  qty: Decimal,
  provisionalRate: Decimal,
  sourceVoucherType?: string,
  sourceVoucherId?: number
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO inventory_negative_layers
      (company_id, location_id, stock_item_id, qty, provisional_rate, source_voucher_type, source_voucher_id)
    VALUES
      (${companyId}, ${locationId}, ${stockItemId}, ${qty.toFixed(QTY_DP)},
       ${provisionalRate.toFixed(LAYER_RATE_DP)}, ${sourceVoucherType ?? null}, ${sourceVoucherId ?? null})
  `);
}

/**
 * Return only the newly-created shortage between two inventory quantities.
 *
 * Examples:
 *  10 -> -5  creates 5
 *  -5 -> -8  creates 3 (not 8)
 *  -8 -> -3  creates 0
 *
 * Negative layers represent incremental outbound shortage. Recording the full
 * resulting negative quantity more than once would overstate the FIFO layers
 * and make later receipts settle stock that was never actually issued.
 */
function incrementalShortage(previousQty: Decimal, newQty: Decimal): Decimal {
  const previousShortage = Decimal.max(previousQty.negated(), ZERO);
  const newShortage = Decimal.max(newQty.negated(), ZERO);
  return Decimal.max(newShortage.minus(previousShortage), ZERO);
}

/**
 * Settle oldest negative layers FIFO using the actual incoming rate.
 * Returns { settled: qty consumed from layers, remaining: qty left for positive inventory }.
 */
async function settleNegativeLayers(
  tx: TxOrDb,
  locationId: number,
  stockItemId: number,
  incomingQty: Decimal,
  incomingRate: Decimal
): Promise<{ settled: Decimal; remaining: Decimal }> {
  const result = await tx.execute(sql`
    SELECT id, qty, provisional_rate
    FROM inventory_negative_layers
    WHERE location_id = ${locationId} AND stock_item_id = ${stockItemId}
    ORDER BY id ASC
    FOR UPDATE
  `);
  const rows = resultRows<NegativeLayerRow>(result);

  let remaining = incomingQty;
  let settled = ZERO;

  for (const layer of rows) {
    if (remaining.lte(QTY_EPSILON)) break;
    const layerQty = toDecimal(layer.qty);
    const consume = Decimal.min(layerQty, remaining);
    settled = settled.plus(consume);
    remaining = remaining.minus(consume);

    const variance = incomingRate.minus(toDecimal(layer.provisional_rate)).times(consume);
    if (variance.abs().gt(VARIANCE_LOG_THRESHOLD)) {
      logger.info(
        `[settleNegativeLayers] Cost variance: loc=${locationId} item=${stockItemId} ` +
          `qty=${consume.toFixed(QTY_DP)} provisional=${layer.provisional_rate} actual=${incomingRate.toString()} variance=${variance.toFixed(VALUE_DP)}`
      );
    }

    const layerRemainder = layerQty.minus(consume);
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

  return { settled, remaining: Decimal.max(remaining, ZERO) };
}

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────

/**
 * Core inventory costing function — Tally-like negative-stock model.
 *
 * Rules:
 *  - inventory.totalValue  always ≥ 0  (only positive on-hand stock is valued)
 *  - inventory.averageRate preserved even when qty ≤ 0  (cost memory)
 *  - outgoing beyond zero  → negative layer created with provisional rate
 *  - incoming while short → settles oldest layers FIFO, then adds to positive stock
 *  - stale layers are never consumed when the live balance is already nonnegative
 *  - averageRate is recalculated only from positive on-hand qty
 */
export async function adjustInventory(
  tx: TxOrDb,
  locationId: number,
  stockItemId: number,
  deltaQty: number,
  companyId: number,
  incomingRate?: number,
  sourceVoucherType?: string,
  sourceVoucherId?: number
): Promise<AdjustInventoryResult> {
  const lockResult = await tx.execute(sql`
    SELECT id, quantity, average_rate, total_value
    FROM inventory
    WHERE location_id = ${locationId} AND stock_item_id = ${stockItemId}
    FOR UPDATE
  `);
  const existing = firstRow<InventoryRow>(lockResult);
  const delta = toDecimal(deltaQty);

  if (existing) {
    const prevQty = toDecimal(existing.quantity);
    const prevRate = toDecimal(existing.average_rate);
    const prevTotalValue = toDecimal(existing.total_value);
    const newQty = prevQty.plus(delta);

    let newTotalValue: Decimal;
    let newRate: Decimal;

    if (delta.gt(ZERO)) {
      // ── INCOMING: settle layers only when the live balance is actually short ──
      const effectiveRate = incomingRate === undefined ? prevRate : toDecimal(incomingRate);
      const remaining = prevQty.isNegative()
        ? (await settleNegativeLayers(tx, locationId, stockItemId, delta, effectiveRate)).remaining
        : delta;

      const addValue = remaining.times(effectiveRate);
      newTotalValue = Decimal.max(prevTotalValue.plus(addValue), ZERO);

      if (newQty.gt(ZERO)) {
        newRate = newTotalValue.dividedBy(newQty);
      } else {
        // All incoming absorbed by negative layers; net qty still ≤ 0
        newTotalValue = ZERO;
        newRate = effectiveRate; // preserve for cost memory
      }
    } else if (delta.lt(ZERO)) {
      // ── OUTGOING ─────────────────────────────────────────────────────────────
      const effectiveRate = Decimal.max(prevRate, ZERO);

      if (newQty.gt(ZERO)) {
        // Normal deduction from positive stock
        const deductionValue = delta.abs().times(effectiveRate);
        newTotalValue = Decimal.max(prevTotalValue.minus(deductionValue), ZERO);
        newRate = newTotalValue.dividedBy(newQty);
      } else if (newQty.isZero()) {
        newTotalValue = ZERO;
        newRate = effectiveRate; // keep for cost memory
      } else {
        // ── Goes or remains short: create only the incremental shortage ─────────
        const shortageQty = incrementalShortage(prevQty, newQty);
        const provisionalRate = effectiveRate.gt(ZERO) ? effectiveRate : prevRate;

        newTotalValue = ZERO;
        newRate = provisionalRate.gt(ZERO) ? provisionalRate : ZERO; // cost memory

        if (shortageQty.gt(QTY_EPSILON)) {
          await createNegativeLayer(
            tx,
            companyId,
            locationId,
            stockItemId,
            shortageQty,
            provisionalRate,
            sourceVoucherType,
            sourceVoucherId
          );
        }
      }
    } else {
      // deltaQty === 0: no-op
      newTotalValue = prevTotalValue;
      newRate = prevRate;
    }

    // Safety clamps
    if (newRate.lt(ZERO)) newRate = ZERO;
    if (newQty.gt(ZERO) && newTotalValue.lt(ZERO)) {
      newTotalValue = ZERO;
      newRate = ZERO;
    }
    if (newQty.lte(ZERO)) newTotalValue = ZERO;

    await tx.execute(sql`
      UPDATE inventory
      SET quantity     = ${newQty.toFixed(QTY_DP)},
          average_rate = ${newRate.toFixed(RATE_DP)},
          total_value  = ${newTotalValue.toFixed(VALUE_DP)},
          last_updated = NOW()
      WHERE id = ${existing.id}
    `);

    return {
      previousQuantity: prevQty.toNumber(),
      newQuantity: newQty.toNumber(),
      previousTotalValue: prevTotalValue.toNumber(),
      newTotalValue: newTotalValue.toNumber(),
      averageRate: newRate.toNumber(),
      created: false,
    };
  } else {
    // ── No existing row: INSERT ───────────────────────────────────────────────
    const rate = Decimal.max(incomingRate === undefined ? ZERO : toDecimal(incomingRate), ZERO);
    const qty = delta;
    let totalValue = ZERO;
    let safeRate = rate;

    if (delta.gt(ZERO)) {
      const { remaining } = await settleNegativeLayers(tx, locationId, stockItemId, delta, rate);
      totalValue = remaining.times(rate);
      safeRate = qty.gt(ZERO) && totalValue.gt(ZERO) ? totalValue.dividedBy(qty) : rate;
    } else if (delta.lt(ZERO)) {
      // Negative stock from the very first touch
      totalValue = ZERO;
      safeRate = ZERO;
      await createNegativeLayer(
        tx,
        companyId,
        locationId,
        stockItemId,
        delta.abs(),
        rate,
        sourceVoucherType,
        sourceVoucherId
      );
    }

    // The DO UPDATE branch is reached only when a concurrent transaction
    // inserted this row between the SELECT above and this statement. It is fed
    // the same rounded values as the VALUES clause — previously it interpolated
    // the raw floats, so the two branches could disagree in the last place.
    const qtyText = qty.toFixed(QTY_DP);
    const totalValueText = totalValue.toFixed(VALUE_DP);

    await tx.execute(sql`
      INSERT INTO inventory (company_id, location_id, stock_item_id, quantity, average_rate, total_value, last_updated)
      VALUES (${companyId}, ${locationId}, ${stockItemId}, ${qtyText}, ${safeRate.toFixed(RATE_DP)}, ${totalValueText}, NOW())
      ON CONFLICT (location_id, stock_item_id) DO UPDATE
      SET quantity     = inventory.quantity + ${qtyText},
          total_value  = CASE
            WHEN inventory.quantity + ${qtyText} > 0
            THEN GREATEST(inventory.total_value + ${totalValueText}, 0)
            ELSE 0
          END,
          average_rate = CASE
            WHEN inventory.quantity + ${qtyText} > 0
            THEN GREATEST(inventory.total_value + ${totalValueText}, 0) / (inventory.quantity + ${qtyText})
            ELSE EXCLUDED.average_rate
          END,
          last_updated = NOW()
    `);

    return {
      previousQuantity: 0,
      newQuantity: qty.toNumber(),
      previousTotalValue: 0,
      newTotalValue: totalValue.toNumber(),
      averageRate: safeRate.toNumber(),
      created: true,
    };
  }
}

/**
 * Reverse an exact qty + value previously written to inventory.
 * Used for voucher reversals — does not recalculate moving average.
 *
 * Design:
 *  - Subtracts qtyToReverse and valueToReverse exactly.
 *  - averageRate is preserved when qty ≤ 0 (cost memory, never lost).
 *  - If reversal pushes qty below zero, a negative layer is created for only
 *    the incremental shortage so repeated reversals remain symmetric.
 */
export async function reverseInventoryByExactValue(
  tx: TxOrDb,
  locationId: number,
  stockItemId: number,
  qtyToReverse: number,
  valueToReverse: number,
  companyId?: number,
  sourceVoucherType?: string,
  sourceVoucherId?: number
): Promise<void> {
  const lockResult = await tx.execute(sql`
    SELECT id, quantity, average_rate, total_value
    FROM inventory
    WHERE location_id = ${locationId} AND stock_item_id = ${stockItemId}
    FOR UPDATE
  `);
  const existing = firstRow<InventoryRow>(lockResult);
  if (!existing) return;

  const currentQty = toDecimal(existing.quantity);
  const currentValue = toDecimal(existing.total_value);
  const currentRate = toDecimal(existing.average_rate);

  const reverseQty = toDecimal(qtyToReverse);
  const reverseValue = toDecimal(valueToReverse);

  const newQty = currentQty.minus(reverseQty);
  let newValue = currentValue.minus(reverseValue);

  let newRate: Decimal;

  if (newQty.gt(ZERO)) {
    newValue = Decimal.max(newValue, ZERO);
    newRate = newValue.dividedBy(newQty);
  } else {
    if (!newValue.isZero()) {
      logger.warn(
        `[reverseInventoryByExactValue] Normalising: loc=${locationId} item=${stockItemId} ` +
          `newValue=${newValue.toString()} → 0 (newQty=${newQty.toString()})`
      );
    }
    newValue = ZERO;
    newRate = currentRate; // preserve last positive rate for cost memory

    const shortageQty = incrementalShortage(currentQty, newQty);
    if (shortageQty.gt(QTY_EPSILON) && companyId) {
      const provisionalRate = currentRate.gt(ZERO)
        ? currentRate
        : reverseQty.gt(ZERO)
          ? reverseValue.dividedBy(reverseQty).abs()
          : ZERO;
      await createNegativeLayer(
        tx,
        companyId,
        locationId,
        stockItemId,
        shortageQty,
        provisionalRate,
        sourceVoucherType,
        sourceVoucherId
      );
    }
  }

  if (newRate.lt(ZERO)) newRate = ZERO;

  await tx.execute(sql`
    UPDATE inventory
    SET quantity     = ${newQty.toFixed(QTY_DP)},
        average_rate = ${newRate.toFixed(RATE_DP)},
        total_value  = ${newValue.toFixed(VALUE_DP)},
        last_updated = NOW()
    WHERE id = ${existing.id}
  `);
}
