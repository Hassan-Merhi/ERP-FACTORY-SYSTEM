/**
 * Value-exact stock reversals (wave 11).
 *
 * Every stock line written from wave 11 on records `value_moved`: the exact
 * sub-ledger value it moved, as a positive magnitude in the line's own
 * direction (a sale or consumption line: the value it relieved; a production
 * or credit-note line: the value it received; a transfer line: the value the
 * source relieved, which is also what the destination received). A reversal
 * moves exactly that value back, not quantity × today's (or the line's 2dp)
 * rate.
 *
 * Direction is never read from the sign of value_moved; it comes from the
 * document (readers take the magnitude, lineValueMoved):
 *   - stock adjustment: Production in, Consumption out, Mixed (and any other
 *     type) by the sign of the line's quantity; the type is compared trimmed
 *     and case-insensitively (both casings are stored);
 *   - sale / POS / credit-sales import lines: out;
 *   - stock transfer lines: out of the source, into the destination (abs);
 *   - credit note: in; debit note: out (abs).
 * The one signed column is container_offload_items.value_moved: it is the
 * line's signed sub-ledger change (valueDelta), negative on a net-negative PO
 * line that returned stock, so the stock-in journal can sum it and a reversal
 * subtracts it with the line's signed quantity. A reader of an offload line
 * takes its direction from the sign of the quantity.
 *
 * Legacy lines (value_moved NULL, written before wave 11) fall back to:
 *   - sales lines: the sale's COGS journal (COGS-{voucherId}) spread over the
 *     legacy lines pro rata to their total_cost (by quantity when every cost is
 *     zero; the last line takes the rounding remainder), else the line's
 *     total_cost when the sale has no COGS journal;
 *   - other lines: the line's stored total (total_amount / total_value).
 *
 * The sub-ledger primitives (restoreInventoryByExactValue,
 * reverseInventoryByExactValue) move exactly the value given. The ledger's own
 * reversal (a removed COGS journal, a soft-deleted voucher's Inventory line)
 * can still differ from what the reversal moves in the sub-ledger: a document
 * dated before the cut-over carries no Inventory line, a legacy line's value
 * is an estimate, a sale without a location restores no stock. The helpers
 * below return the measured change of `inventory.total_value`, and
 * `postReversalResidualTx` posts the difference as an INV-MOVE journal against
 * INVENTORY_ADJUSTMENT, dated the day of the reversal. Before the company's
 * cut-over (or for a supplier partner) that journal is a no-op, as every
 * INV-MOVE journal is.
 */
import type Decimal from "decimal.js";
import { sql } from "drizzle-orm";

import type { DbTransaction } from "../../db";
import { adjustInventory, reverseInventoryByExactValue } from "../../inventoryHelper";
import { MoneyDecimal, toMoney, type MoneyInput } from "../../lib/money";
import { firstRow, resultRows } from "../../lib/queryResult";
import {
  postInventoryMovementJournalTx,
  type InventoryMovementJournalResult,
} from "../accounting/perpetualInventory/inventoryMovementJournal";
import { restoreInventoryByExactValue } from "./exactValueInventory";

const ZERO = new MoneyDecimal(0);

type StoredRow = { id: number; quantity: string; total_value: string };

async function storedRow(
  tx: DbTransaction,
  companyId: number,
  locationId: number,
  stockItemId: number
): Promise<StoredRow | undefined> {
  return firstRow<StoredRow>(
    await tx.execute(sql`
      SELECT id, quantity::text AS quantity, total_value::text AS total_value
        FROM inventory
       WHERE company_id = ${companyId} AND location_id = ${locationId} AND stock_item_id = ${stockItemId}
       FOR UPDATE
    `)
  );
}

/** A line's value moved, or its stored total for a legacy line (positive magnitude). */
export function lineValueMoved(line: { valueMoved?: MoneyInput; total: MoneyInput }): Decimal {
  const value = line.valueMoved === null || line.valueMoved === undefined ? line.total : line.valueMoved;
  return toMoney(value).abs().toDecimalPlaces(2);
}

export interface ExactReversalParams {
  companyId: number;
  locationId: number;
  stockItemId: number;
  /** Quantity to move back (positive). */
  quantity: MoneyInput;
  /** Value to move back (positive): the line's value moved. */
  value: MoneyInput;
  /**
   * False for a legacy line whose value is only an estimate (no value_moved);
   * see restoreIssuedValueTx.
   */
  exact?: boolean;
  sourceVoucherType?: string;
  sourceVoucherId?: number;
}

