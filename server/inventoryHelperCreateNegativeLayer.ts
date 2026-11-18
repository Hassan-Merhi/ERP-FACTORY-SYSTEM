// Extracted from ./inventoryHelper.ts to keep that module under the source-size cap.
import Decimal from "decimal.js";
import { sql, type SQL } from "drizzle-orm";

/**
 * The only surface these helpers need from their connection. Typing it
 * structurally rather than as the concrete Drizzle database keeps both real
 * callers working — `db` and a transaction `tx` alike — without naming a
 * generic that would drag the whole schema in. `select`/`insert`/`update`/
 * `delete` were dropped because this module only ever calls `execute`.
 */
export type TxOrDb = {
  execute: (query: SQL) => Promise<unknown>;
};

/** Row shape for the `inventory` lock/read in the costing path. */
export type InventoryRow = {
  id: number;
  quantity: string | number | null;
  average_rate: string | number | null;
  total_value: string | number | null;
};

/** Row shape for the `inventory_negative_layers` FIFO settlement read. */
export type NegativeLayerRow = {
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
export const QTY_DP = 3;

/** inventory.average_rate is numeric(20,7) since wave 11 (display / cost memory). */
export const RATE_DP = 7;

export const VALUE_DP = 2;

/** inventory_negative_layers.provisional_rate is numeric(20,4). */
const LAYER_RATE_DP = 4;

/** Decimal arithmetic at 40 significant digits (numeric(20,x) never overflows it). */
export const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export type Dec = InstanceType<typeof D>;

/**
 * Half of the quantity column's last place. A residue smaller than this cannot
 * survive being written at 3dp, so the engine treats it as zero rather than
 * carrying a layer that rounds away to nothing.
 */
export const QTY_EPSILON = new D("0.0005");

/** Cost variance worth a log line, in currency units. */
export const VARIANCE_LOG_THRESHOLD = new D("0.01");

export const ZERO = new D(0);

/**
 * decimal.js parses a number through its shortest round-trip decimal form, so
 * `toDecimal(0.1)` is exactly 0.1 rather than the binary value 0.1 denotes.
 * That is what we want: callers are expressing decimal intent.
 */
export function toDecimal(value: Decimal.Value | null | undefined): Dec {
  if (value === null || value === undefined || value === "") return ZERO;
  const parsed = new D(value);
  return parsed.isFinite() ? parsed : ZERO;
}

/** Rounded to the value column's 2dp. */
export const money = (value: Dec): Dec => value.toDecimalPlaces(VALUE_DP);

// ─────────────────────────────────────────────────────────────
// Private helpers
// ─────────────────────────────────────────────────────────────

export async function createNegativeLayer(
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
export function incrementalShortage(previousQty: Dec, newQty: Dec): Dec {
  const previousShortage = Decimal.max(previousQty.negated(), ZERO);
  const newShortage = Decimal.max(newQty.negated(), ZERO);
  return new D(Decimal.max(newShortage.minus(previousShortage), ZERO));
}
