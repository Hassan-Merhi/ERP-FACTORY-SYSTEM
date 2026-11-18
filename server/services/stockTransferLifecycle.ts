import { eq } from "drizzle-orm";
import { db } from "../db";
import {
  postTransferResidualTx,
  recordTransferValueMovedTx,
  transferVoucherDateTx,
} from "./inventory/conservedStockTransfer";
import { reversalDate } from "./inventory/valueExactReversal";
import { stockTransferVouchers, vouchers } from "@shared/schema";
import { nextStockTransferRevision } from "./inventory/stockTransferJournal";
import { assertTransferNotAlreadyPostedTx } from "./inventory/transferCanonicalAlreadyPostedGuard";
import type { DbTransaction } from "../db";
import { MoneyDecimal, lineAmount } from "../lib/money";
import {
  assertCompanyScope,
  loadTransferItems,
  lockTransferByVoucher,
  persistedRowsToItems,
  positiveInteger,
  reverseAppliedItems,
  rowValuesByGroup,
  type SaveStockTransferLifecycleInput,
  type StockTransferLifecycleResult,
} from "./aggregateSourceStockRequirements";
import { saveStockTransferLifecycleTx, validateAndApplyItems } from "./saveStockTransferLifecycleTx";
export { aggregateSourceStockRequirements } from "./aggregateSourceStockRequirements";
export type {
  SaveStockTransferLifecycleInput,
  SourceStockRequirement,
  StockTransferLifecycleItem,
  StockTransferLifecycleResult,
} from "./aggregateSourceStockRequirements";
export { saveStockTransferLifecycleTx } from "./saveStockTransferLifecycleTx";

/**
 * Saves a transfer according to its two persisted lifecycle flags.
 *
 * optional=true, inventoryApplied=false  -> draft edit, records only
 * optional=false, inventoryApplied=false -> post once (legacy recovery)
 * optional=true, inventoryApplied=true   -> unpost once, then records only
 * optional=false, inventoryApplied=true  -> reverse old + apply new posted edit
 */
export async function saveStockTransferLifecycle(
  input: SaveStockTransferLifecycleInput
): Promise<StockTransferLifecycleResult> {
  return db.transaction((tx) => saveStockTransferLifecycleTx(tx, input));
}

/**
 * Finalizes a base optional stock transfer. Voucher, transfer and source stock
 * are locked in one transaction, then stock is applied exactly once.
 */
export async function finalizeOptionalStockTransfer(
  companyIdInput: number,
  voucherIdInput: number
): Promise<StockTransferLifecycleResult> {
  return db.transaction((tx) => finalizeOptionalStockTransferTx(tx, companyIdInput, voucherIdInput));
}

/** finalizeOptionalStockTransfer on the caller's transaction (offline capture and cloud replay). */
export async function finalizeOptionalStockTransferTx(
  tx: DbTransaction,
  companyIdInput: number,
  voucherIdInput: number
): Promise<StockTransferLifecycleResult> {
  const companyId = positiveInteger(companyIdInput, "Company ID");
  const voucherId = positiveInteger(voucherIdInput, "Voucher ID");

  {
    const locked = await lockTransferByVoucher(tx, voucherId);
    if (!locked) throw new Error("Stock transfer not found");
    if (Number(locked.company_id) !== companyId) throw new Error("Stock transfer belongs to a different company");
    if (
      locked.voucher_type !== "Stock Transfer" &&
      locked.voucher_type !== "StockTransfer" &&
      locked.voucher_type !== "Transfer"
    ) {
      throw new Error("Voucher is not a stock transfer");
    }
    if (locked.deleted_at) throw new Error("Deleted stock transfers cannot be finalized");

    const transferId = Number(locked.id);
    const destinationLocationId = Number(locked.destination_location_id);
    const persistedRows = await loadTransferItems(tx, transferId);
    if (persistedRows.length === 0) throw new Error("Stock transfer has no items");
    const items = persistedRowsToItems(
      persistedRows,
      locked.source_location_id ? Number(locked.source_location_id) : null,
      destinationLocationId
    );
    await assertCompanyScope(tx, companyId, destinationLocationId, items);
    const totalAmount = items
      .reduce((sum, item) => sum.plus(lineAmount(item.quantity, item.rate)), new MoneyDecimal(0))
      .toFixed(2);

    const inventoryApplied = Boolean(locked.inventory_applied);
    const optional = Boolean(locked.optional);

    if (inventoryApplied && !optional) {
      return {
        voucherId,
        transferId,
        optional: false,
        inventoryApplied: true,
        transition: "no-op",
        totalAmount,
        items: persistedRows,
      };
    }

    let transition: StockTransferLifecycleResult["transition"] = "post";
    if (!inventoryApplied) {
      await assertTransferNotAlreadyPostedTx(tx, { companyId, transferId, voucherId });
      const applied = await validateAndApplyItems(tx, companyId, destinationLocationId, items, {
        transferId,
        revision: await nextStockTransferRevision(tx, companyId, transferId),
      });
      await recordTransferValueMovedTx(
        tx,
        transferId,
        applied.relievedByGroup,
        locked.source_location_id ? Number(locked.source_location_id) : null
      );
      await postTransferResidualTx(tx, {
        companyId,
        transferId,
        date: await transferVoucherDateTx(tx, companyId, voucherId),
        reference: `Transfer ${transferId}`,
        deltas: applied.deltas,
      });
    } else {
      // Legacy mismatch: stock already moved while header remained optional.
      // Repair only the flags; never move stock a second time.
      transition = "recover";
    }

    await tx
      .update(stockTransferVouchers)
      .set({ inventoryApplied: true })
      .where(eq(stockTransferVouchers.id, transferId));
    await tx.update(vouchers).set({ optional: false, totalAmount }).where(eq(vouchers.id, voucherId));

    return {
      voucherId,
      transferId,
      optional: false,
      inventoryApplied: true,
      transition,
      totalAmount,
      items: persistedRows,
    };
  }
}

