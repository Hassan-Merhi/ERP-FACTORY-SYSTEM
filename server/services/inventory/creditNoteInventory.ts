/**
 * Stock side of credit and debit notes (wave 11).
 *
 * A credit note takes returned stock back in; a debit note sends stock out.
 * Each line moves the stock sub-ledger through adjustInventory, and the
 * note's Inventory line is exactly the value the sub-ledger moved (the line's
 * valueDelta), recorded on the line as `value_moved`:
 *
 *   - a credit note receives the stock at the line's inventory cost (the cost
 *     the note was priced at), so the stock never comes back at whatever the
 *     location's average happens to be. A line with no inventory cost is
 *     received at the location's current average; when the location has no
 *     average either the note is refused rather than taking the stock in at
 *     zero;
 *   - a debit note issues at the location's average, as every issue does.
 *
 * The document value of a line is quantity × inventory cost. Where the
 * sub-ledger moved a different value, the difference is posted so the note
 * still balances and the ledger's Inventory moves exactly with the sub-ledger:
 *   - credit note → COGS: the only gap is a return into a short row, which
 *     settles the shortage at its provisional value; the receipt difference
 *     of a settled shortage goes to COGS (owner decision 2), and a sales
 *     return reverses cost of sales anyway;
 *   - debit note → INVENTORY_REVALUATION: the stock left at the location's
 *     average, not at the cost typed on the note. The refund-versus-cost variance
 * stays on Sales Returns, measured against the document value as before.
 *
 * A reversal (edit, delete) moves exactly value_moved back; a legacy line
 * (value_moved NULL) falls back to quantity × inventory cost, the amount its
 * Inventory line carried.
 */
import type Decimal from "decimal.js";
import { sql } from "drizzle-orm";

import { voucherEntries } from "@shared/schema";

import type { DbTransaction } from "../../db";
import { HttpError } from "../../lib/httpHandlers";
import { adjustInventory } from "../../inventoryHelper";
import { MoneyDecimal, toMoney, type MoneyInput } from "../../lib/money";
import { firstRow } from "../../lib/queryResult";
import { systemAccountIdsTx } from "../accounting/perpetualInventory/linkedJournal";
import { lineValueMoved, restoreIssuedValueTx, reverseReceivedValueTx } from "./valueExactReversal";

export type NoteType = "Credit Note" | "Debit Note";

export const CREDIT_NOTE_ZERO_COST_MESSAGE =
  "This item has no stock cost at this location: enter its inventory cost before taking it back.";

export interface NoteLineMovement {
  /** Signed change of the sub-ledger value. */
  delta: Decimal;
  /** Value moved, positive: the line's value_moved. */
  valueMoved: Decimal;
}

/** Moves one note line's stock. */
export async function applyNoteLineInventoryTx(
  tx: DbTransaction,
  params: {
    companyId: number;
    noteType: NoteType;
    voucherId: number;
    locationId: number;
    stockItemId: number;
    quantity: MoneyInput;
    inventoryCost: MoneyInput;
  }
): Promise<NoteLineMovement> {
  const quantity = toMoney(params.quantity).abs();
  const cost = toMoney(params.inventoryCost);
  let incomingRate: number | undefined;
  if (params.noteType === "Credit Note") {
    if (cost.gt(0)) {
      incomingRate = cost.toNumber();
    } else {
      const row = firstRow<{ average_rate: string }>(
        await tx.execute(sql`
          SELECT average_rate::text AS average_rate FROM inventory
           WHERE company_id = ${params.companyId} AND location_id = ${params.locationId}
             AND stock_item_id = ${params.stockItemId}
        `)
      );
      if (!toMoney(row?.average_rate).gt(0)) throw new HttpError(400, CREDIT_NOTE_ZERO_COST_MESSAGE);
    }
  }
  const moved = await adjustInventory(
    tx,
    params.locationId,
    params.stockItemId,
    (params.noteType === "Credit Note" ? quantity : quantity.negated()).toNumber(),
    params.companyId,
    incomingRate,
    params.noteType,
    params.voucherId
  );
  const delta = toMoney(moved.valueDelta);
  return { delta, valueMoved: delta.abs() };
}

/** Moves an existing line's stock back exactly; returns the signed sub-ledger change. */
export async function reverseNoteLineInventoryTx(
  tx: DbTransaction,
  params: {
    companyId: number;
    noteType: NoteType;
    voucherId: number;
    line: {
      locationId: number;
      stockItemId: number;
      quantity: MoneyInput;
      inventoryCost: MoneyInput;
      valueMoved: MoneyInput;
    };
  }
): Promise<Decimal> {
  const { line } = params;
  const value = lineValueMoved({
    valueMoved: line.valueMoved,
    total: toMoney(line.quantity).abs().times(toMoney(line.inventoryCost)),
  });
  const reversal = {
    companyId: params.companyId,
    locationId: line.locationId,
    stockItemId: line.stockItemId,
    quantity: line.quantity,
    value,
    sourceVoucherType: `${params.noteType} reversal`,
    sourceVoucherId: params.voucherId,
  };
  return params.noteType === "Credit Note" ? reverseReceivedValueTx(tx, reversal) : restoreIssuedValueTx(tx, reversal);
}

/**
 * Posts the revaluation line of a note: the document value (Σ quantity ×
 * inventory cost) minus what the sub-ledger moved, on the side that balances
 * the note's Inventory lines. Nothing for a zero difference.
 */
export async function postNoteRevaluationTx(
  tx: DbTransaction,
  params: {
    companyId: number;
    noteType: NoteType;
    voucherId: number;
    documentValue: Decimal;
    subLedgerValue: Decimal;
    entryAmounts: (debit: Decimal.Value, credit: Decimal.Value) => Record<string, string>;
  }
): Promise<void> {
  const difference = params.documentValue.minus(params.subLedgerValue).toDecimalPlaces(2);
  if (difference.isZero()) return;
  const code = params.noteType === "Credit Note" ? "COGS" : "INVENTORY_REVALUATION";
  const accountId = (await systemAccountIdsTx(tx, params.companyId, [code])).get(code)!;
  const zero = new MoneyDecimal(0);
  // A credit note debits Inventory: a shortfall of the sub-ledger is a debit
  // here; a debit note credits Inventory: a shortfall is a credit here.
  const debitSide = params.noteType === "Credit Note" ? difference.isPositive() : difference.isNegative();
  await tx.insert(voucherEntries).values({
    voucherId: params.voucherId,
    ledgerAccountId: accountId,
    ...params.entryAmounts(debitSide ? difference.abs() : zero, debitSide ? zero : difference.abs()),
    narration: `Stock value difference - ${params.noteType}`,
  });
}
