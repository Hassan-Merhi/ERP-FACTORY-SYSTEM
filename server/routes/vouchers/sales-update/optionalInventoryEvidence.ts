import type { DbTransaction } from "../../../db";
import {
  stockTransferVouchers,
  stockTransferItems,
  stockAdjustmentVouchers,
  stockAdjustmentItems,
  salesItems,
  creditNoteItems,
  vouchers,
} from "@shared/schema";
import { eq } from "drizzle-orm";
import { adjustInventory } from "../../../inventoryHelper";
import { nextCanonicalSourceRevision } from "../../../services/inventory/canonicalSourceRevision";
import { createDatabaseStockMovementAdapter } from "../../../services/inventory/databaseStockMovementAdapter";
import { postStockMovementTx } from "../../../services/inventory/stockMovementIntegrityService";

const canonicalStockMovementAdapter = createDatabaseStockMovementAdapter();

type VoucherRow = typeof vouchers.$inferSelect;

export async function applyVoucherOptionalInventoryChange(
  tx: DbTransaction,
  voucher: VoucherRow,
  willBeOptional: boolean,
  actor?: { userId?: number | null; username?: string | null; reason?: string | null }
): Promise<void> {
  if (voucher.optional === willBeOptional) return;

  const revision = await nextCanonicalSourceRevision(
    tx,
    voucher.companyId,
    "voucher-optional-toggle",
    String(voucher.id)
  );
  const occurredAt = new Date().toISOString();
  const evidenceActor = actor ?? {
    reason: `${willBeOptional ? "Suspend" : "Activate"} voucher ${voucher.voucherNumber}`,
  };

  const [transfer] = await tx
    .select()
    .from(stockTransferVouchers)
    .where(eq(stockTransferVouchers.voucherId, voucher.id))
    .limit(1);

  if (transfer) {
    const items = await tx.select().from(stockTransferItems).where(eq(stockTransferItems.transferId, transfer.id));
    for (const item of items) {
      const sourceLocId = item.sourceLocationId ?? transfer.sourceLocationId;
      const destinationLocId = transfer.destinationLocationId;
      if (sourceLocId == null || destinationLocId == null) {
        throw new Error("Stock transfer is missing source or destination location");
      }
      const quantity = Number(item.quantity);
      const rate = Number(item.rate);
      if (willBeOptional && transfer.inventoryApplied) {
        await adjustInventory(tx, sourceLocId, item.stockItemId, quantity, voucher.companyId, rate);
        await adjustInventory(tx, destinationLocId, item.stockItemId, -quantity, voucher.companyId);
        await postStockMovementTx(
          tx,
          {
            companyId: voucher.companyId,
            stockItemId: item.stockItemId,
            kind: "transfer",
            quantity: String(Math.abs(quantity)),
            unitCost: String(Math.max(rate || 0, 0)),
            fromLocationId: destinationLocId,
            toLocationId: sourceLocId,
            occurredAt,
            source: {
              sourceType: "voucher-optional-toggle-transfer-reverse",
              sourceId: String(voucher.id),
              idempotencyKey: `voucher-optional:rev${revision}:transfer-reverse:${item.id}`,
            },
            actor: evidenceActor,
            allowNegativeStock: true,
          },
          canonicalStockMovementAdapter
        );
      } else if (!willBeOptional && !transfer.inventoryApplied) {
        await adjustInventory(tx, sourceLocId, item.stockItemId, -quantity, voucher.companyId);
        await adjustInventory(tx, destinationLocId, item.stockItemId, quantity, voucher.companyId, rate);
        await postStockMovementTx(
          tx,
          {
            companyId: voucher.companyId,
            stockItemId: item.stockItemId,
            kind: "transfer",
            quantity: String(Math.abs(quantity)),
            unitCost: String(Math.max(rate || 0, 0)),
            fromLocationId: sourceLocId,
            toLocationId: destinationLocId,
            occurredAt,
            source: {
              sourceType: "voucher-optional-toggle-transfer-apply",
              sourceId: String(voucher.id),
              idempotencyKey: `voucher-optional:rev${revision}:transfer-apply:${item.id}`,
            },
            actor: evidenceActor,
            allowNegativeStock: true,
          },
          canonicalStockMovementAdapter
        );
      }
    }
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
    for (const item of items) {
      const rawQuantity = Number(item.quantity);
      const quantity = Math.abs(rawQuantity);
      const rate = Number(item.rate);
      const isProduction =
        adjustment.adjustmentType === "Production" || (adjustment.adjustmentType === "Mixed" && rawQuantity > 0);
      const outgoing = willBeOptional ? isProduction : !isProduction;
      const delta = outgoing ? -quantity : quantity;
      await adjustInventory(
        tx,
        adjustment.locationId,
        item.stockItemId,
        delta,
        voucher.companyId,
        outgoing ? undefined : rate
      );
      await postStockMovementTx(
        tx,
        {
          companyId: voucher.companyId,
          stockItemId: item.stockItemId,
          kind: "adjustment",
          quantity: String(quantity),
          unitCost: String(Math.max(rate || 0, 0)),
          fromLocationId: outgoing ? adjustment.locationId : undefined,
          toLocationId: outgoing ? undefined : adjustment.locationId,
          occurredAt,
          source: {
            sourceType: "voucher-optional-toggle-adjustment",
            sourceId: String(voucher.id),
            idempotencyKey: `voucher-optional:rev${revision}:adjustment:${item.id}`,
          },
          actor: evidenceActor,
          allowNegativeStock: true,
        },
        canonicalStockMovementAdapter
      );
    }
  }

  const saleLines = await tx.select().from(salesItems).where(eq(salesItems.voucherId, voucher.id));
  if (saleLines.length > 0 && voucher.locationId) {
    for (const item of saleLines) {
      const quantity = Number(item.quantity);
      const costPrice = Number(item.costPrice);
      const outgoing = !willBeOptional;
      await adjustInventory(
        tx,
        voucher.locationId,
        item.stockItemId,
        outgoing ? -quantity : quantity,
        voucher.companyId,
        outgoing ? undefined : costPrice
      );
      await postStockMovementTx(
        tx,
        {
          companyId: voucher.companyId,
          stockItemId: item.stockItemId,
          kind: "adjustment",
          quantity: String(Math.abs(quantity)),
          unitCost: String(Math.max(costPrice || 0, 0)),
          fromLocationId: outgoing ? voucher.locationId : undefined,
          toLocationId: outgoing ? undefined : voucher.locationId,
          occurredAt,
          source: {
            sourceType: "voucher-optional-toggle-sale",
            sourceId: String(voucher.id),
            idempotencyKey: `voucher-optional:rev${revision}:sale:${item.id}`,
          },
          actor: evidenceActor,
          allowNegativeStock: true,
        },
        canonicalStockMovementAdapter
      );
    }
  }

  const creditLines = await tx.select().from(creditNoteItems).where(eq(creditNoteItems.voucherId, voucher.id));
  for (const item of creditLines) {
    const quantity = Number(item.quantity);
    const rate = Number(item.rate);
    const outgoing = willBeOptional;
    await adjustInventory(
      tx,
      item.locationId,
      item.stockItemId,
      outgoing ? -quantity : quantity,
      voucher.companyId,
      outgoing ? undefined : rate
    );
    await postStockMovementTx(
      tx,
      {
        companyId: voucher.companyId,
        stockItemId: item.stockItemId,
        kind: "adjustment",
        quantity: String(Math.abs(quantity)),
        unitCost: String(Math.max(rate || 0, 0)),
        fromLocationId: outgoing ? item.locationId : undefined,
        toLocationId: outgoing ? undefined : item.locationId,
        occurredAt,
        source: {
          sourceType: "voucher-optional-toggle-credit-note",
          sourceId: String(voucher.id),
          idempotencyKey: `voucher-optional:rev${revision}:credit-note:${item.id}`,
        },
        actor: evidenceActor,
        allowNegativeStock: true,
      },
      canonicalStockMovementAdapter
    );
  }
}
