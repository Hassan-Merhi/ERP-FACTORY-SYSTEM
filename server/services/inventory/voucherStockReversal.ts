/**
 * The stock side of deleting a voucher (wave 11), shared by the single delete
 * (DELETE /api/vouchers/:id), the bulk delete and storage.deleteVoucher.
 *
 * Each stock document moves back exactly the value its lines moved
 * (value_moved; legacy lines fall back as valueExactReversal documents):
 *   - stock transfer: the destination gives back the value, the source takes it;
 *   - stock adjustment (Production, Consumption, Mixed, Stock Adjustment):
 *     production lines leave, consumption lines come back;
 *   - sale (Receipt / Sales with sales items): the sold stock comes back with
 *     the value it relieved, and the sale's COGS journal is removed;
 *   - credit note / debit note: received stock leaves, issued stock comes back.
 *
 * The document rows (items and headers) are deleted here; the caller soft- or
 * hard-deletes the voucher itself. The ledger's own reversal (the voucher's
 * Inventory line leaving with it, the COGS journal removed) and the measured
 * sub-ledger change are compared, and any difference is posted as an INV-MOVE
 * reversal-difference journal (a no-op before the cut-over).
 */
import type Decimal from "decimal.js";
import { eq, sql } from "drizzle-orm";

import { creditNoteItems } from "@shared/schema";

import type { DbTransaction } from "../../db";
import { toMoney } from "../../lib/money";
import { isStockAdjustmentVoucherType } from "../accounting/stockVoucherTypes";
import { reverseNoteLineInventoryTx } from "./creditNoteInventory";
import { firstRow } from "../../lib/queryResult";
import { postReversalResidualTx, sumDecimals } from "./valueExactReversal";
import {
  reverseVoucherStockTxPart1,
  TRANSFER_TYPES,
  type VoucherStockReversalInput,
} from "./reverseVoucherStockTxPart1";
export { TRANSFER_LOCATION_MISSING_MESSAGE, type VoucherStockReversalInput } from "./reverseVoucherStockTxPart1";

export interface VoucherStockReversalResult {
  /** Signed change of the stock sub-ledger value. */
  subLedgerDelta: Decimal;
  /** Signed change of the ledger's Inventory account. */
  ledgerDelta: Decimal;
}

/** Reverses the voucher's stock (see the module comment) in the caller's transaction. */
export async function reverseVoucherStockTx(
  tx: DbTransaction,
  input: VoucherStockReversalInput
): Promise<VoucherStockReversalResult> {
  const { voucher, companyId, deltas, ledgerDelta, movement, rateOf } = await reverseVoucherStockTxPart1(tx, input);

  if ((voucher.voucherType === "Credit Note" || voucher.voucherType === "Debit Note") && !voucher.optional) {
    const lines = await tx.select().from(creditNoteItems).where(eq(creditNoteItems.voucherId, voucher.id));
    for (const line of lines) {
      const quantity = toMoney(line.quantity).abs();
      const credit = voucher.voucherType === "Credit Note";
      const delta = await reverseNoteLineInventoryTx(tx, {
        companyId,
        noteType: voucher.voucherType,
        voucherId: voucher.id,
        line,
      });
      deltas.push(delta);
      await movement({
        stockItemId: line.stockItemId,
        quantity,
        unitCost: rateOf(delta.abs(), quantity),
        fromLocationId: credit ? line.locationId : undefined,
        toLocationId: credit ? undefined : line.locationId,
        kind: "adjustment",
        sourceSuffix: credit ? "credit_note" : "debit_note",
        keySuffix: credit ? "credit-note" : "debit-note",
        lineId: line.id,
      });
    }
    if (lines.length > 0) await tx.delete(creditNoteItems).where(eq(creditNoteItems.voucherId, voucher.id));
  }

  const subLedgerDelta = sumDecimals(deltas);
  await postReversalResidualTx(tx, {
    companyId,
    sourceType: "voucher-delete",
    sourceId: voucher.id,
    reference: voucher.voucherNumber,
    subLedgerDelta,
    ledgerDelta,
    actor:
      input.actor?.userId && input.actor.username
        ? { userId: input.actor.userId, username: input.actor.username }
        : null,
    locationId: voucher.locationId,
  });
  return { subLedgerDelta, ledgerDelta };
}

