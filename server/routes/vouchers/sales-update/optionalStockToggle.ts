/**
 * The stock side of suspending (optional) or activating a voucher (wave 11).
 *
 * Suspending moves each stock document back exactly the value its lines moved
 * (value_moved; legacy lines fall back as valueExactReversal documents);
 * activating moves the stock again and records the new value_moved:
 *   - stock transfer: the destination receives exactly what the source relieved;
 *   - stock adjustment: production received at the line's rate, consumption
 *     issued at the location's average;
 *   - sale: the issue's relieved value per line, and the COGS journal from it;
 *   - credit / debit note: as the note's own create path.
 *
 * The canonical stock-movement rows keep their pre-wave-11 source types and
 * idempotency keys. The caller updates the voucher's flag and re-syncs its
 * linked journals; `postOptionalToggleResidualTx` then posts whatever the
 * ledger's Inventory did not move with the sub-ledger.
 */
import type Decimal from "decimal.js";
import { eq, sql } from "drizzle-orm";

import { creditNoteItems, salesItems } from "@shared/schema";

import type { DbTransaction } from "../../../db";
import { adjustInventory } from "../../../inventoryHelper";
import { firstRow } from "../../../lib/queryResult";
import { HttpError } from "../../../lib/httpHandlers";
import { restorePosSaleInventoryForReversal } from "../../../services/pos/edit/reverseOriginalSaleInventory";
import { MoneyDecimal, toMoney } from "../../../lib/money";
import {
  postSaleCogsTx,
  relievedValue,
  removeSaleCogsTx,
} from "../../../services/accounting/perpetualInventory/saleCogs";
import {
  applyNoteLineInventoryTx,
  reverseNoteLineInventoryTx,
  type NoteType,
} from "../../../services/inventory/creditNoteInventory";
import {
  inventoryLedgerNetTx,
  postReversalResidualTx,
  saleCogsInventoryCreditTx,
  saleLineValuesTx,
  sumDecimals,
} from "../../../services/inventory/valueExactReversal";
import { toggleVoucherStockTxPart1, type OptionalToggleVoucher, type ToggleContext } from "./toggleVoucherStockTxPart1";
export type { OptionalToggleVoucher } from "./toggleVoucherStockTxPart1";

/** The ledger's Inventory carried by the voucher and its COGS journal (debit positive). */
export async function voucherInventoryLedgerTx(tx: DbTransaction, voucher: OptionalToggleVoucher): Promise<Decimal> {
  const own = await inventoryLedgerNetTx(tx, voucher.companyId, [voucher.id]);
  return own.minus(await saleCogsInventoryCreditTx(tx, voucher.companyId, voucher.id));
}

