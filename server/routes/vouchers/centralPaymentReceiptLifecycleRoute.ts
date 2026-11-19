import type { Express, NextFunction, Request, Response } from "express";
import { and, eq, sql } from "drizzle-orm";
import { voucherEntries, vouchers } from "@shared/schema";
import { requireAuth, requireNonPOS } from "../../auth";
import { db } from "../../db";
import { getErrorMessage, errorStatus } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { voucherMutationBlockReason } from "../../lib/migratedVoucherGuard";
import {
  intercompanyTransferOfVoucher,
  sendIntercompanyTransferLegRefusal,
} from "../../services/accounting/intercompanyTransferLegGuard";
import { storage } from "../../storage";
import { PostingValidationError } from "../../services/accounting/centralPostingEngine";
import { applyEmployeeBalanceDeltasTx } from "../../services/accounting/employeeBalancePosting";
import { buildPaymentReceiptPostingRequest } from "../../services/accounting/paymentReceiptPosting";
import { syncContainerChargeVoucherEditTx } from "../../services/containers/offload-lifecycle/charge-voucher-sync";
import { checkAccountWhatsAppRule } from "../factoryWhatsappRoutes";
import { offlineEdgeText } from "../../i18n/offlineEdgeMessages";
import {
  assertVoucherEditableTx,
  recordVoucherEditAuditTx,
  sendVoucherCorrectionRefusal,
} from "../../services/accounting/voucherCorrection";
import { rebalanceVoucherRoundingTx } from "../../services/accounting/engineRounding";
import {
  buildLegacyPaymentReceiptEditTarget,
  isActivePaymentReceiptType,
  postingDependencies,
  updateIntercompanyPaymentReceiptAccounts,
  type CentralPaymentReceiptBody,
} from "./buildLegacyPaymentReceiptEditTarget";
import { phase9PaymentFollowUpCaptureActive } from "../../edge/phase9PaymentOutbox";
export { buildLegacyPaymentReceiptEditTarget } from "./buildLegacyPaymentReceiptEditTarget";

