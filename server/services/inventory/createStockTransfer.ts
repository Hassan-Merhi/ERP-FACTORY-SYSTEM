/**
 * The creation of a new stock transfer (voucher, transfer, lines, inventory
 * movement and idempotency marker) on the caller's transaction. Shared by
 * POST /api/stock-transfers and the Phase 9 cloud replay of a transfer made on
 * the factory LAN server, so both move stock identically.
 */
import { and, eq } from "drizzle-orm";
import { stockTransferItems, stockTransferVouchers, vouchers } from "@shared/schema";
import type { DbTransaction } from "../../db";
import { MoneyDecimal, toMoney } from "../../lib/money";
import { allocateVoucherNumberTx } from "../accounting/voucherNumbering";
import { lockInventoryRow } from "../../storage/inventoryRowLock";
import { applyStockTransferInventoryTx, assertTransferCompanyScopeTx } from "../../storage/stock-ops/transfers-create";
import { stockTransferNarrationTx } from "./stockTransferNarration";
import {
  findExistingStockDocumentTx,
  recordStockDocumentTx,
  stockDocumentIdempotencyKey,
  StockDocumentIdempotencyError,
} from "./stockDocumentIdempotency";

export interface CreateStockTransferInput {
  companyId: number;
  /** The caller's clientRequestId (resolved); null serves an unkeyed request as before. */
  requestId: string | null;
  items: Array<{ sourceLocationId?: unknown; stockItemId: unknown; quantity: unknown; rate?: unknown }>;
  sourceLocationId: unknown;
  destinationLocationId: unknown;
  resolvedHeaderSourceId: unknown;
  effectiveDate: string;
  notes: unknown;
  optional: unknown;
  allowNegativeInventory: unknown;
  actorUserId: string | undefined;
  workflowOrigin?: "stock_transfer_order";
}

export async function createStockTransferTx(tx: DbTransaction, input: CreateStockTransferInput) {
  const {
    companyId,
    requestId,
    items,
    sourceLocationId,
    destinationLocationId,
    resolvedHeaderSourceId,
    effectiveDate,
    notes,
    optional,
    allowNegativeInventory,
    workflowOrigin,
  } = input;
  const idempotencyKey = requestId
    ? stockDocumentIdempotencyKey({ sourceType: "stock-transfer", companyId, clientRequestId: requestId })
    : null;
  if (idempotencyKey) {
    const existingTransferId = await findExistingStockDocumentTx({ tx, companyId, idempotencyKey });
    if (existingTransferId) {
      const [existingTransfer] = await tx
        .select()
        .from(stockTransferVouchers)
        .where(eq(stockTransferVouchers.id, existingTransferId))
        .limit(1);
      const [existingVoucher] = existingTransfer
        ? await tx
            .select()
            .from(vouchers)
            .where(and(eq(vouchers.id, existingTransfer.voucherId), eq(vouchers.companyId, companyId)))
            .limit(1)
        : [];
      if (existingTransfer && existingVoucher) {
        const existingItems = await tx
          .select()
          .from(stockTransferItems)
          .where(eq(stockTransferItems.transferId, existingTransfer.id));
        return {
          transfer: existingTransfer,
          transferItems: existingItems,
          newVoucher: existingVoucher,
          replayed: true,
        };
      }
      throw new StockDocumentIdempotencyError(
        "STOCK_DOCUMENT_IDEMPOTENCY_CORRUPT",
        `Stock transfer idempotency marker ${idempotencyKey} references a missing transfer`
      );
    }
  }

  const normalizedMovementItems = [...items]
    .map((item) => ({
      sourceLocationId: Number(item.sourceLocationId || sourceLocationId),
      stockItemId: Number(item.stockItemId),
      quantity: String(item.quantity),
      rate: item.rate == null ? "0" : String(item.rate),
    }))
    .sort((a, b) => a.sourceLocationId - b.sourceLocationId || a.stockItemId - b.stockItemId);

  await assertTransferCompanyScopeTx(tx, companyId, Number(destinationLocationId), normalizedMovementItems);

  const [newVoucher] = await tx
    .insert(vouchers)
    .values({
      companyId,
      voucherType: "Stock Transfer",
      // Phase 22 (B), PE8: the gapless number (a stock document header,
      // no ledger lines, so not an engine posting).
      voucherNumber: await allocateVoucherNumberTx(tx, {
        companyId,
        voucherType: "Stock Transfer",
        voucherDate: effectiveDate,
      }),
      voucherDate: effectiveDate,
      description:
        (typeof notes === "string" ? notes.trim() : "") ||
        (await stockTransferNarrationTx(
          tx,
          companyId,
          normalizedMovementItems.map((item) => item.sourceLocationId),
          Number(destinationLocationId)
        )),
      totalAmount: "0",
      optional: optional === true,
    })
    .returning();

  const [transfer] = await tx
    .insert(stockTransferVouchers)
    .values({
      voucherId: newVoucher.id,
      sourceLocationId: resolvedHeaderSourceId == null ? null : Number(resolvedHeaderSourceId),
      destinationLocationId: Number(destinationLocationId),
      notes: typeof notes === "string" && notes ? notes : null,
      inventoryApplied: optional !== true,
      workflowOrigin: workflowOrigin === "stock_transfer_order" ? "stock_transfer_order" : "stock_transfer",
    })
    .returning();

  // Line totals are taken at cents and the voucher total is their sum,
  // so the header always equals the lines it carries.
  let totalAmount = new MoneyDecimal(0);
  const transferItems = [];

  for (const item of normalizedMovementItems) {
    const quantity = toMoney(item.quantity);
    const sourceInv = await lockInventoryRow(tx, item.sourceLocationId, item.stockItemId);
    const rateText = sourceInv?.average_rate ?? item.rate ?? "0";
    const rate = toMoney(String(rateText || "0"));
    const totalItemAmount = quantity.times(rate).toDecimalPlaces(2);
    totalAmount = totalAmount.plus(totalItemAmount);

    const [insertedItem] = await tx
      .insert(stockTransferItems)
      .values({
        transferId: transfer.id,
        stockItemId: item.stockItemId,
        sourceLocationId: item.sourceLocationId,
        quantity: quantity.toString(),
        rate: rate.toFixed(2),
        totalAmount: totalItemAmount.toFixed(2),
      })
      .returning();

    transferItems.push(insertedItem);
  }

  if (!optional) {
    await applyStockTransferInventoryTx(tx, {
      companyId,
      transferId: transfer.id,
      sourceVoucherId: newVoucher.id,
      destinationLocationId: Number(destinationLocationId),
      items: transferItems.map((item) => ({
        sourceLocationId: item.sourceLocationId!,
        stockItemId: item.stockItemId,
        quantity: item.quantity,
        rate: item.rate,
      })),
      allowNegativeInventory: allowNegativeInventory !== false,
    });
  }

  await tx
    .update(vouchers)
    .set({ totalAmount: totalAmount.toFixed(2) })
    .where(eq(vouchers.id, newVoucher.id));

  if (idempotencyKey) {
    await recordStockDocumentTx({
      tx,
      companyId,
      idempotencyKey,
      documentId: transfer.id,
      sourceType: "stock-transfer",
      actorUserId: input.actorUserId,
    });
  }

  return { transfer, transferItems, newVoucher, replayed: false };
}
