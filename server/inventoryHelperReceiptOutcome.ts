// Extracted from ./inventoryHelper.ts to keep that module under the source-size cap.
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import { logger } from "./lib/logger";
import { resultRows } from "./lib/queryResult";
import {
  D,
  QTY_DP,
  QTY_EPSILON,
  RATE_DP,
  VALUE_DP,
  VARIANCE_LOG_THRESHOLD,
  ZERO,
  incrementalShortage,
  money,
  toDecimal,
  type Dec,
  type NegativeLayerRow,
  type TxOrDb,
} from "./inventoryHelperCreateNegativeLayer";

/**
 * Settle oldest negative layers FIFO for the shortage quantity a receipt
 * covers. Quantity bookkeeping only: the value the settlement takes back comes
 * from the inventory row (see adjustInventory), and the per-layer cost variance
 * is logged for audit.
 */
export async function settleNegativeLayers(
  tx: TxOrDb,
  locationId: number,
  stockItemId: number,
  settleQty: Dec,
  incomingRate: Dec
): Promise<void> {
  if (settleQty.lte(QTY_EPSILON)) return;
  const result = await tx.execute(sql`
    SELECT id, qty, provisional_rate
    FROM inventory_negative_layers
    WHERE location_id = ${locationId} AND stock_item_id = ${stockItemId}
    ORDER BY id ASC
    FOR UPDATE
  `);
  const rows = resultRows<NegativeLayerRow>(result);

  let remaining = settleQty;
  for (const layer of rows) {
    if (remaining.lte(QTY_EPSILON)) break;
    const layerQty = toDecimal(layer.qty);
    const consume = new D(Decimal.min(layerQty, remaining));
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
}

/** The row's state after a movement, computed before anything is written. */
export interface MovementOutcome {
  newQty: Dec;
  newValue: Dec;
  newRate: Dec;
  receiptValue: Dec;
  settledQty: Dec;
  /** Incremental shortage this movement created, and the rate it was booked at. */
  shortage: { qty: Dec; rate: Dec } | null;
}

/**
 * The weighted average of a row holding stock: the stored rate when it
 * reproduces the stored value to the cent, else the exact total_value / qty.
 */
function averageAnchor(prevQty: Dec, prevValue: Dec, prevRate: Dec): Dec {
  const storedRate = new D(prevRate.toFixed(RATE_DP));
  if (storedRate.gt(ZERO) && money(prevQty.times(storedRate)).eq(prevValue)) return storedRate;
  return prevValue.dividedBy(prevQty);
}

/**
 * The cost memory of a row: the current average while it holds stock, the
 * stored rate once it is empty or short. Never negative.
 */
export function costMemory(prevQty: Dec, prevValue: Dec, prevRate: Dec): Dec {
  if (prevQty.gt(ZERO) && prevValue.gt(ZERO)) return averageAnchor(prevQty, prevValue, prevRate);
  return prevRate.gt(ZERO) ? prevRate : ZERO;
}

/** An issue of `issueQty` (> 0) from a row (policy in the module comment). */
export function issueOutcome(prevQty: Dec, prevValue: Dec, prevRate: Dec, issueQty: Dec): MovementOutcome {
  const memory = costMemory(prevQty, prevValue, prevRate);
  const newQty = prevQty.minus(issueQty);
  const none = { receiptValue: ZERO, settledQty: ZERO };

  if (newQty.gt(QTY_EPSILON)) {
    if (prevQty.gt(ZERO)) {
      // Pro rata to the stored value: the remaining units keep the row's
      // average, so the value left is round(newQty × average) and the issue
      // relieves the rest. The average is the stored 7dp rate when it
      // reproduces the stored value to the cent (so it stays the same issue
      // after issue and the value never drifts from quantity × cost), else
      // total_value / quantity (a legacy 2dp rate, or a quantity so large the
      // 7th decimal shows). Weighted average: an issue never changes it.
      const anchor = averageAnchor(prevQty, prevValue, prevRate);
      const newValue = money(newQty.times(anchor));
      return { ...none, newQty, newValue, newRate: anchor, shortage: null };
    }
    // Unreachable: prevQty <= 0 minus a positive issue cannot be positive.
    return { ...none, newQty, newValue: prevValue, newRate: memory, shortage: null };
  }

  // The row is emptied (residual flush) or goes / stays short.
  const shortageQty = incrementalShortage(prevQty, newQty);
  // The value a short row already holds stays; an emptied or empty row's
  // residual is relieved with the issue (the residual flush).
  const priorShortValue = prevQty.lt(QTY_EPSILON.negated()) ? prevValue : ZERO;
  const shortValue = money(shortageQty.times(memory));
  return {
    ...none,
    newQty: newQty.abs().lt(QTY_EPSILON) ? ZERO : newQty,
    newValue: newQty.abs().lt(QTY_EPSILON) ? ZERO : priorShortValue.minus(shortValue),
    newRate: memory,
    shortage: shortageQty.gt(QTY_EPSILON) ? { qty: shortageQty, rate: memory } : null,
  };
}

/** A receipt of `receiptQty` (> 0) worth `receiptValue` into a row. */
export function receiptOutcome(
  prevQty: Dec,
  prevValue: Dec,
  prevRate: Dec,
  receiptQty: Dec,
  receiptValue: Dec
): MovementOutcome {
  const newQty = prevQty.plus(receiptQty);
  const receiptRate = receiptValue.dividedBy(receiptQty);
  const memoryAfter = (value: Dec): Dec =>
    newQty.gt(QTY_EPSILON) ? value.dividedBy(newQty) : receiptRate.gt(ZERO) ? receiptRate : prevRate;

  if (prevQty.abs().lt(QTY_EPSILON)) {
    // An empty row. A residual it still holds (left by an exact reversal, or a
    // pre-wave-11 writer) is cost of units already gone: it is not capitalised
    // into the new stock but flushed to COGS through the settlement variance,
    // like the residual an emptying issue relieves.
    return {
      newQty,
      newValue: receiptValue,
      newRate: memoryAfter(receiptValue),
      receiptValue,
      settledQty: ZERO,
      shortage: null,
    };
  }
  if (prevQty.gt(ZERO)) {
    const newValue = prevValue.plus(receiptValue);
    return { newQty, newValue, newRate: memoryAfter(newValue), receiptValue, settledQty: ZERO, shortage: null };
  }

  const shortQty = prevQty.negated();
  const settledQty = new D(Decimal.min(shortQty, receiptQty));
  // The settled units take back their share of the shortage's negative value;
  // the whole remainder when the shortage is fully covered (no residual).
  const restored = settledQty.gte(shortQty)
    ? prevValue.negated()
    : money(prevValue.negated().times(settledQty).dividedBy(shortQty));
  // The units beyond the shortage are received at the receipt's own value.
  const settledShareOfReceipt = settledQty.eq(receiptQty)
    ? receiptValue
    : money(receiptValue.times(settledQty).dividedBy(receiptQty));
  const received = receiptValue.minus(settledShareOfReceipt);
  const newValue = prevValue.plus(restored).plus(received);
  return {
    newQty: newQty.abs().lt(QTY_EPSILON) ? ZERO : newQty,
    newValue: newQty.abs().lt(QTY_EPSILON) ? ZERO : newValue,
    newRate: memoryAfter(newValue),
    receiptValue,
    settledQty,
    shortage: null,
  };
}