/**
 * Puts an issue back (a sale, a consumption, a debit note, a transfer's
 * source leg): + quantity, + exactly `value`, through
 * restoreInventoryByExactValue (a short row's negative value moves up by the
 * value, as the negative-stock policy carries it). Returns the measured change
 * of the row's total_value.
 *
 * `exact: false` marks a legacy estimate (no value_moved): a restore into a
 * row that holds no value (short or empty) then values only the newly
 * positive quantity at value ÷ quantity, as before wave 11, so an estimate
 * cannot put more value into the row than the units it brings back above zero.
 */
export async function restoreIssuedValueTx(tx: DbTransaction, params: ExactReversalParams): Promise<Decimal> {
  const quantity = toMoney(params.quantity).abs();
  let value = toMoney(params.value).abs().toDecimalPlaces(2);
  if (quantity.isZero() && value.isZero()) return ZERO;
  const before = await storedRow(tx, params.companyId, params.locationId, params.stockItemId);
  if (params.exact === false && before && !toMoney(before.quantity).gt(0) && !toMoney(before.total_value).gt(0)) {
    const positive = MoneyDecimal.max(toMoney(before.quantity).plus(quantity), 0);
    value = quantity.gt(0)
      ? MoneyDecimal.min(value, positive.times(value.dividedBy(quantity)).toDecimalPlaces(2))
      : value;
  }
  const result = await restoreInventoryByExactValue(
    tx,
    params.companyId,
    params.locationId,
    params.stockItemId,
    quantity.toNumber(),
    value.toFixed(2)
  );
  return toMoney(result.newTotalValue).minus(toMoney(result.previousTotalValue)).toDecimalPlaces(2);
}

/**
 * Takes a receipt back out (a production, a credit note, a transfer's
 * destination leg): − quantity, − exactly `value`, through
 * reverseInventoryByExactValue (a missing row becomes a short row through
 * adjustInventory, so the quantity still leaves). Returns the measured change
 * of the row's total_value.
 */
export async function reverseReceivedValueTx(tx: DbTransaction, params: ExactReversalParams): Promise<Decimal> {
  const quantity = toMoney(params.quantity).abs();
  const value = toMoney(params.value).abs();
  if (quantity.isZero() && value.isZero()) return ZERO;
  const before = await storedRow(tx, params.companyId, params.locationId, params.stockItemId);
  if (!before) {
    const result = await adjustInventory(
      tx,
      params.locationId,
      params.stockItemId,
      quantity.negated().toNumber(),
      params.companyId,
      undefined,
      params.sourceVoucherType,
      params.sourceVoucherId
    );
    return toMoney(result.valueDelta);
  }
  const previousValue = toMoney(before.total_value);
  await reverseInventoryByExactValue(
    tx,
    params.locationId,
    params.stockItemId,
    quantity.toNumber(),
    value.toFixed(2),
    params.companyId,
    params.sourceVoucherType,
    params.sourceVoucherId
  );
  const after = await storedRow(tx, params.companyId, params.locationId, params.stockItemId);
  return toMoney(after?.total_value).minus(previousValue).toDecimalPlaces(2);
}

export interface SaleLineForReversal {
  id: number;
  quantity: MoneyInput;
  totalCost?: MoneyInput;
  costPrice?: MoneyInput;
  valueMoved?: MoneyInput;
}

export interface SaleLineValue {
  value: Decimal;
  /** True when the value is the line's recorded value_moved. */
  exact: boolean;
}

/** A legacy sale line's own cost: total_cost, else quantity × cost_price. */
function legacyLineCost(line: SaleLineForReversal): Decimal {
  if (line.totalCost !== null && line.totalCost !== undefined) return toMoney(line.totalCost).abs();
  return toMoney(line.quantity).abs().times(toMoney(line.costPrice)).abs().toDecimalPlaces(2);
}

/** What the sale's COGS journal took out of the ledger's Inventory (0 when it has none). */
export async function saleCogsInventoryCreditTx(
  tx: DbTransaction,
  companyId: number,
  saleVoucherId: number
): Promise<Decimal> {
  const row = firstRow<{ amount: string }>(
    await tx.execute(sql`
      SELECT COALESCE(SUM(ve.credit_amount - ve.debit_amount), 0)::text AS amount
        FROM vouchers v
        JOIN voucher_entries ve ON ve.voucher_id = v.id
        JOIN ledger_accounts la ON la.id = ve.ledger_account_id AND la.company_id = v.company_id AND la.code = 'INVENTORY'
       WHERE v.company_id = ${companyId} AND v.voucher_number = ${`COGS-${saleVoucherId}`} AND v.deleted_at IS NULL
         AND COALESCE(v.optional, false) = false
    `)
  );
  return toMoney(row?.amount).toDecimalPlaces(2);
}

