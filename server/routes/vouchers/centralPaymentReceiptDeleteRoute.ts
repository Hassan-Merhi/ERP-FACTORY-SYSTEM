import type { Express, NextFunction, Request, Response } from "express";
import { and, eq, or, sql } from "drizzle-orm";
import {
  interCompanyTransfers,
  intercompanyPaymentRequests,
  propertyPayments,
  salesItems,
  voucherEntries,
  vouchers,
} from "@shared/schema";
import { requireAuth, requireRole } from "../../auth";
import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { voucherMutationBlockReason } from "../../lib/migratedVoucherGuard";
import { storage } from "../../storage";
import { applyEmployeeBalanceDeltasTx } from "../../services/accounting/employeeBalancePosting";
import { removeFactoryDaybookMirrorTx } from "../../services/accounting/factoryDaybookMirrorRemoval";
import {
  isPaymentReceiptVoucherType,
  shouldUseCentralPaymentReceiptDeletion,
} from "../../services/accounting/paymentReceiptDeletionPolicy";
import { buildVoucherChangesForDelete, logAudit, snapshotVoucherEntries } from "../_helpers";
import type { DatabaseOrTransaction } from "../../db";

class LegacyPaymentReceiptDeleteRequired extends Error {}

// Called with both the pool handle and a transaction handle, which share the
// select surface this probe uses.
async function countSalesItems(connection: DatabaseOrTransaction, voucherId: number): Promise<number> {
  const rows = await connection
    .select({ id: salesItems.id })
    .from(salesItems)
    .where(eq(salesItems.voucherId, voucherId))
    .limit(1);
  return rows.length;
}

