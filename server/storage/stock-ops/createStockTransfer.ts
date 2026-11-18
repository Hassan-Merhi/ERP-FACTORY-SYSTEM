// Extracted from ./transfers-create.ts to keep that module under the source-size cap.
import { eq } from "drizzle-orm";
import { db } from "../../db";
import {
  addInventoryValues,
  inventoryMoney,
  inventoryQuantity,
  inventoryUnitCost,
  multiplyInventoryValues,
  toInventoryDecimal,
} from "../../lib/inventoryMath";
import * as schema from "@shared/schema";
import { type StockTransferItem } from "@shared/schema";
import { stockTransferNarrationTx } from "../../services/inventory/stockTransferNarration";
import { lockInventoryRow } from "../inventoryRowLock";
import {
  DuplicateStockTransferError,
  StockTransferPolicyError,
  applyStockTransferInventoryTx,
  assertTransferCompanyScopeTx,
  type TransferMovementItem,
} from "./applyStockTransferInventoryTx";

export async function createStockTransfer(
  voucherId: number,
  destinationLocationId: number,
  notes: string,
  items: TransferMovementItem[],
  options: { allowNegativeInventory?: boolean; activeCompanyId?: number } = {}
) {
  return await db.transaction(async (tx) => {
    // The lock makes the duplicate check below decisive: two submissions for the
    // same voucher are ordered, and the second one finds the first one's row.
    const [voucher] = await tx.select().from(schema.vouchers).where(eq(schema.vouchers.id, voucherId)).for("update");
    if (!voucher) throw new Error(`Voucher ${voucherId} not found`);
    if (options.activeCompanyId !== undefined && voucher.companyId !== options.activeCompanyId) {
      throw new StockTransferPolicyError("STOCK_TRANSFER_SCOPE_INVALID", "Voucher belongs to a different company");
    }
    const isOptional = voucher.optional;

    const [duplicate] = await tx
      .select({ id: schema.stockTransferVouchers.id })
      .from(schema.stockTransferVouchers)
      .where(eq(schema.stockTransferVouchers.voucherId, voucherId))
      .limit(1);
    if (duplicate) throw new DuplicateStockTransferError(voucherId);

    if (!items || items.length === 0) throw new Error("No items provided for stock transfer");

    const sortedTransferItems = [...items].sort(
      (a, b) => a.sourceLocationId - b.sourceLocationId || a.stockItemId - b.stockItemId
    );

    // Resolve historical transfer cost from the locked source row whenever it
    // exists. The browser can display/submit a rounded rate, but that must not
    // become the accounting source of truth. A genuinely missing source has no
    // inventory cost to read, so its submitted rate is retained as the cost
    // memory used when an explicitly permitted negative row is created.
    const costedTransferItems: TransferMovementItem[] = [];
    for (const item of sortedTransferItems) {
      const sourceInventory = await lockInventoryRow(tx, item.sourceLocationId, item.stockItemId);
      costedTransferItems.push({
        ...item,
        rate: String(sourceInventory?.average_rate ?? item.rate ?? "0"),
      });
    }

    // Validate tenant ownership before writing the transfer header. This is
    // repeated by the movement helper immediately before applying stock so both
    // document-only (optional) and posted transfers share the same boundary.
    await assertTransferCompanyScopeTx(tx, voucher.companyId, destinationLocationId, costedTransferItems);

    const [transfer] = await tx
      .insert(schema.stockTransferVouchers)
      .values({
        voucherId,
        sourceLocationId:
          new Set(costedTransferItems.map((item) => item.sourceLocationId)).size === 1
            ? costedTransferItems[0].sourceLocationId
            : null,
        destinationLocationId,
        notes,
        inventoryApplied: !isOptional,
      })
      .returning();

    const transferItems: StockTransferItem[] = [];
    let totalAmount = toInventoryDecimal(0);
    for (const item of costedTransferItems) {
      const quantity = toInventoryDecimal(item.quantity);
      const rate = toInventoryDecimal(item.rate);
      const lineTotal = multiplyInventoryValues(quantity, rate);
      totalAmount = addInventoryValues(totalAmount, lineTotal);

      const [transferItem] = await tx
        .insert(schema.stockTransferItems)
        .values({
          transferId: transfer.id,
          stockItemId: item.stockItemId,
          sourceLocationId: item.sourceLocationId,
          quantity: inventoryQuantity(quantity),
          rate: inventoryUnitCost(rate),
          totalAmount: inventoryMoney(lineTotal),
        })
        .returning();

      transferItems.push(transferItem);
    }

    if (!isOptional) {
      await applyStockTransferInventoryTx(tx, {
        companyId: voucher.companyId,
        transferId: transfer.id,
        sourceVoucherId: voucherId,
        destinationLocationId,
        items: transferItems.map((item) => ({
          sourceLocationId: item.sourceLocationId!,
          stockItemId: item.stockItemId,
          quantity: item.quantity,
          rate: item.rate,
        })),
        // Internal callers historically permitted negative stock. HTTP callers
        // pass the explicit UI policy through options, so this default preserves
        // old storage-level behavior without weakening the route.
        allowNegativeInventory: options.allowNegativeInventory ?? true,
      });
    }

    await tx
      .update(schema.vouchers)
      .set({
        description:
          notes.trim() ||
          (await stockTransferNarrationTx(
            tx,
            voucher.companyId,
            costedTransferItems.map((item) => item.sourceLocationId),
            destinationLocationId
          )),
        totalAmount: inventoryMoney(totalAmount),
      })
      .where(eq(schema.vouchers.id, voucherId));

    return { transfer, items: transferItems };
  });
}

export type StockAdjustmentType = "Production" | "Consumption" | "Mixed";

export type StockAdjustmentInputItem = { stockItemId: number; quantity: string; rate: string };