/** Moves the voucher's stock for the toggle; returns the signed sub-ledger changes. */
export async function toggleVoucherStockTx(tx: DbTransaction, context: ToggleContext): Promise<Decimal[]> {
  const { voucher, willBeOptional, companyId, deltas, movement, rateOf, saleItems } = await toggleVoucherStockTxPart1(
    tx,
    context
  );
  if (saleItems.length > 0) {
    if (!voucher.locationId) {
      throw new HttpError(409, "Cannot change a stocked POS sale without its original stock location");
    }

    // Reactivation must not quietly oversell stock that was sold after the
    // voucher became optional. Lock every affected row in a stable order,
    // checking the combined quantity for repeated item lines before issuing
    // ANY stock. The transaction keeps these row locks until commit.
    if (!willBeOptional) {
      const requiredByItem = new Map<number, Decimal>();
      for (const item of saleItems) {
        requiredByItem.set(
          item.stockItemId,
          (requiredByItem.get(item.stockItemId) ?? new MoneyDecimal(0)).plus(toMoney(item.quantity).abs())
        );
      }
      for (const [stockItemId, required] of [...requiredByItem.entries()].sort((a, b) => a[0] - b[0])) {
        const current = firstRow<{ quantity: string | number | null }>(
          await tx.execute(sql`
            SELECT quantity::text AS quantity
            FROM inventory
            WHERE company_id = ${companyId}
              AND location_id = ${voucher.locationId}
              AND stock_item_id = ${stockItemId}
            FOR UPDATE
          `)
        );
        if (!current || toMoney(current.quantity).lt(required)) {
          throw new HttpError(
            409,
            `Cannot reactivate POS ${voucher.voucherNumber}: insufficient stock at the original location for item ${stockItemId} (required ${required.toString()}, available ${current?.quantity ?? "0"}).`
          );
        }
      }
    }

    let saleRelieved = new MoneyDecimal(0);
    if (voucher.locationId) {
      const values = willBeOptional ? await saleLineValuesTx(tx, companyId, voucher.id, saleItems) : null;
      for (const item of saleItems) {
        const quantity = toMoney(item.quantity).abs();
        let value: Decimal;
        if (values) {
          const entry = values.get(item.id);
          value = entry?.value ?? new MoneyDecimal(0);
          // Use the POS reversal path to release only negative-stock shortage
          // layers actually resolved by this sale. A generic stock receipt
          // would consume unrelated historical layers and corrupt valuation.
          const restored = await restorePosSaleInventoryForReversal(tx, {
            companyId,
            locationId: voucher.locationId,
            stockItemId: item.stockItemId,
            quantity: quantity.toNumber(),
            voucherId: voucher.id,
            value,
            exact: entry?.exact,
          });
          deltas.push(toMoney(restored.newTotalValue).minus(toMoney(restored.previousTotalValue)));
        } else {
          const issued = await adjustInventory(
            tx,
            voucher.locationId,
            item.stockItemId,
            quantity.negated().toNumber(),
            companyId,
            undefined,
            "pos-sale",
            voucher.id
          );
          value = relievedValue(issued);
          saleRelieved = saleRelieved.plus(value);
          deltas.push(toMoney(issued.valueDelta));
          await tx
            .update(salesItems)
            .set({ valueMoved: value.toFixed(2) })
            .where(eq(salesItems.id, item.id));
        }
        await movement({
          stockItemId: item.stockItemId,
          kind: "adjustment",
          quantity,
          unitCost: toMoney(item.costPrice),
          fromLocationId: willBeOptional ? undefined : voucher.locationId,
          toLocationId: willBeOptional ? voucher.locationId : undefined,
          sourceType: "voucher-optional-toggle-sale",
          keySuffix: `sale:${item.id}`,
        });
      }
    }
    // Perpetual inventory (wave 8.1): an optional sale holds no stock, so it
    // has no COGS; activating it posts the exact value it takes out again.
    if (willBeOptional) {
      await removeSaleCogsTx(tx, companyId, voucher.id);
    } else {
      await postSaleCogsTx(tx, {
        companyId,
        saleVoucherId: voucher.id,
        saleVoucherNumber: voucher.voucherNumber,
        voucherDate: voucher.voucherDate,
        locationId: voucher.locationId,
        relieved: saleRelieved,
      });
    }
  }

  if (voucher.voucherType === "Credit Note" || voucher.voucherType === "Debit Note") {
    const noteType: NoteType = voucher.voucherType;
    const noteItems = await tx.select().from(creditNoteItems).where(eq(creditNoteItems.voucherId, voucher.id));
    for (const item of noteItems) {
      const quantity = toMoney(item.quantity).abs();
      let delta: Decimal;
      if (willBeOptional) {
        delta = await reverseNoteLineInventoryTx(tx, { companyId, noteType, voucherId: voucher.id, line: item });
      } else {
        const moved = await applyNoteLineInventoryTx(tx, {
          companyId,
          noteType,
          voucherId: voucher.id,
          locationId: item.locationId,
          stockItemId: item.stockItemId,
          quantity,
          inventoryCost: item.inventoryCost,
        });
        delta = moved.delta;
        await tx
          .update(creditNoteItems)
          .set({ valueMoved: moved.valueMoved.toFixed(2) })
          .where(eq(creditNoteItems.id, item.id));
      }
      deltas.push(delta);
      const received = delta.isPositive();
      await movement({
        stockItemId: item.stockItemId,
        kind: "adjustment",
        quantity,
        unitCost: rateOf(delta.abs(), quantity),
        fromLocationId: received ? undefined : item.locationId,
        toLocationId: received ? item.locationId : undefined,
        sourceType: "voucher-optional-toggle-credit-note",
        keySuffix: `credit-note:${item.id}`,
      });
    }
  }
  return deltas;
}

/** Posts what the toggle moved in the sub-ledger beyond the ledger's own change. */
export async function postOptionalToggleResidualTx(
  tx: DbTransaction,
  params: {
    voucher: OptionalToggleVoucher;
    evidenceRevision: number;
    deltas: readonly Decimal[];
    ledgerBefore: Decimal;
    actor: { userId: string; username: string } | null;
  }
): Promise<void> {
  const ledgerAfter = await voucherInventoryLedgerTx(tx, params.voucher);
  await postReversalResidualTx(tx, {
    companyId: params.voucher.companyId,
    sourceType: "optional-toggle",
    sourceId: `${params.voucher.id}:r${params.evidenceRevision}`,
    reference: params.voucher.voucherNumber,
    subLedgerDelta: sumDecimals(params.deltas),
    ledgerDelta: ledgerAfter.minus(params.ledgerBefore),
    actor: params.actor,
    locationId: params.voucher.locationId,
  });
}
