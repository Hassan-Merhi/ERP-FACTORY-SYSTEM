import type { Express, NextFunction, Request, Response } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { vouchers } from "@shared/schema";
import { requireAuth, requireRole } from "../../auth";
import { db } from "../../db";
import { logger } from "../../lib/logger";
import { buildVoucherChangesForDelete, logAudit, snapshotVoucherEntries } from "../_helpers";
import {
  deleteStockTransferVoucher,
  isStockTransferVoucherType,
  StockTransferDeletionError,
} from "../../services/stockTransferDeletion";

function parseVoucherId(value: unknown): number | null {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function deleteStockTransfer(req: Request, res: Response, next: NextFunction): Promise<void> {
  const voucherId = parseVoucherId(req.params.id);
  if (!voucherId) {
    res.status(400).json({ message: "Invalid voucher ID" });
    return;
  }

  const companyId = req.session.currentCompanyId;
  if (!companyId) {
    res.status(400).json({ message: "No company selected" });
    return;
  }

  // Dispatch check only. The service repeats ownership/type checks while holding
  // the voucher row lock, so this lookup is never trusted for mutation safety.
  const [candidate] = await db
    .select({ companyId: vouchers.companyId, voucherType: vouchers.voucherType })
    .from(vouchers)
    .where(eq(vouchers.id, voucherId))
    .limit(1);

  if (!candidate || !isStockTransferVoucherType(candidate.voucherType)) {
    next();
    return;
  }
  if (candidate.companyId !== companyId) {
    res.status(403).json({ message: "Access denied: Voucher belongs to a different company" });
    return;
  }

  try {
    // Wave 16 (B): the audit row is written in the deleting transaction.
    const result = await deleteStockTransferVoucher({
      companyId,
      voucherId,
      audit: async (tx, deleted) => {
        const entrySnapshot = await snapshotVoucherEntries(deleted.entries, tx);
        await logAudit(
          {
            userId: req.session.userId!,
            username: req.session.username || "unknown",
            companyId,
            action: "delete",
            tableName: "vouchers",
            recordId: voucherId,
            recordIdentifier: deleted.voucher.voucherNumber,
            changes: buildVoucherChangesForDelete(deleted.voucher, entrySnapshot),
          },
          tx
        );
      },
    });

    logger.info("central stock transfer delete succeeded", {
      module: "stock-transfer",
      action: "deleteStockTransferCentral",
      companyId,
      voucherId,
      transferId: result.transferId,
      replayed: result.replayed,
      reversedInventory: result.reversedInventory,
    });

    res.json({
      message: "Voucher deleted successfully",
      replayed: result.replayed,
      reversedInventory: result.reversedInventory,
    });
  } catch (error: unknown) {
    if (error instanceof StockTransferDeletionError) {
      res.status(error.status).json({ message: error.message, code: error.code });
      return;
    }
    logger.error("central stock transfer delete failed", {
      module: "stock-transfer",
      action: "deleteStockTransferCentral",
      companyId,
      voucherId,
      error,
    });
    res.status(500).json({ message: error instanceof Error ? error.message : "Failed to delete stock transfer" });
  }
}

async function blockUnsafeBulkStockTransferDelete(req: Request, res: Response, next: NextFunction): Promise<void> {
  const companyId = req.session.currentCompanyId;
  if (!companyId || !Array.isArray(req.body?.voucherIds)) {
    next();
    return;
  }

  const ids: number[] = Array.from(
    new Set(
      req.body.voucherIds
        .map((value: unknown) => parseVoucherId(value))
        .filter((value: number | null): value is number => value !== null)
    )
  );
  if (ids.length === 0) {
    next();
    return;
  }

  const rows = await db
    .select({ id: vouchers.id, voucherType: vouchers.voucherType })
    .from(vouchers)
    .where(and(eq(vouchers.companyId, companyId), inArray(vouchers.id, ids)));
  const stockTransferIds = rows.filter((row) => isStockTransferVoucherType(row.voucherType)).map((row) => row.id);

  if (stockTransferIds.length === 0) {
    next();
    return;
  }

  // The legacy mixed bulk-delete loop does not lock transfer headers and can
  // double-reverse stock under concurrent requests. Block that path until bulk
  // deletion is migrated to the same transaction-owned lifecycle service.
  res.status(409).json({
    code: "STOCK_TRANSFER_BULK_DELETE_REQUIRES_SINGLE",
    message: "Delete stock transfer vouchers individually so inventory reversal is locked and replay-safe.",
    stockTransferVoucherIds: stockTransferIds,
  });
}

export function registerCentralStockTransferDeleteRoutes(app: Express): void {
  app.delete(
    "/api/vouchers/:id",
    requireAuth,
    requireRole("Admin"),
    (req, res, next) => void deleteStockTransfer(req, res, next)
  );

  app.post(
    "/api/vouchers/bulk-delete",
    requireAuth,
    requireRole("Admin"),
    (req, res, next) => void blockUnsafeBulkStockTransferDelete(req, res, next)
  );
}
