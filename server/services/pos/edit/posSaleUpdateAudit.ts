/**
 * Phase 21 (B): the POS sale edit audit, written on the edit's transaction so
 * a failed audit insert rolls the edit back and a rolled-back edit leaves no
 * audit row. The row content is the one the after-commit audit used to write.
 */
import type { DbTransaction } from "../../../db";
import { logAudit } from "../../../routes/_helpers";
import { recordVoucherEditAuditTx } from "../../accounting/voucherCorrection";
import { salesItems, stockItems, vouchers } from "@shared/schema";
import { eq, inArray } from "drizzle-orm";
import type { PosSaleUpdateTransactionResult } from "./updateSaleService";

export async function writePosSaleUpdateAuditTx(
  tx: DbTransaction,
  params: { voucherId: number; companyId: number; userId: string; username: string },
  transactionResult: PosSaleUpdateTransactionResult
): Promise<void> {
  const { voucherId } = params;
  const existingVoucher = transactionResult.existingVoucher!;
  const [updatedVoucher] = await tx.select().from(vouchers).where(eq(vouchers.id, voucherId)).limit(1);
  const updatedSalesItems = await tx
    .select({
      stockItemId: salesItems.stockItemId,
      stockItemName: stockItems.name,
      stockItemCode: stockItems.code,
      quantity: salesItems.quantity,
      sellingPrice: salesItems.sellingPrice,
      totalSales: salesItems.totalSales,
    })
    .from(salesItems)
    .innerJoin(stockItems, eq(salesItems.stockItemId, stockItems.id))
    .where(eq(salesItems.voucherId, voucherId));

  const oldAuditRows = transactionResult.auditOldItems ?? [];
  const oldItemIds = Array.from(new Set(oldAuditRows.map((item) => item.stockItemId)));
  const oldItemNames =
    oldItemIds.length > 0
      ? await tx
          .select({ id: stockItems.id, name: stockItems.name, code: stockItems.code })
          .from(stockItems)
          .where(inArray(stockItems.id, oldItemIds))
      : [];
  const oldItemNameMap = new Map(oldItemNames.map((item) => [item.id, item] as const));

  const changes: Record<string, { old?: unknown; new?: unknown }> = {};
  if (existingVoucher.totalAmount !== updatedVoucher?.totalAmount)
    changes.totalAmount = { old: existingVoucher.totalAmount, new: updatedVoucher?.totalAmount };
  if (existingVoucher.voucherDate !== updatedVoucher?.voucherDate)
    changes.date = { old: existingVoucher.voucherDate, new: updatedVoucher?.voucherDate };
  if (existingVoucher.locationId !== updatedVoucher?.locationId)
    changes.locationId = { old: existingVoucher.locationId, new: updatedVoucher?.locationId };
  changes.itemCount = { new: updatedSalesItems.length };
  changes.items = {
    old: oldAuditRows.map((item) => ({
      stockItemId: item.stockItemId,
      stockItemName: oldItemNameMap.get(item.stockItemId)?.name ?? `Item #${item.stockItemId}`,
      code: oldItemNameMap.get(item.stockItemId)?.code ?? null,
      quantity: item.quantity,
      rate: item.rate,
      totalAmount: item.totalAmount,
    })),
    new: updatedSalesItems.map((item) => ({
      stockItemId: item.stockItemId,
      stockItemName: item.stockItemName,
      code: item.stockItemCode,
      quantity: item.quantity,
      rate: item.sellingPrice,
      totalAmount: item.totalSales,
    })),
  };
  // Phase 22 (B): one row — the correction policy's full before/after snapshot
  // with the readable sale changes.
  if (transactionResult.editBefore) {
    await recordVoucherEditAuditTx(tx, {
      voucherId,
      before: transactionResult.editBefore,
      actor: { userId: params.userId, username: params.username, companyId: params.companyId },
      reason: "POS sale edit",
      extra: changes,
    });
    return;
  }
  await logAudit(
    {
      userId: params.userId,
      username: params.username,
      companyId: params.companyId,
      action: "update",
      tableName: "vouchers",
      recordId: voucherId,
      recordIdentifier: updatedVoucher?.voucherNumber ?? existingVoucher.voucherNumber,
      changes,
    },
    tx
  );
}
