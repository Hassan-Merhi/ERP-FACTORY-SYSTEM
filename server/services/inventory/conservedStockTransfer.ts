/**
 * Stock transfers that conserve the company's stock value (wave 11).
 *
 * A transfer moves stock between two locations of one company, so it must not
 * create or destroy stock value: the destination receives exactly the value
 * the source relieved (the source's `valueDelta`), at relieved ÷ quantity —
 * not the source's 2dp average rate, which loses the rounding residual and,
 * when the source goes short, would value stock the source never held.
 *
 * The transfer's line records that value as `value_moved`, and every
 * reversal (edit, unpost, delete) moves exactly that value back from the
 * destination to the source.
 *
 * The sub-ledger can still keep a different value than it was given: a
 * receipt into a short destination settles the shortage at its provisional
 * value and reports the difference (receipt value − provisional value of the
 * settled units, AdjustInventoryResult.shortageSettlementVariance), which owner
 * decision 2 sends to COGS. The net of a transfer's legs is then not zero, and
 * the ledger, which carries no line for a transfer, would drift from the
 * sub-ledger. `postTransferResidualTx` posts that net as an INV-MOVE journal
 * against COGS, which is a no-op before the cut-over, for a supplier partner
 * and for a zero net.
 */
import { randomUUID } from "node:crypto";

import type Decimal from "decimal.js";
import { sql } from "drizzle-orm";

import type { DbTransaction } from "../../db";
import { adjustInventory } from "../../inventoryHelper";
import { MoneyDecimal, toMoney, type MoneyInput } from "../../lib/money";
import { firstRow, resultRows } from "../../lib/queryResult";
import { postInventoryMovementJournalTx } from "../accounting/perpetualInventory/inventoryMovementJournal";
import { restoreIssuedValueTx, reverseReceivedValueTx, reversalDate } from "./valueExactReversal";

const ZERO = new MoneyDecimal(0);

export interface ConservedTransferLeg {
  companyId: number;
  sourceLocationId: number;
  destinationLocationId: number;
  stockItemId: number;
  quantity: MoneyInput;
  /**
   * Cost memory for a source with no row (the negative layer's provisional
   * rate); it never values the destination.
   */
  fallbackRate?: MoneyInput;
  sourceVoucherType?: string;
  sourceVoucherId?: number;
}

export interface ConservedTransferResult {
  /** Value the source relieved (positive): the line's value_moved. */
  relieved: Decimal;
  /** Rate the destination received at: relieved ÷ quantity. */
  rate: Decimal;
  /** Signed sub-ledger change at the source and the destination. */
  sourceDelta: Decimal;
  destinationDelta: Decimal;
}

/** Moves one leg: the destination receives exactly what the source relieved. */
export async function moveTransferLegConservedTx(
  tx: DbTransaction,
  leg: ConservedTransferLeg
): Promise<ConservedTransferResult> {
  const quantity = toMoney(leg.quantity).abs();
  const fallbackRate = toMoney(leg.fallbackRate);
  const issue = await adjustInventory(
    tx,
    leg.sourceLocationId,
    leg.stockItemId,
    quantity.negated().toNumber(),
    leg.companyId,
    fallbackRate.isNegative() ? 0 : fallbackRate.toNumber(),
    leg.sourceVoucherType,
    leg.sourceVoucherId
  );
  const sourceDelta = toMoney(issue.valueDelta);
  const relieved = sourceDelta.isNegative() ? sourceDelta.negated() : ZERO;
  const rate = quantity.gt(0) ? relieved.dividedBy(quantity) : ZERO;
  // The destination receives exactly the relieved value (not quantity × a
  // rounded rate).
  const receipt = await adjustInventory(
    tx,
    leg.destinationLocationId,
    leg.stockItemId,
    quantity.toNumber(),
    leg.companyId,
    rate.toNumber(),
    leg.sourceVoucherType,
    leg.sourceVoucherId,
    { incomingValue: relieved.toFixed(2) }
  );
  return { relieved, rate, sourceDelta, destinationDelta: toMoney(receipt.valueDelta) };
}

/** Moves one leg back exactly: the destination gives back `value`, the source takes it. */
export async function reverseTransferLegExactTx(
  tx: DbTransaction,
  leg: Omit<ConservedTransferLeg, "fallbackRate"> & { value: MoneyInput }
): Promise<{ sourceDelta: Decimal; destinationDelta: Decimal }> {
  const destinationDelta = await reverseReceivedValueTx(tx, {
    companyId: leg.companyId,
    locationId: leg.destinationLocationId,
    stockItemId: leg.stockItemId,
    quantity: leg.quantity,
    value: leg.value,
    sourceVoucherType: leg.sourceVoucherType,
    sourceVoucherId: leg.sourceVoucherId,
  });
  const sourceDelta = await restoreIssuedValueTx(tx, {
    companyId: leg.companyId,
    locationId: leg.sourceLocationId,
    stockItemId: leg.stockItemId,
    quantity: leg.quantity,
    value: leg.value,
  });
  return { sourceDelta, destinationDelta };
}

export interface TransferRevisionDeltaParams {
  companyId: number;
  sourceLocationId: number;
  destinationLocationId: number;
  stockItemId: number;
  /** The line's quantity before and after the revision. */
  oldQuantity: MoneyInput;
  newQuantity: MoneyInput;
  /** What the line moved so far (lineValueMoved), 0 for a new line. */
  lineValue: MoneyInput;
  /** Cost memory for a source with no row (never values the destination). */
  fallbackRate?: MoneyInput;
  sourceVoucherType?: string;
  sourceVoucherId?: number;
}

