import { and, eq } from "drizzle-orm";

import { stockAdjustmentItems, stockAdjustmentVouchers, voucherEntries, vouchers } from "@shared/schema";
import { db } from "../db";
import { reverseInventoryByExactValue } from "../inventoryHelper";
import { voucherMutationBlockReason } from "../lib/migratedVoucherGuard";
import { createDatabaseStockMovementAdapter } from "./inventory/databaseStockMovementAdapter";
import { restoreInventoryByExactValue } from "./inventory/exactValueInventory";
import { postStockMovementTx } from "./inventory/stockMovementIntegrityService";

const canonicalStockMovementAdapter = createDatabaseStockMovementAdapter();

export class StockAdjustmentDeletionError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number) {
    super(message);
    this.name = "StockAdjustmentDeletionError";
  }
}

export interface StockAdjustmentDeletionResult {
  handled: true;
  replayed: boolean;
  reversedInventory: boolean;
  voucher: typeof vouchers.$inferSelect;
  entries: Array<typeof voucherEntries.$inferSelect>;
  adjustmentId: number | null;
}

function isProduction(adjustmentType: string | null | undefined, quantity: number): boolean {
  const normalized = String(adjustmentType ?? "").toLowerCase();
  return normalized === "production" || (normalized === "mixed" && quantity > 0);
}

/**
 * Cancels a stock adjustment under one voucher-row lock and reverses the exact
 * persisted quantity + value. A retry observes deleted_at and becomes a no-op.
 */
export async function deleteStockAdjustmentVoucher(input: {
  companyId: number;
  voucherId: number;
}): Promise<StockAdjustmentDeletionResult> {
  const companyId = Number(input.companyId);
  const voucherId = Number(input.voucherId);
  if (!Number.isInteger(companyId) || companyId <= 0) {
    throw new StockAdjustmentDeletionError("COMPANY_REQUIRED", "No company selected", 400);
  }
  if (!Number.isInteger(voucherId) || voucherId <= 0) {
    throw new StockAdjustmentDeletionError("VOUCHER_ID_INVALID", "Invalid voucher ID", 400);
  }

  return db.transaction(async (tx) => {
    const [voucher] = await tx.select().from(vouchers).where(eq(vouchers.id, voucherId)).for("update");
    if (!voucher) {
      throw new StockAdjustmentDeletionError("VOUCHER_NOT_FOUND", "Voucher not found", 404);
    }
    if (voucher.companyId !== companyId) {
      throw new StockAdjustmentDeletionError(
        "VOUCHER_COMPANY_MISMATCH",
        "Access denied: Voucher belongs to a different company",
        403
      );
    }

    const blockedReason = voucherMutationBlockReason(voucher);
    if (blockedReason) {
      throw new StockAdjustmentDeletionError("MIGRATED_VOUCHER_READONLY", blockedReason, 403);
    }

    const entries = await tx.select().from(voucherEntries).where(eq(voucherEntries.voucherId, voucherId));
    if (voucher.deletedAt) {
      return {
        handled: true,
        replayed: true,
        reversedInventory: false,
        voucher,
        entries,
        adjustmentId: null,
      };
    }

    const [adjustment] = await tx
      .select()
      .from(stockAdjustmentVouchers)
      .where(eq(stockAdjustmentVouchers.voucherId, voucherId))
      .for("update");
    if (!adjustment) {
      throw new StockAdjustmentDeletionError(
        "STOCK_ADJUSTMENT_NOT_FOUND",
        "Voucher has no stock adjustment lifecycle record",
        404
      );
    }

    const items = await tx
      .select()
      .from(stockAdjustmentItems)
      .where(eq(stockAdjustmentItems.adjustmentId, adjustment.id))
      .for("update");

    let reversedInventory = false;
    if (!voucher.optional) {
      for (const item of items) {
        const signedQuantity = Number(item.quantity);
        const quantity = Math.abs(signedQuantity);
        const storedValue = Math.abs(Number(item.totalAmount ?? 0));
        const storedRate = quantity > 0 ? storedValue / quantity : Number(item.rate ?? 0);
        if (
          !Number.isFinite(signedQuantity) ||
          quantity <= 0 ||
          !Number.isFinite(storedValue) ||
          storedValue < 0 ||
          !Number.isFinite(storedRate) ||
          storedRate < 0
        ) {
          throw new StockAdjustmentDeletionError(
            "STOCK_ADJUSTMENT_ITEM_INVALID",
            `Stock adjustment item ${item.id} has invalid quantity or value`,
            409
          );
        }

        const production = isProduction(adjustment.adjustmentType, signedQuantity);
        if (production) {
          await reverseInventoryByExactValue(
            tx,
            adjustment.locationId,
            item.stockItemId,
            quantity,
            storedValue,
            companyId,
            "stock_adjustment_delete_reverse",
            voucherId
          );
        } else {
          await restoreInventoryByExactValue(
            tx,
            companyId,
            adjustment.locationId,
            item.stockItemId,
            quantity,
            storedValue
          );
        }

        await postStockMovementTx(
          tx,
          {
            companyId,
            stockItemId: item.stockItemId,
            kind: "adjustment",
            quantity: String(quantity),
            unitCost: String(storedRate),
            fromLocationId: production ? adjustment.locationId : undefined,
            toLocationId: production ? undefined : adjustment.locationId,
            occurredAt: new Date().toISOString(),
            source: {
              sourceType: "stock_adjustment_delete_reverse",
              sourceId: String(voucherId),
              idempotencyKey: `stock-adjustment-delete:${companyId}:${voucherId}:${item.id}`,
            },
            allowNegativeStock: true,
          },
          canonicalStockMovementAdapter
        );
      }
      reversedInventory = items.length > 0;
    }

    await tx.delete(stockAdjustmentItems).where(eq(stockAdjustmentItems.adjustmentId, adjustment.id));
    await tx.delete(stockAdjustmentVouchers).where(eq(stockAdjustmentVouchers.id, adjustment.id));

    const [deletedVoucher] = await tx
      .update(vouchers)
      .set({ deletedAt: new Date() })
      .where(and(eq(vouchers.id, voucherId), eq(vouchers.companyId, companyId)))
      .returning();

    return {
      handled: true,
      replayed: false,
      reversedInventory,
      voucher: deletedVoucher ?? voucher,
      entries,
      adjustmentId: adjustment.id,
    };
  });
}
