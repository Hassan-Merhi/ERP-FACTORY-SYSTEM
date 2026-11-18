import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import { logger } from "./lib/logger";
import { firstRow, resultRows } from "./lib/queryResult";
import { clearResolvedNegativeLayers } from "./services/inventory/clearResolvedNegativeLayers";
import {
  D,
  QTY_DP,
  QTY_EPSILON,
  RATE_DP,
  VALUE_DP,
  ZERO,
  createNegativeLayer,
  incrementalShortage,
  money,
  toDecimal,
  type AdjustInventoryOptions,
  type AdjustInventoryResult,
  type Dec,
  type InventoryRow,
  type TxOrDb,
} from "./inventoryHelperCreateNegativeLayer";
import {
  costMemory,
  issueOutcome,
  receiptOutcome,
  settleNegativeLayers,
  type MovementOutcome,
} from "./inventoryHelperReceiptOutcome";
export type { AdjustInventoryOptions, AdjustInventoryResult } from "./inventoryHelperCreateNegativeLayer";

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
  // Legacy reversals may leave shortage metadata after units return to zero
  // or positive stock. Never allow that metadata to settle a later receipt.
  await clearResolvedNegativeLayers(tx, companyId, locationId, stockItemId, outcome.newQty.toFixed(QTY_DP));

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
