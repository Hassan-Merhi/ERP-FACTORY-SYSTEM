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
  /**
   * The signed change of the row's stored `total_value`, as written (2dp
   * text, e.g. "-12.34"): new stored value minus previous stored value. This
   * is the sub-ledger value the movement moved, and what the ledger posts to
   * the INVENTORY account (postInventoryMovementJournalTx, the sale COGS, the
   * stock-in journal). An issue reports a negative delta, a receipt a
   * positive one.
   */
  valueDelta: string;
  /**
   * Receipts only (2dp text, "0.00" otherwise): what the receipt was worth,
   * quantity × incoming rate (or the incoming value the caller passed).
   * `valueDelta + shortageSettlementVariance` always equals it.
   */
  receiptValue: string;
  /**
   * Receipts only: the quantity of an existing shortage this receipt settled.
   */
  settledQuantity: number;
  /**
   * Receipts only (2dp text, signed): the cost the settled shortage was
   * provisionally relieved at differs from what the receipt paid for those
   * units. It is (receipt rate − provisional rate) × settled quantity, exactly
   * `receiptValue − valueDelta`. The sub-ledger takes back only the
   * provisional value (the short issue already posted that to COGS), so a
   * caller that books the receipt at its full value posts this difference to
   * COGS: positive = the units sold short cost more than provisionally booked.
   * A receipt into an empty row that still held a residual value reports that
   * residual here too (it is flushed to COGS, not capitalised).
   */
  shortageSettlementVariance: string;
}

/** Optional inputs of adjustInventory beyond its positional arguments. */
export interface AdjustInventoryOptions {
  /**
   * Receipts only: the exact value received (2dp), instead of
   * round(quantity × incomingRate). Lets a document whose lines carry a value
   * (an offload line, a stock receipt) move the sub-ledger by exactly that
   * value; incomingRate is then ignored.
   */
  incomingValue?: Decimal.Value;
}

// ─────────────────────────────────────────────────────────────
// Precision and valuation policy
// ─────────────────────────────────────────────────────────────
//
// All arithmetic is decimal (decimal.js at 40 significant digits), never JS
// floats. The public signature still takes and returns numbers for
// quantities and rates, so none of the call sites move; the value fields
// that feed the ledger are 2dp strings.
//
// Wave 11 (inventory fidelity), owner decisions:
//
//  - Stock value is `inventory.total_value` (numeric(20,2)). The stored
//    `average_rate` (numeric(20,7), RATE_DP below) is display precision and
//    cost memory only; it never regenerates value.
//  - An issue from positive stock relieves value pro rata to the stored value:
//    the units left keep the row's weighted average, so the value left is
//    round(newQty × average) and the issue relieves the rest. The average is
//    total_value / quantity, held as the stored 7dp rate while that rate
//    reproduces the stored value to the cent; an issue never changes it, so
//    the stored value never drifts from quantity × cost by more than half a
//    cent (relieving round(rate × qty) per issue drifted by the rounding of
//    every issue). The issue that empties the row relieves whatever value is
//    left (the residual flush), so an emptied row holds zero.
//  - Negative stock is allowed and costed provisionally. A short issue
//    relieves the shortage at the item's cost memory (the current average,
//    or the stored rate once the row is empty), so the sale's COGS is posted
//    at that provisional cost and the row's total_value goes negative by the
//    same amount: the sub-ledger and the INVENTORY account move together.
//    Readers that report stock value (stockValuation.total) do not let a
//    negative row subtract; the reconciliation compares the ledger with the
//    signed sub-ledger (stockValuation.subLedgerTotal), which includes it.
//  - A receipt into negative stock first settles the shortage: the settled
//    quantity takes back its share of the negative value (pro rata, the whole
//    remainder when the shortage is fully covered), the rest is received at
//    the receipt rate, and the result reports the difference between what the
//    receipt paid for the settled units and their provisional value
//    (shortageSettlementVariance) so the caller posts it to COGS.
//  - A residual value left on an empty row (an exact reversal can leave one)
//    is never capitalised into new stock: the next receipt flushes it to COGS
//    through its settlement variance, the next issue relieves it.
//  - inventory_negative_layers keeps the FIFO quantity of each shortage and
//    the provisional rate it was booked at (audit trail, cost-variance log).
//    Value is taken from the row, not the layers, so stale layers cannot add
//    or drop value.
//
// No clamp drops value any more. The two that remain are documented where
// they are: a negative incoming rate is received at zero (and logged), and
// a negative cost memory is stored as zero (it is never used as value).

/** Scale of each column these values are written to. */
const QTY_DP = 3;
/** inventory.average_rate is numeric(20,7) since wave 11 (display / cost memory). */
const RATE_DP = 7;
const VALUE_DP = 2;
/** inventory_negative_layers.provisional_rate is numeric(20,4). */
const LAYER_RATE_DP = 4;

