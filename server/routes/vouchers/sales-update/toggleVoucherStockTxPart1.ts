// Extracted from ./optionalStockToggle.ts
import type Decimal from "decimal.js";
import { eq } from "drizzle-orm";
import {
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
  moveTransferLegConservedTx,
  recordTransferValueMovedTx,
  reverseTransferLegExactTx,
} from "../../../services/inventory/conservedStockTransfer";
import { createDatabaseStockMovementAdapter } from "../../../services/inventory/databaseStockMovementAdapter";
import { postStockMovementTx } from "../../../services/inventory/stockMovementIntegrityService";
import {
  lineValueMoved,
  restoreIssuedValueTx,
  reverseReceivedValueTx,
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

export interface ToggleContext {
  voucher: OptionalToggleVoucher;
  willBeOptional: boolean;
  evidenceRevision: number;
  occurredAt: string;
  evidenceActor: { userId?: string; username?: string; reason: string };
}

export async function toggleVoucherStockTxPart1(tx: DbTransaction, context: ToggleContext) {
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
  return { voucher, willBeOptional, companyId, deltas, movement, rateOf, saleItems };
}
