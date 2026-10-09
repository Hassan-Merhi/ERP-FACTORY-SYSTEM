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
import { eq } from "drizzle-orm";

import {
  creditNoteItems,
  salesItems,
  stockAdjustmentItems,
  stockAdjustmentVouchers,
  stockTransferItems,
  stockTransferVouchers,
} from "@shared/schema";

import type { DbTransaction } from "../../../db";
import { adjustInventory } from "../../../inventoryHelper";
import { MoneyDecimal, toMoney } from "../../../lib/money";
import { assertNoBaleMirrorMovementTx } from "../../../services/accounting/perpetualInventory/cutoverRefusal";
import {
  postSaleCogsTx,
  relievedValue,
  removeSaleCogsTx,
} from "../../../services/accounting/perpetualInventory/saleCogs";
import {
  moveTransferLegConservedTx,
  recordTransferValueMovedTx,
  reverseTransferLegExactTx,
} from "../../../services/inventory/conservedStockTransfer";
import {
  applyNoteLineInventoryTx,
  reverseNoteLineInventoryTx,
  type NoteType,
} from "../../../services/inventory/creditNoteInventory";
import { createDatabaseStockMovementAdapter } from "../../../services/inventory/databaseStockMovementAdapter";
import { postStockMovementTx } from "../../../services/inventory/stockMovementIntegrityService";
import {
  inventoryLedgerNetTx,
  lineValueMoved,
  postReversalResidualTx,
  restoreIssuedValueTx,
  reverseReceivedValueTx,
  saleCogsInventoryCreditTx,
  saleLineValuesTx,
  sumDecimals,
} from "../../../services/inventory/valueExactReversal";

const canonicalStockMovementAdapter = createDatabaseStockMovementAdapter();

export interface OptionalToggleVoucher {
  id: number;
  companyId: number;
  voucherNumber: string;
  voucherDate: string;
  voucherType: string;
  locationId: number | null;
}

interface ToggleContext {
  voucher: OptionalToggleVoucher;
  willBeOptional: boolean;
  evidenceRevision: number;
  occurredAt: string;
  evidenceActor: { userId?: string; username?: string; reason: string };
}

/** The ledger's Inventory carried by the voucher and its COGS journal (debit positive). */
export async function voucherInventoryLedgerTx(tx: DbTransaction, voucher: OptionalToggleVoucher): Promise<Decimal> {
  const own = await inventoryLedgerNetTx(tx, voucher.companyId, [voucher.id]);
  return own.minus(await saleCogsInventoryCreditTx(tx, voucher.companyId, voucher.id));
}

