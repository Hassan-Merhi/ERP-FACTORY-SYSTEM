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

import {
  creditNoteItems,
  salesItems,
  stockAdjustmentItems,
  stockAdjustmentVouchers,
  stockTransferItems,
  stockTransferVouchers,
} from "@shared/schema";

import type { DbTransaction } from "../../db";
import { logger } from "../../lib/logger";
import { MoneyDecimal, toMoney } from "../../lib/money";
import { removeSaleCogsTx } from "../accounting/perpetualInventory/saleCogs";
import { STOCK_ADJUSTMENT_VOUCHER_TYPES } from "../accounting/perpetualInventory/stockAdjustments";
import { reverseTransferLegExactTx } from "./conservedStockTransfer";
import { isStockAdjustmentVoucherType } from "../accounting/stockVoucherTypes";
import { createDatabaseStockMovementAdapter } from "./databaseStockMovementAdapter";
import { reverseNoteLineInventoryTx } from "./creditNoteInventory";
import { postStockMovementTx } from "./stockMovementIntegrityService";
import { firstRow } from "../../lib/queryResult";
import {
  inventoryLedgerNetTx,
  postReversalResidualTx,
  restoreIssuedValueTx,
  reverseReceivedValueTx,
  saleCogsInventoryCreditTx,
  saleLineValuesTx,
  sumDecimals,
} from "./valueExactReversal";

const canonicalStockMovementAdapter = createDatabaseStockMovementAdapter();

export const TRANSFER_LOCATION_MISSING_MESSAGE =
  "This stock transfer cannot be reversed: its source or destination location is missing.";

const TRANSFER_TYPES = new Set(["Stock Transfer", "StockTransfer", "Transfer"]);