/**
 * The value each sale line relieved, for an exact reversal: value_moved, or
 * for legacy lines the COGS journal pro rata (see the module comment).
 */
export async function saleLineValuesTx(
  tx: DbTransaction,
  companyId: number,
  saleVoucherId: number,
  lines: readonly SaleLineForReversal[]
): Promise<Map<number, SaleLineValue>> {
  const values = new Map<number, SaleLineValue>();
  const legacy = lines.filter((line) => line.valueMoved === null || line.valueMoved === undefined);
  for (const line of lines) {
    if (!legacy.includes(line)) {
      values.set(line.id, { value: toMoney(line.valueMoved).abs().toDecimalPlaces(2), exact: true });
    }
  }
  if (legacy.length === 0) return values;

  const known = [...values.values()].reduce((sum, entry) => sum.plus(entry.value), ZERO);
  const journal = (await saleCogsInventoryCreditTx(tx, companyId, saleVoucherId)).minus(known);
  if (!journal.gt(0)) {
    for (const line of legacy) values.set(line.id, { value: legacyLineCost(line), exact: false });
    return values;
  }
  const costs = legacy.map(legacyLineCost);
  const costTotal = costs.reduce((sum, cost) => sum.plus(cost), ZERO);
  const weights = costTotal.gt(0) ? costs : legacy.map((line) => toMoney(line.quantity).abs());
  const weightTotal = weights.reduce((sum, weight) => sum.plus(weight), ZERO);
  let allocated = ZERO;
  legacy.forEach((line, index) => {
    const share =
      index === legacy.length - 1
        ? journal.minus(allocated)
        : weightTotal.gt(0)
          ? journal.times(weights[index]).dividedBy(weightTotal).toDecimalPlaces(2)
          : ZERO;
    allocated = allocated.plus(share);
    // The COGS journal is what the sale relieved: exact for the sale as a whole.
    values.set(line.id, { value: share, exact: true });
  });
  return values;
}

/**
 * Signed amount (debit positive) the given vouchers carry on the company's
 * Inventory account, among live, non-optional vouchers.
 */
export async function inventoryLedgerNetTx(
  tx: DbTransaction,
  companyId: number,
  voucherIds: readonly number[]
): Promise<Decimal> {
  if (voucherIds.length === 0) return ZERO;
  const rows = resultRows<{ amount: string }>(
    await tx.execute(sql`
      SELECT COALESCE(SUM(ve.debit_amount - ve.credit_amount), 0)::text AS amount
        FROM vouchers v
        JOIN voucher_entries ve ON ve.voucher_id = v.id
        JOIN ledger_accounts la ON la.id = ve.ledger_account_id AND la.company_id = v.company_id AND la.code = 'INVENTORY'
       WHERE v.company_id = ${companyId} AND v.deleted_at IS NULL AND COALESCE(v.optional, false) = false
         AND v.id IN (${sql.join(
           voucherIds.map((id) => sql`${id}`),
           sql`, `
         )})
    `)
  );
  return toMoney(rows[0]?.amount).toDecimalPlaces(2);
}

/** The business date of a reversal made now. */
export function reversalDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Posts the part of a reversal's sub-ledger change the ledger's own reversal
 * does not cover: `subLedgerDelta` (the measured change of the stock value)
 * minus `ledgerDelta` (the signed change the reversal made to the ledger's
 * Inventory account). A zero residual, a company before its cut-over and a
 * supplier partner post nothing.
 */
export async function postReversalResidualTx(
  tx: DbTransaction,
  params: {
    companyId: number;
    sourceType: string;
    sourceId: number | string;
    reference: string;
    subLedgerDelta: Decimal;
    ledgerDelta: Decimal;
    actor?: { userId: string; username: string } | null;
    locationId?: number | null;
  }
): Promise<InventoryMovementJournalResult | null> {
  return postInventoryMovementJournalTx(tx, {
    companyId: params.companyId,
    sourceType: params.sourceType,
    sourceId: params.sourceId,
    date: reversalDate(),
    reference: params.reference,
    lines: [{ valueDelta: params.subLedgerDelta.minus(params.ledgerDelta).toDecimalPlaces(2).toFixed(2) }],
    offsetAccountCode: "INVENTORY_ADJUSTMENT",
    narration: "Stock reversal difference",
    actor: params.actor ?? null,
    locationId: params.locationId ?? null,
  });
}

/** Sums a list of decimals (2dp). */
export function sumDecimals(values: Iterable<Decimal>): Decimal {
  let total = ZERO;
  for (const value of values) total = total.plus(value);
  return total.toDecimalPlaces(2);
}
