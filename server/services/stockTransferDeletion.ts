import { and, eq, inArray, or } from "drizzle-orm";
import { db, type DbTransaction } from "../db";
import { reverseInventoryByExactValue } from "../inventoryHelper";
import {
  interCompanyTransfers,
  intercompanyPaymentRequests,
  locations,
  stockItems,
  stockTransferItems,
  stockTransferVouchers,
  voucherEntries,
  vouchers,
} from "@shared/schema";
import { voucherMutationBlockReason } from "../lib/migratedVoucherGuard";
import { journalStockTransferLeg, nextStockTransferRevision } from "./inventory/stockTransferJournal";
import { restoreInventoryByExactValue } from "./inventory/exactValueInventory";
import { applyEmployeeBalanceDeltasTx } from "./accounting/employeeBalancePosting";

export class StockTransferDeletionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = "StockTransferDeletionError";
  }
}

export interface StockTransferDeletionResult {
  handled: true;
  replayed: boolean;
  voucher: typeof vouchers.$inferSelect;
  entries: Array<typeof voucherEntries.$inferSelect>;
  reversedInventory: boolean;
  transferId: number | null;
}

export function isStockTransferVoucherType(value: string | null | undefined): boolean {
  return value === "Stock Transfer" || value === "StockTransfer" || value === "Transfer";
}

export function shouldReverseStockTransferOnDelete(input: {
  inventoryApplied: boolean | null | undefined;
  optional: boolean | null | undefined;
}): boolean {
  // inventoryApplied is authoritative for current records. The non-optional
  // fallback preserves deletion behavior for transfers created before that
  // lifecycle flag existed.
  return input.inventoryApplied === true || input.optional !== true;
}

export function sortStockTransferDeletionItems<
  T extends {
    sourceLocationId: number | null;
    stockItemId: number;
  },
>(items: T[]): T[] {
  return [...items].sort(
    (a, b) => Number(a.sourceLocationId ?? 0) - Number(b.sourceLocationId ?? 0) || a.stockItemId - b.stockItemId
  );
}

async function assertPersistedTransferScope(input: {
  tx: DbTransaction;
  companyId: number;
  destinationLocationId: number;
  items: Array<{ sourceLocationId: number; stockItemId: number }>;
}): Promise<void> {
  const { tx, companyId, destinationLocationId, items } = input;
  const locationIds = Array.from(new Set([destinationLocationId, ...items.map((item) => item.sourceLocationId)]));
  const validLocations = await tx
    .select({ id: locations.id })
    .from(locations)
    .where(and(eq(locations.companyId, companyId), inArray(locations.id, locationIds)));
  if (validLocations.length !== locationIds.length) {
    throw new StockTransferDeletionError(
      "STOCK_TRANSFER_DELETE_SCOPE_INVALID",
      "One or more stock transfer locations do not belong to the current company",
      409
    );
  }

  const itemIds = Array.from(new Set(items.map((item) => item.stockItemId)));
  const validItems = await tx
    .select({ id: stockItems.id })
    .from(stockItems)
    .where(and(eq(stockItems.companyId, companyId), inArray(stockItems.id, itemIds)));
  if (validItems.length !== itemIds.length) {
    throw new StockTransferDeletionError(
      "STOCK_TRANSFER_DELETE_SCOPE_INVALID",
      "One or more stock transfer items do not belong to the current company",
      409
    );
  }
}

/**
 * Deletes a stock-transfer voucher under one transaction-owned lifecycle lock.
 *
 * The voucher row is locked first, followed by the transfer header and item
 * rows. A second delete waits and then sees deletedAt, so inventory reversal is
 * performed at most once.
 */