export async function finalizeStockTransferByTransferId(companyIdInput: number, transferIdInput: number) {
  const companyId = positiveInteger(companyIdInput, "Company ID");
  const transferId = positiveInteger(transferIdInput, "Transfer ID");
  const [transfer] = await db
    .select({ voucherId: stockTransferVouchers.voucherId })
    .from(stockTransferVouchers)
    .where(eq(stockTransferVouchers.id, transferId))
    .limit(1);
  if (!transfer) throw new Error("Stock transfer not found");
  return finalizeOptionalStockTransfer(companyId, transfer.voucherId);
}

/** Reopens a posted stock transfer as a draft, reversing stock at most once. */
export async function reopenStockTransferAsDraft(
  companyIdInput: number,
  voucherIdInput: number,
  headerUpdates: { voucherDate?: string; description?: string } = {}
): Promise<StockTransferLifecycleResult> {
  const companyId = positiveInteger(companyIdInput, "Company ID");
  const voucherId = positiveInteger(voucherIdInput, "Voucher ID");

  return db.transaction(async (tx) => {
    const locked = await lockTransferByVoucher(tx, voucherId);
    if (!locked) throw new Error("Stock transfer not found");
    if (Number(locked.company_id) !== companyId) throw new Error("Stock transfer belongs to a different company");
    if (
      locked.voucher_type !== "Stock Transfer" &&
      locked.voucher_type !== "StockTransfer" &&
      locked.voucher_type !== "Transfer"
    ) {
      throw new Error("Voucher is not a stock transfer");
    }
    if (locked.deleted_at) throw new Error("Deleted stock transfers cannot be changed");

    const transferId = Number(locked.id);
    const destinationLocationId = Number(locked.destination_location_id);
    const persistedRows = await loadTransferItems(tx, transferId);
    const items = persistedRowsToItems(
      persistedRows,
      locked.source_location_id ? Number(locked.source_location_id) : null,
      destinationLocationId
    );

    if (locked.inventory_applied) {
      const deltas = await reverseAppliedItems(
        tx,
        companyId,
        destinationLocationId,
        items,
        rowValuesByGroup(persistedRows, locked.source_location_id ? Number(locked.source_location_id) : null),
        { transferId, revision: await nextStockTransferRevision(tx, companyId, transferId) }
      );
      await postTransferResidualTx(tx, {
        companyId,
        transferId,
        date: reversalDate(),
        reference: `Transfer ${transferId}`,
        deltas,
      });
    }

    await tx
      .update(stockTransferVouchers)
      .set({ inventoryApplied: false })
      .where(eq(stockTransferVouchers.id, transferId));
    await tx
      .update(vouchers)
      .set({
        optional: true,
        ...(headerUpdates.voucherDate !== undefined ? { voucherDate: headerUpdates.voucherDate } : {}),
        ...(headerUpdates.description !== undefined ? { description: headerUpdates.description } : {}),
      })
      .where(eq(vouchers.id, voucherId));

    return {
      voucherId,
      transferId,
      optional: true,
      inventoryApplied: false,
      transition: locked.inventory_applied ? "unpost" : "no-op",
      totalAmount: String(locked.total_amount ?? "0"),
      items: persistedRows,
    };
  });
}