async function updateActivePaymentReceipt(req: Request, res: Response, next: NextFunction): Promise<void> {
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
    const existing = await storage.getVoucherById(voucherId);
    if (!existing) {
      res.status(404).json({ message: "Voucher not found" });
      return;
    }
    if (existing.companyId !== companyId) {
      res.status(403).json({ message: "Access denied: Voucher belongs to a different company" });
      return;
    }
    const blockedVoucherReason = voucherMutationBlockReason(existing);
    if (blockedVoucherReason) {
      res.status(403).json({ message: blockedVoucherReason });
      return;
    }

    const body = req.body as CentralPaymentReceiptBody;
    const linkedTransfer = await intercompanyTransferOfVoucher(voucherId);
    // Factory LAN server (plan batch 4): the edit route that records the change
    // for the cloud serves it; an intercompany transfer leg stays online-only.
    // A PC in entry mode is served the same way: its recording route captures the change.
    if (phase9PaymentFollowUpCaptureActive()) {
      if (linkedTransfer) {
        res.status(409).json({
          code: "EDGE_PAYMENT_INTERCOMPANY_ONLINE_ONLY",
          message: offlineEdgeText("paymentIntercompanyOnlineOnly", req.headers["accept-language"]),
        });
        return;
      }
      next();
      return;
    }
    if (linkedTransfer) {
      // Only a same-amount, same-date ledger-account correction is permitted
      // for a linked transfer. Every other generic mutation remains a 409.
      const corrected = await updateIntercompanyPaymentReceiptAccounts({
        voucherId,
        companyId,
        userId,
        username: req.session.username,
        body,
      });
      res.json(corrected);
      return;
    }
    // Keep optional transitions and all non-Payment/Receipt edits on the legacy route.
    if (
      !isActivePaymentReceiptType(existing.voucherType) ||
      existing.optional ||
      body.optional === true ||
      !isActivePaymentReceiptType(body.voucherType)
    ) {
      next();
      return;
    }

    if (!body.voucherDate || !body.paymentAccountId || !Array.isArray(body.entries) || body.entries.length === 0) {
      res.status(400).json({ message: "Missing required fields" });
      return;
    }

    const result = await db.transaction(async (tx) => {
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

      if (!lockedVoucher || lockedVoucher.deletedAt) {
        throw new Error("Voucher not found or already deleted");
      }
      if (!isActivePaymentReceiptType(lockedVoucher.voucherType) || lockedVoucher.optional) {
        throw new Error("Payment/Receipt compatibility state changed during update");
      }
      // Phase 22 A (correction policy): open period only (409
      // VOUCHER_CLOSED_PERIOD_REVERSE_INSTEAD otherwise); a reversed voucher is not edited.
      const editContext = await assertVoucherEditableTx(tx, voucherId, {
        companyId,
        newVoucherDate: String(body.voucherDate),
        newEffectiveDate: body.effectiveDate ? String(body.effectiveDate) : null,
      });

      const built = await buildPaymentReceiptPostingRequest({
        companyId,
        voucherNumber: lockedVoucher.voucherNumber,
        voucherType: body.voucherType,
        voucherDate: body.voucherDate,
        paymentAccountType: body.paymentAccountType,
        paymentAccountId: body.paymentAccountId,
        paymentAccountNarration: body.paymentAccountNarration,
        entries: body.entries,
        notes: body.notes,
        currency: body.currency || "USD",
        exchangeRate: body.exchangeRate ?? null,
        effectiveDate: body.effectiveDate || null,
        clientRequestId: body.clientRequestId || `payment-receipt-update-${voucherId}-${Date.now()}`,
        actor: {
          userId: userId ?? null,
          username: req.session.username || "unknown",
          reason: `${body.voucherType} voucher update`,
        },
        resolveTarget: async (accountType, accountId) => buildLegacyPaymentReceiptEditTarget(accountType, accountId),
      });

      await postingDependencies.ownership.validateVoucherOwnership({
        tx,
        companyId,
        voucher: built.request.voucher,
        entries: built.request.entries,
      });

      const oldEntries = await tx.select().from(voucherEntries).where(eq(voucherEntries.voucherId, voucherId));

      await applyEmployeeBalanceDeltasTx({
        tx,
        companyId,
        entries: oldEntries,
        direction: "reverse",
        missingEmployeeBehavior: "skip",
      });

      // Preserve the legacy edit contract: voucher currency/exchangeRate are not
      // rewritten by this endpoint; submitted currency metadata is used for the
      // replacement entry normalization and historical base total.
      const [updatedVoucher] = await tx
        .update(vouchers)
        .set({
          voucherType: body.voucherType,
          voucherDate: built.request.voucher.voucherDate,
          description: built.request.voucher.description ?? null,
          totalAmount: built.request.voucher.totalAmount,
          optional: false,
          effectiveDate: built.request.voucher.effectiveDate ?? null,
        })
        .where(and(eq(vouchers.id, voucherId), eq(vouchers.companyId, companyId)))
        .returning();

      await tx.delete(voucherEntries).where(eq(voucherEntries.voucherId, voucherId));
      const insertedEntries = await tx
        .insert(voucherEntries)
        .values(built.request.entries.map((entry) => ({ voucherId, ...entry })))
        .returning();

      await applyEmployeeBalanceDeltasTx({
        tx,
        companyId,
        entries: insertedEntries,
        direction: "apply",
        missingEmployeeBehavior: "throw",
      });
      // Phase 22 A (D3): an engine voucher balances exactly (ROUNDING line).
      await rebalanceVoucherRoundingTx(tx, { companyId, voucherId });

      // An edited duty/transport/office charge voucher re-prices the offloaded bales.
      await syncContainerChargeVoucherEditTx(tx, {
        companyId,
        voucherNumber: lockedVoucher.voucherNumber,
        oldTotal: lockedVoucher.totalAmount,
        newTotal: updatedVoucher.totalAmount,
      });

      // Wave 16 (B) / phase 22 A: the edit replaces the voucher's lines (delete
      // and re-insert, the legacy edit contract). The full header and every line
      // before and after are audited in this transaction, so a failed audit
      // rolls the edit back.
      const audited = await recordVoucherEditAuditTx(tx, {
        voucherId,
        before: editContext.before,
        actor: { userId: userId ?? null, username: req.session.username || "unknown", companyId },
        reason: `${body.voucherType} voucher update`,
      });
      const createdEntries = audited.entries;

      return {
        voucher: updatedVoucher,
        entries: createdEntries,
      };
    });

    let whatsapp: {
      prompt: boolean;
      accountId?: number;
      voucherDate?: string;
      month?: string;
    } = { prompt: false };
    try {
      whatsapp = await checkAccountWhatsAppRule({
        companyId,
        accountId: Number(body.paymentAccountId),
        accountType: String(body.paymentAccountType),
        voucherType: body.voucherType,
        voucherDate: body.voucherDate,
      });
    } catch (error: unknown) {
      logger.error("Central Payment/Receipt update WhatsApp check failed (non-fatal)", {
        companyId,
        voucherId,
        error,
      });
    }

    logger.info("central Payment/Receipt update succeeded", {
      module: "vouchers",
      action: "updatePaymentReceiptCentral",
      userId,
      companyId,
      voucherId,
      durationMs: Date.now() - startedAt,
    });

    res.json({ voucher: result.voucher, entries: result.entries, whatsapp });
  } catch (error: unknown) {
    logger.error("central Payment/Receipt update failed", {
      module: "vouchers",
      action: "updatePaymentReceiptCentral",
      userId,
      companyId,
      voucherId,
      durationMs: Date.now() - startedAt,
      error,
    });
    if (sendIntercompanyTransferLegRefusal(res, error)) return;
    if (sendVoucherCorrectionRefusal(res, error)) return;
    if (error instanceof PostingValidationError) {
      res.status(400).json({ message: error.message, code: error.code });
      return;
    }
    res.status(errorStatus(error)).json({ message: getErrorMessage(error) });
  }
}

export function registerCentralPaymentReceiptLifecycleRoutes(app: Express): void {
  app.patch(
    "/api/vouchers/:id/payment-receipt",
    requireAuth,
    requireNonPOS,
    (req, res, next) => void updateActivePaymentReceipt(req, res, next)
  );
}