// ── Restoring a deleted stock document (wave 15, C2) ─────────────────────────
//
// Deleting a stock document deletes its document rows (above) after moving
// its stock back. Restoring the voucher alone would put its ledger lines back
// (revenue, the stock adjustment line, a credit note's lines) with no stock
// movement and no COGS: the sub-ledger and the ledger would disagree, and the
// stock it moved would be gone from the document. Choice (owner rule "never
// change stored history", the safer of the two options): such a voucher is
// not restorable; it is refused with 409 STOCK_DOCUMENT_NOT_RESTORABLE and the
// user re-enters the document. Keeping the rows on delete and replaying them
// on restore was rejected: every stock reader would have to learn to skip the
// rows of a deleted voucher, and a replay at today's costs is not the
// original movement.
//
// A stock document is recognised by its type: a transfer or stock adjustment
// voucher always has its header row, so a missing header means it was
// deleted; a sale (Receipt/Sales) or credit/debit note with no lines is refused
// when the canonical stock journal shows its delete moved stock back (a sale
// or note that never had stock lines stays restorable). A legacy delete made
// before the canonical journal existed leaves no such evidence and is not
// detected.

export const STOCK_DOCUMENT_NOT_RESTORABLE = "STOCK_DOCUMENT_NOT_RESTORABLE" as const;
export const STOCK_DOCUMENT_NOT_RESTORABLE_MESSAGE =
  "This stock document cannot be restored: its stock lines were reversed and removed when it was deleted. Enter the document again instead.";

const DELETE_SOURCE_PREFIXES = ["voucher_delete", "bulk_voucher_delete", "storage_voucher_delete"];
const DELETE_SOURCE_SUFFIXES = ["pos_sale", "credit_note", "debit_note", "stock_transfer", "stock_adjustment"];
const DELETE_SOURCE_TYPES = DELETE_SOURCE_PREFIXES.flatMap((prefix) =>
  DELETE_SOURCE_SUFFIXES.map((suffix) => `${prefix}_${suffix}`)
);

async function exists(tx: DbTransaction, query: ReturnType<typeof sql>): Promise<boolean> {
  return firstRow<{ found: boolean }>(await tx.execute(sql`SELECT EXISTS (${query}) AS found`))?.found === true;
}

/**
 * True when the deleted voucher is a stock document whose rows its delete
 * removed (see above), so restoring it is refused.
 */
export async function isUnrestorableStockDocumentTx(
  tx: DbTransaction,
  companyId: number,
  voucher: { id: number; voucherType: string }
): Promise<boolean> {
  if (TRANSFER_TYPES.has(voucher.voucherType)) {
    return !(await exists(tx, sql`SELECT 1 FROM stock_transfer_vouchers WHERE voucher_id = ${voucher.id}`));
  }
  if (isStockAdjustmentVoucherType(voucher.voucherType)) {
    return !(await exists(tx, sql`SELECT 1 FROM stock_adjustment_vouchers WHERE voucher_id = ${voucher.id}`));
  }
  const sale = voucher.voucherType === "Receipt" || voucher.voucherType === "Sales";
  const note = voucher.voucherType === "Credit Note" || voucher.voucherType === "Debit Note";
  if (!sale && !note) return false;
  const lines = sale
    ? sql`SELECT 1 FROM sales_items WHERE voucher_id = ${voucher.id}`
    : sql`SELECT 1 FROM credit_note_items WHERE voucher_id = ${voucher.id}`;
  if (await exists(tx, lines)) return false;
  return exists(
    tx,
    sql`SELECT 1 FROM canonical_stock_movements
         WHERE company_id = ${companyId} AND source_id = ${String(voucher.id)}
           AND source_type IN (${sql.join(
             DELETE_SOURCE_TYPES.map((type) => sql`${type}`),
             sql`, `
           )})`
  );
}