/**
 * Applies a transfer revision's quantity change to one applied (source, item)
 * line (wave 15). An increase moves the extra quantity conserved (the
 * destination receives what the source relieved); a decrease moves back the
 * line's share of its value moved exactly (the whole value when the line goes
 * to zero), so revising a line and then deleting the transfer returns every
 * cent. Returns the line's new value_moved and the signed sub-ledger changes.
 */
export async function applyTransferRevisionDeltaTx(
  tx: DbTransaction,
  params: TransferRevisionDeltaParams
): Promise<{ valueMoved: Decimal; deltas: Decimal[] }> {
  const oldQuantity = toMoney(params.oldQuantity).abs();
  const newQuantity = toMoney(params.newQuantity);
  const lineValue = toMoney(params.lineValue).abs().toDecimalPlaces(2);
  const delta = newQuantity.minus(oldQuantity);
  const leg = {
    companyId: params.companyId,
    sourceLocationId: params.sourceLocationId,
    destinationLocationId: params.destinationLocationId,
    stockItemId: params.stockItemId,
    sourceVoucherType: params.sourceVoucherType,
    sourceVoucherId: params.sourceVoucherId,
  };
  if (delta.isZero()) return { valueMoved: lineValue, deltas: [] };
  if (delta.isPositive()) {
    const moved = await moveTransferLegConservedTx(tx, {
      ...leg,
      quantity: delta,
      fallbackRate: params.fallbackRate,
    });
    return { valueMoved: lineValue.plus(moved.relieved), deltas: [moved.sourceDelta, moved.destinationDelta] };
  }
  const back = delta.abs();
  const share =
    !newQuantity.gt(0) || !oldQuantity.gt(0)
      ? lineValue
      : MoneyDecimal.min(lineValue, lineValue.times(back).dividedBy(oldQuantity).toDecimalPlaces(2));
  const reversed = await reverseTransferLegExactTx(tx, { ...leg, quantity: back, value: share });
  return { valueMoved: lineValue.minus(share), deltas: [reversed.sourceDelta, reversed.destinationDelta] };
}

/**
 * Records value_moved on a transfer's lines from the value each
 * (source, item) group relieved, spread over the group's lines by quantity
 * (the last line takes the rounding remainder).
 */
export async function recordTransferValueMovedTx(
  tx: DbTransaction,
  transferId: number,
  relievedByGroup: ReadonlyMap<string, Decimal>,
  fallbackSourceLocationId?: number | null
): Promise<void> {
  const rows = resultRows<{ id: number; source_location_id: number | null; stock_item_id: number; quantity: string }>(
    await tx.execute(sql`
      SELECT id, source_location_id, stock_item_id, quantity::text AS quantity
        FROM stock_transfer_items WHERE transfer_id = ${transferId} ORDER BY id
    `)
  );
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = `${row.source_location_id ?? fallbackSourceLocationId}:${row.stock_item_id}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  for (const [key, groupRows] of groups) {
    const relieved = relievedByGroup.get(key);
    if (!relieved) continue;
    const totalQuantity = groupRows.reduce((sum, row) => sum.plus(toMoney(row.quantity).abs()), ZERO);
    let allocated = ZERO;
    for (const [index, row] of groupRows.entries()) {
      const share =
        index === groupRows.length - 1
          ? relieved.minus(allocated)
          : totalQuantity.gt(0)
            ? relieved.times(toMoney(row.quantity).abs()).dividedBy(totalQuantity).toDecimalPlaces(2)
            : ZERO;
      allocated = allocated.plus(share);
      await tx.execute(sql`UPDATE stock_transfer_items SET value_moved = ${share.toFixed(2)} WHERE id = ${row.id}`);
    }
  }
}

/** The movement date of a transfer: its voucher's date. */
export async function transferVoucherDateTx(tx: DbTransaction, companyId: number, voucherId: number): Promise<string> {
  const row = firstRow<{ voucher_date: string }>(
    await tx.execute(
      sql`SELECT voucher_date::text AS voucher_date FROM vouchers WHERE id = ${voucherId} AND company_id = ${companyId}`
    )
  );
  return row?.voucher_date ?? reversalDate();
}

/**
 * Posts the net sub-ledger change of a transfer's legs, if any (see the module
 * comment). Each call is its own journal: an edit's residual never replaces
 * the residual of the original posting.
 */
export async function postTransferResidualTx(
  tx: DbTransaction,
  params: {
    companyId: number;
    transferId: number;
    date: string;
    reference: string;
    deltas: readonly Decimal[];
    actor?: { userId: string; username: string } | null;
  }
): Promise<void> {
  const net = params.deltas.reduce((sum, delta) => sum.plus(delta), ZERO).toDecimalPlaces(2);
  if (net.isZero()) return;
  await postInventoryMovementJournalTx(tx, {
    companyId: params.companyId,
    sourceType: "stock-transfer",
    sourceId: `${params.transferId}:${randomUUID().slice(0, 8)}`,
    date: params.date,
    reference: params.reference,
    lines: [{ valueDelta: net.toFixed(2) }],
    // The only source of a non-zero net is a shortage settled at its
    // provisional value (decision 2: the receipt difference goes to COGS).
    offsetAccountCode: "COGS",
    narration: "Stock transfer shortage settlement",
    actor: params.actor ?? null,
  });
}
