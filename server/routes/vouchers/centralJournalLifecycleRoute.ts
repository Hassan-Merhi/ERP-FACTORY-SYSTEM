import type { Express, NextFunction, Request, Response } from "express";
import { and, eq, or, sql } from "drizzle-orm";
import {
  interCompanyTransfers,
  intercompanyPaymentRequests,
  propertyPayments,
  voucherEntries,
  vouchers,
} from "@shared/schema";
import { requireAuth, requireNonPOS, requireRole } from "../../auth";
import { db } from "../../db";
import { getErrorMessage, errorStatus } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { voucherMutationBlockReason } from "../../lib/migratedVoucherGuard";
import { storage } from "../../storage";
import { applyEmployeeBalanceDeltasTx } from "../../services/accounting/employeeBalancePosting";
import { softDeleteInterCompanyCounterpartTx } from "../voucher-entries/delete";
import { writeVoucherAuditTx } from "../helpers/voucherAuditTrail";
import { assertVoucherEditableTx, sendVoucherCorrectionRefusal } from "../../services/accounting/voucherCorrection";
import { updateActiveJournal } from "./updateActiveJournal";

// Phase 22 (B), D8: the counterpart rescale lives in intercompanyCounterpartRescale.ts.
export {
  INTERCOMPANY_COUNTERPART_MIXED_CURRENCY_MESSAGE,
  INTERCOMPANY_COUNTERPART_ZERO_TOTAL_MESSAGE,
} from "./intercompanyCounterpartRescale";

async function deleteActiveJournal(req: Request, res: Response, next: NextFunction): Promise<void> {
  const voucherId = Number(req.params.id);
  const companyId = req.session.currentCompanyId;
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

    // Keep every non-journal and optional-voucher deletion on the existing route.
    if (voucher.voucherType !== "Journal" || voucher.optional) {
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
        return { replayed: true, voucher: lockedVoucher, entries: [] };
      }
      // Phase 22 A: not in a closed period (reverse instead); not an original with a live reversal.
      await assertVoucherEditableTx(tx, voucherId, { companyId, purpose: "delete" });

      const entries = await tx.select().from(voucherEntries).where(eq(voucherEntries.voucherId, voucherId));
      await applyEmployeeBalanceDeltasTx({
        tx,
        companyId,
        entries,
        direction: "reverse",
        missingEmployeeBehavior: "skip",
      });

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

      const linkedTransfers = await tx
        .select()
        .from(interCompanyTransfers)
        .where(
          or(eq(interCompanyTransfers.fromVoucherId, voucherId), eq(interCompanyTransfers.toVoucherId, voucherId))
        );
      for (const transfer of linkedTransfers) {
        // Wave 9: the other company's voucher is soft-deleted and audited, never hard-deleted.
        await tx.delete(interCompanyTransfers).where(eq(interCompanyTransfers.id, transfer.id));
        await softDeleteInterCompanyCounterpartTx(tx, {
          transfer,
          voucherId,
          voucherNumber: voucher.voucherNumber,
          actor: { userId: req.session.userId, username: req.session.username },
        });
      }

      await tx
        .delete(intercompanyPaymentRequests)
        .where(
          and(
            eq(intercompanyPaymentRequests.fromVoucherId, voucherId),
            eq(intercompanyPaymentRequests.status, "pending")
          )
        );
      await tx
        .update(vouchers)
        .set({ deletedAt: new Date() })
        .where(and(eq(vouchers.id, voucherId), eq(vouchers.companyId, companyId)));

      // Wave 12 (decision 2): audited with every line in this transaction.
      await writeVoucherAuditTx(tx, {
        actor: { userId: req.session.userId, username: req.session.username, companyId },
        action: "delete",
        voucherId,
        before: { voucher: lockedVoucher, entries },
        after: null,
        extra: { softDelete: { new: true } },
      });

      return { replayed: false, voucher: lockedVoucher, entries };
    });

    res.json({
      message: "Voucher deleted successfully",
      replayed: deletion.replayed,
    });
  } catch (error: unknown) {
    logger.error("central journal delete failed", {
      module: "vouchers",
      action: "deleteJournalCentral",
      companyId,
      voucherId,
      error,
    });
    if (sendVoucherCorrectionRefusal(res, error)) return;
    res.status(errorStatus(error)).json({ message: getErrorMessage(error) });
  }
}

export function registerCentralJournalLifecycleRoutes(app: Express): void {
  app.patch(
    "/api/vouchers/:id/journal",
    requireAuth,
    requireNonPOS,
    (req, res, next) => void updateActiveJournal(req, res, next)
  );
  app.delete(
    "/api/vouchers/:id",
    requireAuth,
    requireRole("Admin"),
    (req, res, next) => void deleteActiveJournal(req, res, next)
  );
}
