// Extracted from ./transfers-update.ts to keep that module under the source-size cap.
import Decimal from "decimal.js";
import { eq } from "drizzle-orm";
import { db, type DbTransaction } from "../../db";
import { createDatabaseStockMovementAdapter } from "../../services/inventory/databaseStockMovementAdapter";
import { postStockMovementTx } from "../../services/inventory/stockMovementIntegrityService";
import { stockTransferNarrationTx } from "../../services/inventory/stockTransferNarration";
import {
  inventoryMoney,
  inventoryQuantity,
  inventoryUnitCost,
  multiplyInventoryValues,
  toInventoryDecimal,
} from "../../lib/inventoryMath";
import * as schema from "@shared/schema";
import { type StockAdjustmentItem, type StockTransferItem } from "@shared/schema";
import { lineValueMoved, reversalDate } from "../../services/inventory/valueExactReversal";
import {
  moveTransferLegConservedTx,
  postTransferResidualTx,
  reverseTransferLegExactTx,
} from "../../services/inventory/conservedStockTransfer";
import { assertNoBaleMirrorMovementTx } from "../../services/accounting/perpetualInventory/cutoverRefusal";

export const canonicalStockMovementAdapter = createDatabaseStockMovementAdapter();

export function isProductionAdjustment(adjustmentType: string, quantity: Decimal): boolean {
  const normalized = adjustmentType.trim().toLowerCase();
  return normalized === "production" || (normalized === "mixed" && quantity.isPositive());
}

export function sameDecimal(a: Decimal, b: Decimal): boolean {
  return a.equals(b);
}