/** Decimal arithmetic at 40 significant digits (numeric(20,x) never overflows it). */
const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
type Dec = InstanceType<typeof D>;

/**
 * Half of the quantity column's last place. A residue smaller than this cannot
 * survive being written at 3dp, so the engine treats it as zero rather than
 * carrying a layer that rounds away to nothing.
 */
const QTY_EPSILON = new D("0.0005");

/** Cost variance worth a log line, in currency units. */
const VARIANCE_LOG_THRESHOLD = new D("0.01");

const ZERO = new D(0);

/**
 * decimal.js parses a number through its shortest round-trip decimal form, so
 * `toDecimal(0.1)` is exactly 0.1 rather than the binary value 0.1 denotes.
 * That is what we want: callers are expressing decimal intent.
 */
function toDecimal(value: Decimal.Value | null | undefined): Dec {
  if (value === null || value === undefined || value === "") return ZERO;
  const parsed = new D(value);
  return parsed.isFinite() ? parsed : ZERO;
}

/** Rounded to the value column's 2dp. */
const money = (value: Dec): Dec => value.toDecimalPlaces(VALUE_DP);

// ─────────────────────────────────────────────────────────────
// Private helpers
// ─────────────────────────────────────────────────────────────

async function createNegativeLayer(
  tx: TxOrDb,
  companyId: number,
  locationId: number,
  stockItemId: number,
  qty: Dec,
  provisionalRate: Dec,
  sourceVoucherType?: string,
  sourceVoucherId?: number
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO inventory_negative_layers
      (company_id, location_id, stock_item_id, qty, provisional_rate, source_voucher_type, source_voucher_id)
    VALUES
      (${companyId}, ${locationId}, ${stockItemId}, ${qty.toFixed(QTY_DP)},
       ${Decimal.max(provisionalRate, ZERO).toFixed(LAYER_RATE_DP)}, ${sourceVoucherType ?? null}, ${sourceVoucherId ?? null})
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
function incrementalShortage(previousQty: Dec, newQty: Dec): Dec {
  const previousShortage = Decimal.max(previousQty.negated(), ZERO);
  const newShortage = Decimal.max(newQty.negated(), ZERO);
  return new D(Decimal.max(newShortage.minus(previousShortage), ZERO));
}

/**
 * Settle oldest negative layers FIFO for the shortage quantity a receipt
 * covers. Quantity bookkeeping only: the value the settlement takes back comes
 * from the inventory row (see adjustInventory), and the per-layer cost variance
 * is logged for audit.
 */
async function settleNegativeLayers(
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
interface MovementOutcome {
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
function costMemory(prevQty: Dec, prevValue: Dec, prevRate: Dec): Dec {
  if (prevQty.gt(ZERO) && prevValue.gt(ZERO)) return averageAnchor(prevQty, prevValue, prevRate);
  return prevRate.gt(ZERO) ? prevRate : ZERO;
}

/** An issue of `issueQty` (> 0) from a row (policy in the module comment). */
function issueOutcome(prevQty: Dec, prevValue: Dec, prevRate: Dec, issueQty: Dec): MovementOutcome {
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
function receiptOutcome(
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

function resultOf(prevQty: Dec, prevValue: Dec, outcome: MovementOutcome, created: boolean): AdjustInventoryResult {
  const storedNewValue = money(outcome.newValue);
  const valueDelta = storedNewValue.minus(prevValue);
  return {
    previousQuantity: prevQty.toNumber(),
    newQuantity: outcome.newQty.toNumber(),
    previousTotalValue: prevValue.toNumber(),
    newTotalValue: storedNewValue.toNumber(),
    averageRate: new D(outcome.newRate.toFixed(RATE_DP)).toNumber(),
    created,
    valueDelta: valueDelta.toFixed(VALUE_DP),
    receiptValue: money(outcome.receiptValue).toFixed(VALUE_DP),
    settledQuantity: outcome.settledQty.toNumber(),
    shortageSettlementVariance: money(outcome.receiptValue).minus(valueDelta).toFixed(VALUE_DP),
  };
}

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────

/**
 * Core inventory costing function (policy in the module comment above).
 *
 *  - deltaQty > 0: a receipt at incomingRate (or options.incomingValue);
 *    without either it is received at the row's cost memory.
 *  - deltaQty < 0: an issue at the row's cost; beyond zero it goes short at
 *    the cost memory and records a negative layer for the new shortage.
 *  - deltaQty = 0: no-op.
 *
 * The result's valueDelta is what the ledger posts to Inventory; a receipt's
 * shortageSettlementVariance is what it posts to COGS.
 */
export async function adjustInventory(
  tx: TxOrDb,
  locationId: number,
  stockItemId: number,
  deltaQty: number,
  companyId: number,
  incomingRate?: number,
  sourceVoucherType?: string,
  sourceVoucherId?: number,
  options: AdjustInventoryOptions = {}
): Promise<AdjustInventoryResult> {
  const lockResult = await tx.execute(sql`
    SELECT id, quantity, average_rate, total_value
    FROM inventory
    WHERE location_id = ${locationId} AND stock_item_id = ${stockItemId}
    FOR UPDATE
  `);
  const existing = firstRow<InventoryRow>(lockResult);
  const delta = toDecimal(deltaQty);

  const prevQty = existing ? toDecimal(existing.quantity) : ZERO;
  const prevValue = existing ? money(toDecimal(existing.total_value)) : ZERO;
  const prevRate = existing ? toDecimal(existing.average_rate) : Decimal.max(toDecimal(incomingRate), ZERO);

  let outcome: MovementOutcome;
  if (delta.gt(ZERO)) {
    let receiptValue: Dec;
    if (options.incomingValue !== undefined) {
      receiptValue = money(toDecimal(options.incomingValue));
    } else {
      const rate = incomingRate === undefined ? costMemory(prevQty, prevValue, prevRate) : toDecimal(incomingRate);
      receiptValue = money(delta.times(rate));
    }
    if (receiptValue.isNegative()) {
      // Kept clamp: a receipt cannot carry negative value. Logged so it is not silent.
      logger.warn(
        `[adjustInventory] Negative receipt value received at zero: loc=${locationId} item=${stockItemId} ` +
          `qty=${delta.toFixed(QTY_DP)} value=${receiptValue.toFixed(VALUE_DP)}`
      );
      receiptValue = ZERO;
    }
    outcome = receiptOutcome(prevQty, prevValue, prevRate, delta, receiptValue);
    if (prevQty.isNegative() && outcome.settledQty.gt(ZERO)) {
      await settleNegativeLayers(tx, locationId, stockItemId, outcome.settledQty, receiptValue.dividedBy(delta));
    }
  } else if (delta.lt(ZERO)) {
    outcome = issueOutcome(prevQty, prevValue, prevRate, delta.negated());
  } else {
    outcome = {
      newQty: prevQty,
      newValue: prevValue,
      newRate: prevRate,
      receiptValue: ZERO,
      settledQty: ZERO,
      shortage: null,
    };
  }

  // Kept clamp: a negative cost memory is stored as zero. The rate never
  // regenerates value, so this drops nothing.
  if (outcome.newRate.isNegative()) outcome.newRate = ZERO;

  if (existing) {
    await tx.execute(sql`
      UPDATE inventory
      SET quantity     = ${outcome.newQty.toFixed(QTY_DP)},
          average_rate = ${outcome.newRate.toFixed(RATE_DP)},
          total_value  = ${money(outcome.newValue).toFixed(VALUE_DP)},
          last_updated = NOW()
      WHERE id = ${existing.id}
    `);
  } else {
    // No row yet. A concurrent transaction may insert the same row between
    // the SELECT above and this INSERT; then nothing is inserted and the
    // movement is re-applied against the row it wrote (now locked by us),
    // so both movements are costed exactly.
    const inserted = await tx.execute(sql`
      INSERT INTO inventory (company_id, location_id, stock_item_id, quantity, average_rate, total_value, last_updated)
      VALUES (${companyId}, ${locationId}, ${stockItemId}, ${outcome.newQty.toFixed(QTY_DP)},
              ${outcome.newRate.toFixed(RATE_DP)}, ${money(outcome.newValue).toFixed(VALUE_DP)}, NOW())
      ON CONFLICT (location_id, stock_item_id) DO NOTHING
      RETURNING id
    `);
    if (resultRows<{ id: number }>(inserted).length === 0) {
      return adjustInventory(
        tx,
        locationId,
        stockItemId,
        deltaQty,
        companyId,
        incomingRate,
        sourceVoucherType,
        sourceVoucherId,
        options
      );
    }
  }

  if (outcome.shortage) {
    await createNegativeLayer(
      tx,
      companyId,
      locationId,
      stockItemId,
      outcome.shortage.qty,
      outcome.shortage.rate,
      sourceVoucherType,
      sourceVoucherId
    );
  }

  return resultOf(prevQty, prevValue, outcome, !existing);
}

/** Receives stock at an exact value (see AdjustInventoryOptions.incomingValue). */
export async function receiveInventoryAtValue(
  tx: TxOrDb,
  params: {
    locationId: number;
    stockItemId: number;
    quantity: Decimal.Value;
    value: Decimal.Value;
    companyId: number;
    sourceVoucherType?: string;
    sourceVoucherId?: number;
  }
): Promise<AdjustInventoryResult> {
  const quantity = toDecimal(params.quantity);
  // A non-positive quantity is not a receipt: it moves at the row's cost and
  // the value is ignored (adjustInventory's own rules).
  return adjustInventory(
    tx,
    params.locationId,
    params.stockItemId,
    quantity.toNumber(),
    params.companyId,
    undefined,
    params.sourceVoucherType,
    params.sourceVoucherId,
    quantity.gt(ZERO) ? { incomingValue: params.value } : {}
  );
}

export interface ExactReversalResult {
  previousQuantity: number;
  newQuantity: number;
  previousTotalValue: number;
  newTotalValue: number;
  /** Signed change of the stored total_value (2dp): minus the value reversed. */
  valueDelta: string;
}

/**
 * Reverse an exact qty + value previously written to inventory.
 * Used for voucher reversals — does not recalculate moving average.
 *
 * Design (wave 11):
 *  - Subtracts qtyToReverse and valueToReverse exactly, with no clamp: the
 *    ledger removes exactly the value the reversed document posted, so the
 *    sub-ledger does too. A reversal that takes the row short leaves the
 *    negative value the reversed receipt had restored (negative-stock
 *    policy); one that leaves a residual on an emptied row keeps it, and the
 *    next movement on the row carries it (stockValuation reports it).
 *  - averageRate is the remaining average while stock is held, else the
 *    cost memory is kept.
 *  - If the reversal pushes qty below zero, a negative layer is created for
 *    only the incremental shortage so repeated reversals remain symmetric.
 *    The layer's company is the row's own when the caller passes none.
 */
export async function reverseInventoryByExactValue(
  tx: TxOrDb,
  locationId: number,
  stockItemId: number,
  qtyToReverse: number,
  valueToReverse: Decimal.Value,
  companyId?: number,
  sourceVoucherType?: string,
  sourceVoucherId?: number
): Promise<ExactReversalResult | null> {
  const lockResult = await tx.execute(sql`
    SELECT id, company_id, quantity, average_rate, total_value
    FROM inventory
    WHERE location_id = ${locationId} AND stock_item_id = ${stockItemId}
    FOR UPDATE
  `);
  const existing = firstRow<InventoryRow & { company_id: number }>(lockResult);
  if (!existing) {
    logger.warn(`[reverseInventoryByExactValue] No inventory row to reverse: loc=${locationId} item=${stockItemId}`);
    return null;
  }

  const currentQty = toDecimal(existing.quantity);
  const currentValue = money(toDecimal(existing.total_value));
  const currentRate = toDecimal(existing.average_rate);

  const reverseQty = toDecimal(qtyToReverse);
  const reverseValue = money(toDecimal(valueToReverse));

  let newQty = currentQty.minus(reverseQty);
  if (newQty.abs().lt(QTY_EPSILON)) newQty = ZERO;
  const newValue = currentValue.minus(reverseValue);

  let newRate: Dec;
  if (newQty.gt(ZERO) && newValue.gt(ZERO)) {
    newRate = newValue.dividedBy(newQty);
  } else if (newQty.isNegative() && newValue.isNegative()) {
    newRate = newValue.dividedBy(newQty);
  } else {
    newRate = currentRate; // cost memory, never lost
  }
  if (newRate.isNegative()) newRate = ZERO;

  const shortageQty = incrementalShortage(currentQty, newQty);
  const layerCompanyId = companyId ?? existing.company_id;
  if (shortageQty.gt(QTY_EPSILON) && layerCompanyId) {
    const provisionalRate = newRate.gt(ZERO)
      ? newRate
      : reverseQty.gt(ZERO)
        ? reverseValue.dividedBy(reverseQty).abs()
        : ZERO;
    await createNegativeLayer(
      tx,
      layerCompanyId,
      locationId,
      stockItemId,
      shortageQty,
      provisionalRate,
      sourceVoucherType,
      sourceVoucherId
    );
  }

  await tx.execute(sql`
    UPDATE inventory
    SET quantity     = ${newQty.toFixed(QTY_DP)},
        average_rate = ${newRate.toFixed(RATE_DP)},
        total_value  = ${newValue.toFixed(VALUE_DP)},
        last_updated = NOW()
    WHERE id = ${existing.id}
  `);

  return {
    previousQuantity: currentQty.toNumber(),
    newQuantity: newQty.toNumber(),
    previousTotalValue: currentValue.toNumber(),
    newTotalValue: newValue.toNumber(),
    valueDelta: newValue.minus(currentValue).toFixed(VALUE_DP),
  };
}