export async function deleteStockTransferVoucher(input: {
  companyId: number;
  voucherId: number;
}): Promise<StockTransferDeletionResult> {
  const companyId = Number(input.companyId);
  const voucherId = Number(input.voucherId);
  if (!Number.isInteger(companyId) || companyId <= 0) {
    throw new StockTransferDeletionError("COMPANY_REQUIRED", "No company selected", 400);
  }
  if (!Number.isInteger(voucherId) || voucherId <= 0) {
    throw new StockTransferDeletionError("VOUCHER_ID_INVALID", "Invalid voucher ID", 400);
  }

  return db.transaction(async (tx) => {
    const [lockedVoucher] = await tx.select().from(vouchers).where(eq(vouchers.id, voucherId)).for("update");

    if (!lockedVoucher) {
      throw new StockTransferDeletionError("VOUCHER_NOT_FOUND", "Voucher not found", 404);
    }
    if (lockedVoucher.companyId !== companyId) {
      throw new StockTransferDeletionError(
        "VOUCHER_COMPANY_MISMATCH",
        "Access denied: Voucher belongs to a different company",
        403
      );
    }
    if (!isStockTransferVoucherType(lockedVoucher.voucherType)) {
      throw new StockTransferDeletionError("NOT_STOCK_TRANSFER", "Voucher is not a stock transfer", 400);
    }
    const blockedVoucherReason = voucherMutationBlockReason(lockedVoucher);
    if (blockedVoucherReason) {
      throw new StockTransferDeletionError("MIGRATED_VOUCHER_READONLY", blockedVoucherReason, 403);
    }

    const entries = await tx.select().from(voucherEntries).where(eq(voucherEntries.voucherId, voucherId));

    if (lockedVoucher.deletedAt) {
      return {
        handled: true,
        replayed: true,
        voucher: lockedVoucher,
        entries,
        reversedInventory: false,
        transferId: null,
      };
    }

    const [transfer] = await tx
      .select()
      .from(stockTransferVouchers)
      .where(eq(stockTransferVouchers.voucherId, voucherId))
      .for("update");

    let reversedInventory = false;
    if (transfer) {
      const transferItems = sortStockTransferDeletionItems(
        await tx.select().from(stockTransferItems).where(eq(stockTransferItems.transferId, transfer.id)).for("update")
      );

      if (
        shouldReverseStockTransferOnDelete({
          inventoryApplied: transfer.inventoryApplied,
          optional: lockedVoucher.optional,
        })
      ) {
        const destinationLocationId = Number(transfer.destinationLocationId);
        if (!Number.isInteger(destinationLocationId) || destinationLocationId <= 0) {
          throw new StockTransferDeletionError(
            "STOCK_TRANSFER_DESTINATION_MISSING",
            "Stock transfer is missing its destination location",
            409
          );
        }

        const scopedItems = transferItems.map((item) => {
          const sourceLocationId = Number(item.sourceLocationId ?? transfer.sourceLocationId);
          if (!Number.isInteger(sourceLocationId) || sourceLocationId <= 0) {
            throw new StockTransferDeletionError(
              "STOCK_TRANSFER_SOURCE_MISSING",
              `Stock transfer item ${item.id} is missing its source location`,
              409
            );
          }
          return { sourceLocationId, stockItemId: item.stockItemId, row: item };
        });

        await assertPersistedTransferScope({
          tx,
          companyId,
          destinationLocationId,
          items: scopedItems,
        });

        const canonicalRevision = await nextStockTransferRevision(tx, companyId, Number(transfer.id));

        for (const item of scopedItems) {
          const quantity = Number(item.row.quantity);
          const rate = Number(item.row.rate ?? 0);
          const storedValue = Math.abs(Number(item.row.totalAmount ?? quantity * rate));
          if (
            !Number.isFinite(quantity) ||
            quantity <= 0 ||
            !Number.isFinite(rate) ||
            rate < 0 ||
            !Number.isFinite(storedValue) ||
            storedValue < 0
          ) {
            throw new StockTransferDeletionError(
              "STOCK_TRANSFER_ITEM_INVALID",
              `Stock transfer item ${item.row.id} has invalid quantity, rate, or value`,
              409
            );
          }

          // Undo the transfer's exact historical effect. Reconstructing the
          // destination issue from its blended current average can restore the
          // right quantity while leaving the wrong asset value behind.
          await restoreInventoryByExactValue(
            tx,
            companyId,
            item.sourceLocationId,
            item.stockItemId,
            quantity,
            storedValue
          );
          await reverseInventoryByExactValue(
            tx,
            destinationLocationId,
            item.stockItemId,
            quantity,
            storedValue,
            companyId,
            "stock_transfer_delete_reverse",
            voucherId
          );

          await journalStockTransferLeg(tx, {
            companyId,
            transferId: Number(transfer.id),
            revision: canonicalRevision,
            phase: "reverse",
            fromLocationId: destinationLocationId,
            toLocationId: item.sourceLocationId,
            leg: { stockItemId: item.stockItemId, quantity, rate },
          });
        }
        reversedInventory = transferItems.length > 0;
      }

      await tx.delete(stockTransferItems).where(eq(stockTransferItems.transferId, transfer.id));
      await tx.delete(stockTransferVouchers).where(eq(stockTransferVouchers.id, transfer.id));
    }

    if (!lockedVoucher.optional) {
      await applyEmployeeBalanceDeltasTx({
        tx,
        companyId,
        entries,
        direction: "reverse",
        missingEmployeeBehavior: "skip",
      });
    }

    const linkedTransfers = await tx
      .select()
      .from(interCompanyTransfers)
      .where(or(eq(interCompanyTransfers.fromVoucherId, voucherId), eq(interCompanyTransfers.toVoucherId, voucherId)));
    for (const linked of linkedTransfers) {
      const otherVoucherId = linked.fromVoucherId === voucherId ? linked.toVoucherId : linked.fromVoucherId;
      await tx.delete(interCompanyTransfers).where(eq(interCompanyTransfers.id, linked.id));
      if (otherVoucherId && otherVoucherId !== voucherId) {
        await tx.delete(voucherEntries).where(eq(voucherEntries.voucherId, otherVoucherId));
        await tx.delete(vouchers).where(eq(vouchers.id, otherVoucherId));
      }
    }

    await tx
      .delete(intercompanyPaymentRequests)
      .where(
        and(eq(intercompanyPaymentRequests.fromVoucherId, voucherId), eq(intercompanyPaymentRequests.status, "pending"))
      );

    const [deletedVoucher] = await tx
      .update(vouchers)
      .set({ deletedAt: new Date() })
      .where(and(eq(vouchers.id, voucherId), eq(vouchers.companyId, companyId)))
      .returning();

    return {
      handled: true,
      replayed: false,
      voucher: deletedVoucher ?? lockedVoucher,
      entries,
      reversedInventory,
      transferId: transfer?.id ?? null,
    };
  });
}