async function deleteActivePaymentReceipt(req: Request, res: Response, next: NextFunction): Promise<void> {
  const startedAt = Date.now();
  const voucherId = Number(req.params.id);
  const companyId = req.session.currentCompanyId;
  const userId = req.session.userId;

  if (!Number.isInteger(voucherId) || voucherId <= 0) {
    res.status(400).json({ message: "Invalid voucher ID" });
    return;
  }
  if (!companyId) {
    res.status(400).json({ message: "No company selected" });
    return;
  }

  try {
    const voucher = await storage.getVoucherById(voucherId);
    if (!voucher) {
      res.status(404).json({ message: "Voucher not found" });
      return;
    }
    if (voucher.companyId !== companyId) {
      res.status(403).json({ message: "Access denied: Voucher belongs to a different company" });
      return;
    }
    const blockedVoucherReason = voucherMutationBlockReason(voucher);
    if (blockedVoucherReason) {
      res.status(403).json({ message: blockedVoucherReason });
      return;
    }

    const salesItemCount = voucher.voucherType === "Receipt" ? await countSalesItems(db, voucherId) : 0;
    if (
      !shouldUseCentralPaymentReceiptDeletion({
        voucherType: voucher.voucherType,
        optional: voucher.optional,
        voucherNumber: voucher.voucherNumber,
        salesItemCount,
      })
    ) {
      next();
      return;
    }

    const deletion = await db.transaction(async (tx) => {
      await tx.execute(sql`
        SELECT id FROM vouchers
        WHERE id = ${voucherId} AND company_id = ${companyId}
        FOR UPDATE
      `);

      const [lockedVoucher] = await tx
        .select()
        .from(vouchers)
        .where(and(eq(vouchers.id, voucherId), eq(vouchers.companyId, companyId)))
        .limit(1);

      if (!lockedVoucher) throw new Error("Voucher not found");
      if (lockedVoucher.deletedAt) {
        return {
          replayed: true,
          voucher: lockedVoucher,
          entries: [],
        };
      }

      const lockedSalesItemCount = lockedVoucher.voucherType === "Receipt" ? await countSalesItems(tx, voucherId) : 0;
      if (
        !shouldUseCentralPaymentReceiptDeletion({
          voucherType: lockedVoucher.voucherType,
          optional: lockedVoucher.optional,
          voucherNumber: lockedVoucher.voucherNumber,
          salesItemCount: lockedSalesItemCount,
        })
      ) {
        throw new LegacyPaymentReceiptDeleteRequired();
      }

      if (!isPaymentReceiptVoucherType(lockedVoucher.voucherType)) {
        throw new LegacyPaymentReceiptDeleteRequired();
      }

      const entries = await tx.select().from(voucherEntries).where(eq(voucherEntries.voucherId, voucherId));

      await applyEmployeeBalanceDeltasTx({
        tx,
        companyId,
        entries,
        direction: "reverse",
        missingEmployeeBehavior: "skip",
      });

      // Preserve the existing rental/property cleanup for any Payment/Receipt
      // voucher linked to a property payment row.
      const linkedPayments = await tx.select().from(propertyPayments).where(eq(propertyPayments.voucherId, voucherId));
      for (const payment of linkedPayments) {
        if (payment.ledgerRowId) {
          await tx.execute(sql`
            UPDATE property_monthly_ledger
            SET paid_amount = GREATEST(0, paid_amount - ${payment.amount}::numeric)
            WHERE id = ${payment.ledgerRowId}
          `);
        }
        await tx.delete(propertyPayments).where(eq(propertyPayments.id, payment.id));
      }

      // Preserve the existing intercompany cleanup order: remove the transfer
      // row first, then hard-delete the counterpart entries and voucher.
      const linkedTransfers = await tx
        .select()
        .from(interCompanyTransfers)
        .where(
          or(eq(interCompanyTransfers.fromVoucherId, voucherId), eq(interCompanyTransfers.toVoucherId, voucherId))
        );
      for (const transfer of linkedTransfers) {
        const otherVoucherId = transfer.fromVoucherId === voucherId ? transfer.toVoucherId : transfer.fromVoucherId;
        await tx.delete(interCompanyTransfers).where(eq(interCompanyTransfers.id, transfer.id));
        if (otherVoucherId && otherVoucherId !== voucherId) {
          await tx.delete(voucherEntries).where(eq(voucherEntries.voucherId, otherVoucherId));
          await tx.delete(vouchers).where(eq(vouchers.id, otherVoucherId));
          // The counterpart voucher is gone entirely, so its mirror would
          // reference nothing at all.
          await removeFactoryDaybookMirrorTx({ tx, voucherId: otherVoucherId });
        }
      }

      await tx
        .delete(intercompanyPaymentRequests)
        .where(
          and(
            eq(intercompanyPaymentRequests.fromVoucherId, voucherId),
            eq(intercompanyPaymentRequests.status, "pending")
          )
        );

      // The Daybook mirror is written inside the posting transaction; it is
      // withdrawn inside the cancelling one, or the Daybook keeps reporting the
      // cash movement of a voucher that no longer stands.
      await removeFactoryDaybookMirrorTx({ tx, companyId, voucherId });

      await tx
        .update(vouchers)
        .set({ deletedAt: new Date() })
        .where(and(eq(vouchers.id, voucherId), eq(vouchers.companyId, companyId)));

      return {
        replayed: false,
        voucher: lockedVoucher,
        entries,
      };
    });

    if (!deletion.replayed) {
      try {
        const entrySnapshot = await snapshotVoucherEntries(deletion.entries);
        await logAudit({
          userId: userId!,
          username: req.session.username || "unknown",
          companyId,
          action: "delete",
          tableName: "vouchers",
          recordId: voucherId,
          recordIdentifier: deletion.voucher.voucherNumber,
          changes: buildVoucherChangesForDelete(deletion.voucher, entrySnapshot),
        });
      } catch (error: unknown) {
        logger.error("Central Payment/Receipt delete audit failed (non-fatal)", {
          companyId,
          voucherId,
          error,
        });
      }
    }

    logger.info("central Payment/Receipt delete succeeded", {
      module: "vouchers",
      action: "deletePaymentReceiptCentral",
      userId,
      companyId,
      voucherId,
      replayed: deletion.replayed,
      durationMs: Date.now() - startedAt,
    });

    res.json({
      message: "Voucher deleted successfully",
      replayed: deletion.replayed,
    });
  } catch (error: unknown) {
    if (error instanceof LegacyPaymentReceiptDeleteRequired) {
      next();
      return;
    }

    logger.error("central Payment/Receipt delete failed", {
      module: "vouchers",
      action: "deletePaymentReceiptCentral",
      userId,
      companyId,
      voucherId,
      durationMs: Date.now() - startedAt,
      error,
    });
    res.status(500).json({ message: getErrorMessage(error) });
  }
}

export function registerCentralPaymentReceiptDeleteRoute(app: Express): void {
  app.delete(
    "/api/vouchers/:id",
    requireAuth,
    requireRole("Admin"),
    (req, res, next) => void deleteActivePaymentReceipt(req, res, next)
  );
}