export async function updateStockTransfer(
  id: number,
  destinationLocationId: number,
  notes: string,
  items: Array<{ sourceLocationId: number; stockItemId: number; quantity: string; rate: string }>,
  // Phase 21 (B): the caller's header update and audit, on this transaction.
  afterWriteTx?: (
    tx: DbTransaction,
    result: { transfer: schema.StockTransferVoucher; items: StockTransferItem[] }
  ) => Promise<void>
) {
  return await db.transaction(async (tx) => {
    const [existingTransfer] = await tx
      .select()
      .from(schema.stockTransferVouchers)
      .where(eq(schema.stockTransferVouchers.id, id));
    if (!existingTransfer) throw new Error(`Stock transfer ${id} not found`);

    const [voucher] = await tx.select().from(schema.vouchers).where(eq(schema.vouchers.id, existingTransfer.voucherId));
    if (!voucher) throw new Error(`Voucher ${existingTransfer.voucherId} not found`);
    const isOptional = voucher.optional;
    // Wave 11: a factory bale-mirror item is moved in the factory after the cut-over.
    if (!isOptional) {
      await assertNoBaleMirrorMovementTx(
        tx,
        voucher.companyId,
        items.map((item) => item.stockItemId),
        "stock-transfer-edit"
      );
    }

    const existingItems = await tx
      .select()
      .from(schema.stockTransferItems)
      .where(eq(schema.stockTransferItems.transferId, id));
    const itemsWithoutSource = existingItems.filter((item) => !item.sourceLocationId);
    if (itemsWithoutSource.length > 0) {
      throw new Error(
        `Cannot edit this stock transfer: ${itemsWithoutSource.length} items missing source location data.`
      );
    }

    // Signed sub-ledger changes of every leg of this edit; their net (normally
    // zero) is posted so the ledger keeps moving with the sub-ledger.
    const transferDeltas: Decimal[] = [];
    // A transfer edit is a reversal of the historical transfer followed by the
    // requested replacement. Reverse the exact stored quantity + value instead
    // of reconstructing either leg from today's rounded average rate.
    if (existingTransfer.inventoryApplied || !isOptional) {
      existingItems.sort((a, b) => a.stockItemId - b.stockItemId || a.id - b.id);
      for (const oldItem of existingItems) {
        const quantity = toInventoryDecimal(oldItem.quantity).abs();
        // Wave 11: the exact value the line moved (legacy lines: their total).
        const totalAmount = lineValueMoved({ valueMoved: oldItem.valueMoved, total: oldItem.totalAmount });
        const rate = quantity.gt(0) ? totalAmount.dividedBy(quantity) : toInventoryDecimal(oldItem.rate);
        const sourceLocationId = oldItem.sourceLocationId || existingTransfer.sourceLocationId;
        if (!sourceLocationId) {
          throw Object.assign(new Error(), {
            code: "STOCK_TRANSFER_SOURCE_LOCATION_MISSING",
            stockTransferItemId: oldItem.id,
          });
        }

        // Original transfer issued value from the source and received the same
        // value at the destination. Undo those exact effects in the opposite
        // direction. The restore path deliberately does not settle unrelated
        // negative-stock layers.
        const reversed = await reverseTransferLegExactTx(tx, {
          companyId: voucher.companyId,
          sourceLocationId,
          destinationLocationId: existingTransfer.destinationLocationId!,
          stockItemId: oldItem.stockItemId,
          quantity,
          value: totalAmount,
          sourceVoucherType: "stock_transfer_edit_reverse",
          sourceVoucherId: existingTransfer.voucherId,
        });
        transferDeltas.push(reversed.sourceDelta, reversed.destinationDelta);

        if (sourceLocationId !== existingTransfer.destinationLocationId) {
          await postStockMovementTx(
            tx,
            {
              companyId: voucher.companyId,
              stockItemId: oldItem.stockItemId,
              kind: "transfer",
              quantity: inventoryQuantity(quantity),
              unitCost: inventoryUnitCost(rate),
              fromLocationId: existingTransfer.destinationLocationId!,
              toLocationId: sourceLocationId,
              occurredAt: new Date().toISOString(),
              source: {
                sourceType: "stock_transfer_edit_reverse",
                sourceId: String(existingTransfer.voucherId),
                idempotencyKey: `stock-transfer-edit:reverse:${voucher.companyId}:${id}:${oldItem.id}`,
              },
              allowNegativeStock: true,
            },
            canonicalStockMovementAdapter
          );
        }
      }
    }

    if (!items || items.length === 0) throw new Error("No items provided for stock transfer update");

    await tx.delete(schema.stockTransferItems).where(eq(schema.stockTransferItems.transferId, id));

    const [updatedTransfer] = await tx
      .update(schema.stockTransferVouchers)
      .set({
        sourceLocationId: items[0].sourceLocationId,
        destinationLocationId,
        notes,
        inventoryApplied: !isOptional,
      })
      .where(eq(schema.stockTransferVouchers.id, id))
      .returning();

    const sortedNewTransferItems = [...items].sort(
      (a, b) => a.stockItemId - b.stockItemId || a.sourceLocationId - b.sourceLocationId
    );
    const transferItems: StockTransferItem[] = [];
    for (const item of sortedNewTransferItems) {
      const quantity = toInventoryDecimal(item.quantity).abs();
      const requestedRate = toInventoryDecimal(item.rate);

      // When the user saves an unchanged historical transfer, preserve the
      // original stored value exactly. This prevents a harmless edit from
      // turning qty × rounded average_rate into a new cost basis.
      const unchangedOldItem =
        existingTransfer.destinationLocationId === destinationLocationId
          ? existingItems.find(
              (oldItem) =>
                oldItem.sourceLocationId === item.sourceLocationId &&
                oldItem.stockItemId === item.stockItemId &&
                sameDecimal(toInventoryDecimal(oldItem.quantity).abs(), quantity) &&
                sameDecimal(toInventoryDecimal(oldItem.rate), requestedRate)
            )
          : undefined;
      const totalAmount = unchangedOldItem
        ? toInventoryDecimal(unchangedOldItem.totalAmount).abs()
        : multiplyInventoryValues(quantity, requestedRate);
      let appliedRate = quantity.gt(0) ? totalAmount.dividedBy(quantity) : requestedRate;
      let valueMoved: Decimal | null = null;

      if (!isOptional) {
        if (unchangedOldItem) {
          // An unchanged line moves its exact historical value again, so an
          // unchanged save is valuation-neutral.
          valueMoved = lineValueMoved({ valueMoved: unchangedOldItem.valueMoved, total: unchangedOldItem.totalAmount });
          const moved = await reverseTransferLegExactTx(tx, {
            companyId: voucher.companyId,
            // The forward move is the reverse leg seen from the other side.
            sourceLocationId: destinationLocationId,
            destinationLocationId: item.sourceLocationId,
            stockItemId: item.stockItemId,
            quantity,
            value: valueMoved,
            sourceVoucherType: "stock_transfer_edit_apply",
            sourceVoucherId: existingTransfer.voucherId,
          });
          transferDeltas.push(moved.sourceDelta, moved.destinationDelta);
        } else {
          // A changed line moves what the source holds: the destination
          // receives exactly the value the source relieved.
          const moved = await moveTransferLegConservedTx(tx, {
            companyId: voucher.companyId,
            sourceLocationId: item.sourceLocationId,
            destinationLocationId,
            stockItemId: item.stockItemId,
            quantity,
            fallbackRate: requestedRate,
            sourceVoucherType: "stock_transfer_edit_apply",
            sourceVoucherId: existingTransfer.voucherId,
          });
          valueMoved = moved.relieved;
          appliedRate = moved.rate;
          transferDeltas.push(moved.sourceDelta, moved.destinationDelta);
        }
      }

      const [transferItem] = await tx
        .insert(schema.stockTransferItems)
        .values({
          transferId: updatedTransfer.id,
          stockItemId: item.stockItemId,
          sourceLocationId: item.sourceLocationId,
          quantity: inventoryQuantity(quantity),
          rate: inventoryUnitCost(quantity.gt(0) ? totalAmount.dividedBy(quantity) : requestedRate),
          totalAmount: inventoryMoney(totalAmount),
          valueMoved: valueMoved === null ? null : inventoryMoney(valueMoved),
        })
        .returning();
      transferItems.push(transferItem);

      if (!isOptional) {
        if (item.sourceLocationId !== destinationLocationId) {
          await postStockMovementTx(
            tx,
            {
              companyId: voucher.companyId,
              stockItemId: item.stockItemId,
              kind: "transfer",
              quantity: inventoryQuantity(quantity),
              unitCost: inventoryUnitCost(appliedRate),
              fromLocationId: item.sourceLocationId,
              toLocationId: destinationLocationId,
              occurredAt: new Date().toISOString(),
              source: {
                sourceType: "stock_transfer_edit_apply",
                sourceId: String(existingTransfer.voucherId),
                idempotencyKey: `stock-transfer-edit:apply:${voucher.companyId}:${id}:${transferItem.id}`,
              },
              allowNegativeStock: true,
            },
            canonicalStockMovementAdapter
          );
        }
      }
    }

    await postTransferResidualTx(tx, {
      companyId: voucher.companyId,
      transferId: id,
      date: reversalDate(),
      reference: voucher.voucherNumber,
      deltas: transferDeltas,
    });

    await tx
      .update(schema.vouchers)
      .set({
        description:
          notes.trim() ||
          (await stockTransferNarrationTx(
            tx,
            voucher.companyId,
            items.map((item) => item.sourceLocationId),
            destinationLocationId
          )),
      })
      .where(eq(schema.vouchers.id, voucher.id));

    const result = { transfer: updatedTransfer, items: transferItems };
    if (afterWriteTx) await afterWriteTx(tx, result);
    return result;
  });
}

export type UpdatedStockAdjustment = {
  adjustment: schema.StockAdjustmentVoucher;
  items: StockAdjustmentItem[];
  voucher: schema.Voucher;
};
