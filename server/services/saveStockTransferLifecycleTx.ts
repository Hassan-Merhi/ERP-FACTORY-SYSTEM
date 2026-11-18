// Extracted from ./stockTransferLifecycle.ts to keep that module under the source-size cap.
import { eq } from "drizzle-orm";
import type Decimal from "decimal.js";
import { db, type DbTransaction } from "../db";
import { assertNoBaleMirrorMovementTx } from "./accounting/perpetualInventory/cutoverRefusal";
import {
  moveTransferLegConservedTx,
  postTransferResidualTx,
  recordTransferValueMovedTx,
} from "./inventory/conservedStockTransfer";
import { reversalDate } from "./inventory/valueExactReversal";
import { stockTransferNarrationTx } from "./inventory/stockTransferNarration";
import { stockTransferItems, stockTransferVouchers, vouchers } from "@shared/schema";
import { journalStockTransferLeg, nextStockTransferRevision } from "./inventory/stockTransferJournal";
import { assertTransferNotAlreadyPostedTx } from "./inventory/transferCanonicalAlreadyPostedGuard";
import { lineAmount, MoneyDecimal, toMoney } from "../lib/money";
import {
  assertCompanyScope,
  loadTransferItems,
  lockTransfer,
  normalizeItems,
  persistedRowsToItems,
  positiveInteger,
  reverseAppliedItems,
  rowValuesByGroup,
  type SaveStockTransferLifecycleInput,
  type StockTransferLifecycleItem,
  type StockTransferLifecycleResult,
} from "./aggregateSourceStockRequirements";

/**
 * Applies the items so the destination receives exactly the value the source
 * relieved (wave 11), and returns that value per (source, item) group and the
 * signed sub-ledger changes.
 */
export async function validateAndApplyItems(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  companyId: number,
  destinationLocationId: number,
  items: StockTransferLifecycleItem[],
  journal?: { transferId: number; revision: number }
): Promise<{ relievedByGroup: Map<string, Decimal>; deltas: Decimal[] }> {
  await assertCompanyScope(tx, companyId, destinationLocationId, items);
  // Wave 11: a factory bale-mirror item is moved in the factory after the cut-over.
  await assertNoBaleMirrorMovementTx(
    tx,
    companyId,
    items.map((item) => item.stockItemId),
    "stock-transfer"
  );

  // Negative inventory is intentionally allowed for stock transfers. This keeps
  // operational transfers unblocked when physical stock is moved before the
  // corresponding source receipt or correction has been entered in the ERP.
  const relievedByGroup = new Map<string, Decimal>();
  const deltas: Decimal[] = [];
  for (const item of items) {
    const moved = await moveTransferLegConservedTx(tx, {
      companyId,
      sourceLocationId: item.sourceLocationId,
      destinationLocationId,
      stockItemId: item.stockItemId,
      quantity: item.quantity,
      fallbackRate: item.rate,
    });
    relievedByGroup.set(`${item.sourceLocationId}:${item.stockItemId}`, moved.relieved);
    deltas.push(moved.sourceDelta, moved.destinationDelta);

    if (journal) {
      await journalStockTransferLeg(tx, {
        companyId,
        transferId: journal.transferId,
        revision: journal.revision,
        phase: "issue",
        fromLocationId: item.sourceLocationId,
        toLocationId: destinationLocationId,
        leg: item,
      });
    }
  }
  return { relievedByGroup, deltas };
}

async function replaceTransferItems(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  transferId: number,
  items: StockTransferLifecycleItem[]
) {
  await tx.delete(stockTransferItems).where(eq(stockTransferItems.transferId, transferId));
  return tx
    .insert(stockTransferItems)
    .values(
      items.map((item) => ({
        transferId,
        stockItemId: item.stockItemId,
        sourceLocationId: item.sourceLocationId,
        quantity: toMoney(item.quantity).toFixed(3),
        rate: toMoney(item.rate).toFixed(2),
        totalAmount: lineAmount(item.quantity, item.rate).toFixed(2),
      }))
    )
    .returning();
}

function headerSourceLocationId(items: StockTransferLifecycleItem[]): number | null {
  const unique = Array.from(new Set(items.map((item) => item.sourceLocationId)));
  return unique.length === 1 ? unique[0] : null;
}