export interface VoucherStockReversalInput {
  companyId: number;
  voucher: {
    id: number;
    voucherType: string;
    voucherNumber: string;
    optional: boolean | null;
    locationId: number | null;
  };
  occurredAt: string;
  actor?: { userId?: string | null; username?: string | null; reason: string };
  /**
   * Prefixes of the canonical stock-movement source type and idempotency key,
   * e.g. "voucher_delete" / "voucher-delete": the movement rows read
   * `${sourcePrefix}_pos_sale` and `${keyPrefix}:pos:{company}:{voucher}:{line}`.
   */
  sourcePrefix: string;
  keyPrefix: string;
}

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
  const { companyId, voucher } = input;
  const deltas: Decimal[] = [];
  // The voucher's own Inventory lines leave the ledger with it.
  let ledgerDelta = (await inventoryLedgerNetTx(tx, companyId, [voucher.id])).negated();
  const actor = input.actor
    ? {
        userId: input.actor.userId ?? undefined,
        username: input.actor.username ?? undefined,
        reason: input.actor.reason,
      }
    : undefined;
  const movement = async (params: {
    stockItemId: number;
    quantity: Decimal;
    unitCost: Decimal;
    fromLocationId?: number;
    toLocationId?: number;
    kind: "transfer" | "adjustment";
    sourceSuffix: string;
    keySuffix: string;
    lineId: number;
  }) => {
    if (params.quantity.isZero()) return;
    await postStockMovementTx(
      tx,
      {
        companyId,
        stockItemId: params.stockItemId,
        kind: params.kind,
        quantity: params.quantity.abs().toString(),
        unitCost: (params.unitCost.isNegative() ? new MoneyDecimal(0) : params.unitCost).toString(),
        fromLocationId: params.fromLocationId,
        toLocationId: params.toLocationId,
        occurredAt: input.occurredAt,
        source: {
          sourceType: `${input.sourcePrefix}_${params.sourceSuffix}`,
          sourceId: String(voucher.id),
          idempotencyKey: `${input.keyPrefix}:${params.keySuffix}:${companyId}:${voucher.id}:${params.lineId}`,
        },
        actor,
        allowNegativeStock: true,
      },
      canonicalStockMovementAdapter
    );
  };
  const rateOf = (value: Decimal, quantity: Decimal) =>
    quantity.isZero() ? new MoneyDecimal(0) : value.dividedBy(quantity.abs());

  if (TRANSFER_TYPES.has(voucher.voucherType)) {
    const [transfer] = await tx
      .select()
      .from(stockTransferVouchers)
      .where(eq(stockTransferVouchers.voucherId, voucher.id))
      .limit(1);
    if (transfer && (transfer.inventoryApplied || !voucher.optional)) {
      const lines = await tx.select().from(stockTransferItems).where(eq(stockTransferItems.transferId, transfer.id));
      for (const line of lines) {
        const sourceLocationId = line.sourceLocationId ?? transfer.sourceLocationId;
        if (!sourceLocationId || !transfer.destinationLocationId) {
          throw new Error(TRANSFER_LOCATION_MISSING_MESSAGE);
        }
        const quantity = toMoney(line.quantity).abs();
        const value = toMoney(line.valueMoved ?? line.totalAmount).abs();
        const reversed = await reverseTransferLegExactTx(tx, {
          companyId,
          sourceLocationId,
          destinationLocationId: transfer.destinationLocationId,
          stockItemId: line.stockItemId,
          quantity,
          value,
          sourceVoucherType: "StockTransfer-Reversal",
          sourceVoucherId: voucher.id,
        });
        deltas.push(reversed.sourceDelta, reversed.destinationDelta);
        await movement({
          stockItemId: line.stockItemId,
          quantity,
          unitCost: rateOf(value, quantity),
          fromLocationId: transfer.destinationLocationId,
          toLocationId: sourceLocationId,
          kind: "transfer",
          sourceSuffix: "stock_transfer",
          keySuffix: "transfer",
          lineId: line.id,
        });
      }
    }
    if (transfer) {
      await tx.delete(stockTransferItems).where(eq(stockTransferItems.transferId, transfer.id));
      await tx.delete(stockTransferVouchers).where(eq(stockTransferVouchers.id, transfer.id));
    }
  }

  if (STOCK_ADJUSTMENT_VOUCHER_TYPES.has(voucher.voucherType) && !voucher.optional) {
    const [adjustment] = await tx
      .select()
      .from(stockAdjustmentVouchers)
      .where(eq(stockAdjustmentVouchers.voucherId, voucher.id))
      .limit(1);
    if (adjustment) {
      const lines = await tx
        .select()
        .from(stockAdjustmentItems)
        .where(eq(stockAdjustmentItems.adjustmentId, adjustment.id));
      // adjustment_type is stored in both casings (see bulk-delete history).
      const type = (adjustment.adjustmentType || "").trim().toLowerCase();
      for (const line of lines) {
        const signed = toMoney(line.quantity);
        const quantity = signed.abs();
        const production = type === "production" || (type === "mixed" && signed.isPositive());
        const value = toMoney(line.valueMoved ?? line.totalAmount).abs();
        const reversal = {
          companyId,
          locationId: adjustment.locationId,
          stockItemId: line.stockItemId,
          quantity,
          value,
          sourceVoucherType: `${adjustment.adjustmentType}-Reversal`,
          sourceVoucherId: voucher.id,
        };
        deltas.push(production ? await reverseReceivedValueTx(tx, reversal) : await restoreIssuedValueTx(tx, reversal));
        await movement({
          stockItemId: line.stockItemId,
          quantity,
          unitCost: rateOf(value, quantity),
          fromLocationId: production ? adjustment.locationId : undefined,
          toLocationId: production ? undefined : adjustment.locationId,
          kind: "adjustment",
          sourceSuffix: "stock_adjustment",
          keySuffix: "adjustment",
          lineId: line.id,
        });
      }
      await tx.delete(stockAdjustmentItems).where(eq(stockAdjustmentItems.adjustmentId, adjustment.id));
      await tx.delete(stockAdjustmentVouchers).where(eq(stockAdjustmentVouchers.id, adjustment.id));
    }
  }

  if (voucher.voucherType === "Receipt" || voucher.voucherType === "Sales") {
    if (!voucher.optional) {
      const lines = await tx.select().from(salesItems).where(eq(salesItems.voucherId, voucher.id));
      if (lines.length > 0) {
        if (voucher.locationId) {
          const values = await saleLineValuesTx(tx, companyId, voucher.id, lines);
          for (const line of lines) {
            const quantity = toMoney(line.quantity).abs();
            const entry = values.get(line.id);
            const value = entry?.value ?? new MoneyDecimal(0);
            deltas.push(
              await restoreIssuedValueTx(tx, {
                companyId,
                locationId: voucher.locationId,
                stockItemId: line.stockItemId,
                quantity,
                value,
                exact: entry?.exact,
              })
            );
            await movement({
              stockItemId: line.stockItemId,
              quantity,
              unitCost: rateOf(value, quantity),
              toLocationId: voucher.locationId,
              kind: "adjustment",
              sourceSuffix: "pos_sale",
              keySuffix: "pos",
              lineId: line.id,
            });
          }
        } else {
          logger.warn(`[Voucher delete] Voucher ${voucher.id}: cannot reverse inventory - no locationId on voucher`);
        }
        await tx.delete(salesItems).where(eq(salesItems.voucherId, voucher.id));
      }
    }
    // Perpetual inventory (wave 8.1): a deleted sale takes its COGS journal with it.
    ledgerDelta = ledgerDelta.plus(await saleCogsInventoryCreditTx(tx, companyId, voucher.id));
    await removeSaleCogsTx(tx, companyId, voucher.id);
  }

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