/** Moves the voucher's stock for the toggle; returns the signed sub-ledger changes. */
export async function toggleVoucherStockTx(tx: DbTransaction, context: ToggleContext): Promise<Decimal[]> {
  const { voucher, willBeOptional, evidenceRevision, occurredAt, evidenceActor } = context;
  const companyId = voucher.companyId;
  const deltas: Decimal[] = [];
  const movement = async (params: {
    stockItemId: number;
    kind: "transfer" | "adjustment";
    quantity: Decimal;
    unitCost: Decimal;
    fromLocationId?: number;
    toLocationId?: number;
    sourceType: string;
    keySuffix: string;
  }) => {
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
        occurredAt,
        source: {
          sourceType: params.sourceType,
          sourceId: String(voucher.id),
          idempotencyKey: `voucher-optional:rev${evidenceRevision}:${params.keySuffix}`,
        },
        actor: evidenceActor,
        allowNegativeStock: true,
      },
      canonicalStockMovementAdapter
    );
  };
  const rateOf = (value: Decimal, quantity: Decimal) =>
    quantity.isZero() ? new MoneyDecimal(0) : value.dividedBy(quantity.abs());

  const [transfer] = await tx
    .select()
    .from(stockTransferVouchers)
    .where(eq(stockTransferVouchers.voucherId, voucher.id))
    .limit(1);
  if (!willBeOptional) {
    // Wave 15 (wave 11 follow-up): activating a sale or transfer moves its
    // stock, so a factory bale-mirror item is refused after the cut-over like
    // every other ERP sale and transfer path.
    const transferItemIds = transfer
      ? (await tx.select().from(stockTransferItems).where(eq(stockTransferItems.transferId, transfer.id))).map(
          (item) => item.stockItemId
        )
      : [];
    const saleItemIds = (await tx.select().from(salesItems).where(eq(salesItems.voucherId, voucher.id))).map(
      (item) => item.stockItemId
    );
    await assertNoBaleMirrorMovementTx(tx, companyId, transferItemIds, "stock-transfer-activate");
    await assertNoBaleMirrorMovementTx(tx, companyId, saleItemIds, "optional-sale-activate");
  }
  if (transfer) {
    const items = await tx.select().from(stockTransferItems).where(eq(stockTransferItems.transferId, transfer.id));
    const relievedByGroup = new Map<string, Decimal>();
    for (const item of items) {
      const sourceLocationId = item.sourceLocationId ?? transfer.sourceLocationId;
      const destinationLocationId = transfer.destinationLocationId;
      if (sourceLocationId == null || destinationLocationId == null) {
        throw new Error("Stock transfer is missing source or destination location");
      }
      const quantity = toMoney(item.quantity).abs();
      // Guard on inventoryApplied: only reverse what was applied, only apply what was not.
      if (willBeOptional && transfer.inventoryApplied) {
        const value = lineValueMoved({ valueMoved: item.valueMoved, total: item.totalAmount });
        const reversed = await reverseTransferLegExactTx(tx, {
          companyId,
          sourceLocationId,
          destinationLocationId,
          stockItemId: item.stockItemId,
          quantity,
          value,
        });
        deltas.push(reversed.sourceDelta, reversed.destinationDelta);
        await movement({
          stockItemId: item.stockItemId,
          kind: "transfer",
          quantity,
          unitCost: rateOf(value, quantity),
          fromLocationId: destinationLocationId,
          toLocationId: sourceLocationId,
          sourceType: "voucher-optional-toggle-transfer-reverse",
          keySuffix: `transfer-reverse:${item.id}`,
        });
      } else if (!willBeOptional && !transfer.inventoryApplied) {
        const moved = await moveTransferLegConservedTx(tx, {
          companyId,
          sourceLocationId,
          destinationLocationId,
          stockItemId: item.stockItemId,
          quantity,
          fallbackRate: item.rate,
        });
        const key = `${sourceLocationId}:${item.stockItemId}`;
        relievedByGroup.set(key, (relievedByGroup.get(key) ?? new MoneyDecimal(0)).plus(moved.relieved));
        deltas.push(moved.sourceDelta, moved.destinationDelta);
        await movement({
          stockItemId: item.stockItemId,
          kind: "transfer",
          quantity,
          unitCost: moved.rate,
          fromLocationId: sourceLocationId,
          toLocationId: destinationLocationId,
          sourceType: "voucher-optional-toggle-transfer-apply",
          keySuffix: `transfer-apply:${item.id}`,
        });
      }
    }
    if (relievedByGroup.size > 0) {
      await recordTransferValueMovedTx(tx, transfer.id, relievedByGroup, transfer.sourceLocationId);
    }
    // A later updateStockTransfer must know the applied state.
    await tx
      .update(stockTransferVouchers)
      .set({ inventoryApplied: !willBeOptional })
      .where(eq(stockTransferVouchers.id, transfer.id));
  }

  const [adjustment] = await tx
    .select()
    .from(stockAdjustmentVouchers)
    .where(eq(stockAdjustmentVouchers.voucherId, voucher.id))
    .limit(1);
  if (adjustment) {
    const items = await tx
      .select()
      .from(stockAdjustmentItems)
      .where(eq(stockAdjustmentItems.adjustmentId, adjustment.id));
    const type = (adjustment.adjustmentType || "").trim().toLowerCase();
    for (const item of items) {
      const signed = toMoney(item.quantity);
      const quantity = signed.abs();
      const isProduction = type === "production" || (type === "mixed" && signed.isPositive());
      let outgoing: boolean;
      let unitCost: Decimal;
      if (willBeOptional) {
        const value = lineValueMoved({ valueMoved: item.valueMoved, total: item.totalAmount });
        const reversal = {
          companyId,
          locationId: adjustment.locationId,
          stockItemId: item.stockItemId,
          quantity,
          value,
        };
        deltas.push(
          isProduction ? await reverseReceivedValueTx(tx, reversal) : await restoreIssuedValueTx(tx, reversal)
        );
        outgoing = isProduction;
        unitCost = rateOf(value, quantity);
      } else {
        const moved = await adjustInventory(
          tx,
          adjustment.locationId,
          item.stockItemId,
          (isProduction ? quantity : quantity.negated()).toNumber(),
          companyId,
          isProduction ? toMoney(item.rate).toNumber() : undefined
        );
        const delta = toMoney(moved.valueDelta);
        deltas.push(delta);
        await tx
          .update(stockAdjustmentItems)
          .set({ valueMoved: delta.abs().toFixed(2) })
          .where(eq(stockAdjustmentItems.id, item.id));
        outgoing = !isProduction;
        unitCost = rateOf(delta.abs(), quantity);
      }
      await movement({
        stockItemId: item.stockItemId,
        kind: "adjustment",
        quantity,
        unitCost,
        fromLocationId: outgoing ? adjustment.locationId : undefined,
        toLocationId: outgoing ? undefined : adjustment.locationId,
        sourceType: "voucher-optional-toggle-adjustment",
        keySuffix: `adjustment:${item.id}`,
      });
    }
  }

  const saleItems = await tx.select().from(salesItems).where(eq(salesItems.voucherId, voucher.id));
  if (saleItems.length > 0) {
    let saleRelieved = new MoneyDecimal(0);
    if (voucher.locationId) {
      const values = willBeOptional ? await saleLineValuesTx(tx, companyId, voucher.id, saleItems) : null;
      for (const item of saleItems) {
        const quantity = toMoney(item.quantity).abs();
        let value: Decimal;
        if (values) {
          const entry = values.get(item.id);
          value = entry?.value ?? new MoneyDecimal(0);
          deltas.push(
            await restoreIssuedValueTx(tx, {
              companyId,
              locationId: voucher.locationId,
              stockItemId: item.stockItemId,
              quantity,
              value,
              exact: entry?.exact,
            })
          );
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