/** saveStockTransferLifecycle on the caller's transaction (offline capture and cloud replay). */
export async function saveStockTransferLifecycleTx(
  tx: DbTransaction,
  input: SaveStockTransferLifecycleInput
): Promise<StockTransferLifecycleResult> {
  const companyId = positiveInteger(input.companyId, "Company ID");
  const transferId = positiveInteger(input.transferId, "Transfer ID");
  const destinationLocationId = positiveInteger(input.destinationLocationId, "Destination location ID");
  const normalizedItems = normalizeItems(input.items, destinationLocationId);

  {
    const locked = await lockTransfer(tx, transferId);
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

    const voucherId = Number(locked.voucher_id);
    const wasApplied = Boolean(locked.inventory_applied);
    const willBeOptional = Boolean(locked.optional);
    // A stale unapplied flag is NOT authorization to move the same stock again.
    // Imported transfer movement evidence may exist even when this header flag
    // was never updated. The guard also allows a genuinely fully reversed
    // transfer to post again after its old movement deltas net to zero.
    if (!wasApplied && !willBeOptional) {
      await assertTransferNotAlreadyPostedTx(tx, { companyId, transferId, voucherId });
    }
    const oldDestinationLocationId = Number(locked.destination_location_id);
    const oldRows = await loadTransferItems(tx, transferId);
    const oldItems = oldRows.length
      ? persistedRowsToItems(
          oldRows,
          locked.source_location_id ? Number(locked.source_location_id) : null,
          oldDestinationLocationId
        )
      : [];

    let transition: StockTransferLifecycleResult["transition"];
    if (wasApplied && willBeOptional) transition = "unpost";
    else if (wasApplied && !willBeOptional) transition = "posted-edit";
    else if (!wasApplied && !willBeOptional) transition = "post";
    else transition = "draft-edit";

    // One revision spans the reversal and the reissue of a single edit, so the
    // pair reads back out of the journal as one event rather than two unrelated
    // movements that happen to be adjacent.
    const canonicalRevision = await nextStockTransferRevision(tx, companyId, transferId);

    const deltas: Decimal[] = [];
    if (wasApplied && oldItems.length > 0) {
      deltas.push(
        ...(await reverseAppliedItems(
          tx,
          companyId,
          oldDestinationLocationId,
          oldItems,
          rowValuesByGroup(oldRows, locked.source_location_id ? Number(locked.source_location_id) : null),
          { transferId, revision: canonicalRevision }
        ))
      );
    }

    await assertCompanyScope(tx, companyId, destinationLocationId, normalizedItems);
    let savedItems = await replaceTransferItems(tx, transferId, normalizedItems);
    const shouldApply = !willBeOptional;
    if (shouldApply) {
      const applied = await validateAndApplyItems(tx, companyId, destinationLocationId, normalizedItems, {
        transferId,
        revision: canonicalRevision,
      });
      deltas.push(...applied.deltas);
      await recordTransferValueMovedTx(tx, transferId, applied.relievedByGroup);
      savedItems = await loadTransferItems(tx, transferId);
    }
    await postTransferResidualTx(tx, {
      companyId,
      transferId,
      date: reversalDate(),
      reference: `Transfer ${transferId}`,
      deltas,
    });

    const totalAmount = normalizedItems.reduce(
      (sum, item) => sum.plus(lineAmount(item.quantity, item.rate)),
      new MoneyDecimal(0)
    );
    await tx
      .update(stockTransferVouchers)
      .set({
        sourceLocationId: headerSourceLocationId(normalizedItems),
        destinationLocationId,
        notes: input.notes,
        inventoryApplied: shouldApply,
      })
      .where(eq(stockTransferVouchers.id, transferId));

    const voucherUpdates: Record<string, unknown> = { totalAmount: totalAmount.toFixed(2) };
    if (headerSourceLocationId(normalizedItems)) voucherUpdates.locationId = headerSourceLocationId(normalizedItems);
    if (input.voucherDate !== undefined) voucherUpdates.voucherDate = input.voucherDate;
    // User notes override the automatic location narration. Clearing them
    // restores the generated description in every voucher read path.
    voucherUpdates.description =
      input.notes.trim() ||
      (await stockTransferNarrationTx(
        tx,
        companyId,
        normalizedItems.map((item) => item.sourceLocationId),
        destinationLocationId
      ));
    await tx.update(vouchers).set(voucherUpdates).where(eq(vouchers.id, voucherId));

    return {
      voucherId,
      transferId,
      optional: willBeOptional,
      inventoryApplied: shouldApply,
      transition,
      totalAmount: totalAmount.toFixed(2),
      items: savedItems,
    };
  }
}
