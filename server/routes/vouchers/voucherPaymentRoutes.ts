import { assertApprovedZmwVoucherRate } from "../../services/accounting/zambiaVoucherRatePolicy";
import type { Express } from "express";
import { getErrorMessage, errorStatus } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { db } from "../../db";
import { requireAuth, requireNonPOS } from "../../auth";
import { erpRequestSourceId } from "../../services/accounting/erpVoucherPosting";
import { sendVoucherCorrectionRefusal } from "../../services/accounting/voucherCorrection";
import { triggerIntercompanyNotifications } from "../intercompanyNotificationRoutes";
import { autoReallocateLoansAccounts } from "../../lib/transporterAllocation";
import { vouchers } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import { checkAccountWhatsAppRule } from "../factoryWhatsappRoutes";

import { randomUUID } from "node:crypto";
import {
  paymentVoucherTotals,
  postPaymentReceiptVoucherTx,
  writePaymentReceiptDaybookEntry,
} from "../../services/accounting/paymentReceiptVoucherPosting";
import { isPhase9LanPrimary } from "../../edge/phase9PosOutbox";
import {
  capturePhase9PaymentEditTx,
  capturePhase9PaymentTx,
  paymentFollowUpActor,
  paymentReceiptEvidence,
  phase9PaymentSnapshotTx,
  phase9PaymentVoucherRefTx,
} from "../../edge/phase9PaymentOutbox";
import { applyPaymentReceiptEditTx, paymentReceiptEditPlan } from "../../services/accounting/paymentReceiptVoucherEdit";

/**
 * After saving a journal voucher, if it has a customer entry + a ledger account entry,
 * look for order charges linked to that ledger account for that customer.
 * If exactly one charge is found, update its amount and recalculate the order totals.
 */

export function registerVoucherPaymentRoutes(app: Express) {
  app.post("/api/vouchers/payment-receipt", requireAuth, requireNonPOS, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const {
        voucherType, // "Payment" or "Receipt"
        voucherDate,
        paymentAccountType, // "ledger", "bank", "supplier", "employee", "fixedAsset"
        paymentAccountId,
        entries, // Array of { accountType, accountId, accountName, amount }
        notes,
        optional,
        currency,
        exchangeRate,
        effectiveDate,
      } = req.body;

      // Validate required fields
      if (
        !voucherType ||
        !voucherDate ||
        !paymentAccountId ||
        !entries ||
        !Array.isArray(entries) ||
        entries.length === 0
      ) {
        return res.status(400).json({ message: "Missing required fields" });
      }

      if (voucherType !== "Payment" && voucherType !== "Receipt") {
        return res.status(400).json({ message: "voucherType must be 'Payment' or 'Receipt'" });
      }

      // Determine voucher currency and rate (CFA per USD convention for non-USD).
      // transactionTotal is in the voucher's transaction currency (e.g. CFA).
      // baseTotal is the historical base-currency (USD) equivalent stored on the voucher.
      const vCurrency = (currency as string | undefined) || "USD";
      const vRateRaw = await assertApprovedZmwVoucherRate(
        req.session.currentCompanyId!,
        voucherDate,
        vCurrency,
        exchangeRate
      );
      // For CFA vouchers: baseTotal = transactionTotal / cfaPerUsd (CFA ÷ rate = USD)
      // For USD vouchers: baseTotal = transactionTotal (no conversion)
      if (!paymentVoucherTotals(entries, vCurrency, vRateRaw)) {
        return res.status(400).json({ message: "Invalid amount" });
      }
      const companyId = req.session.currentCompanyId!;
      const lanCapture = isPhase9LanPrimary();
      const result = await db.transaction(async (tx) => {
        const posted = await postPaymentReceiptVoucherTx(tx, {
          companyId,
          voucherType,
          voucherDate,
          paymentAccountType,
          paymentAccountId,
          entries,
          notes: notes || null,
          optional: optional === true,
          currency: vCurrency,
          exchangeRate: vRateRaw ? String(vRateRaw) : null,
          effectiveDate: effectiveDate || null,
          sourceId: `${companyId}:${erpRequestSourceId(req)}`,
          actor: { userId: req.session.userId, username: req.session.username },
          reason: `${voucherType} creation`,
        });
        // Factory LAN server during an outage: record the committed voucher's
        // inputs for exactly-once replay in the cloud, in this transaction.
        if (lanCapture && !posted.replayed) {
          await capturePhase9PaymentTx(tx, {
            companyId,
            localVoucherId: posted.voucher.id,
            actorUserId: String(req.session.userId),
            actorUsername: req.session.username || "unknown",
            requestId: randomUUID(),
            voucher: paymentReceiptEvidence({
              voucherType,
              voucherDate,
              paymentAccountType,
              paymentAccountId,
              entries,
              notes: notes || null,
              optional: optional === true,
              currency: vCurrency,
              exchangeRate: vRateRaw ? String(vRateRaw) : null,
              effectiveDate: effectiveDate || null,
            }),
          });
        }
        return { voucher: posted.voucher, entries: posted.entries };
      });

      try {
        await writePaymentReceiptDaybookEntry(db, req.session.currentCompanyId!, result.voucher);
      } catch (dbErr) {
        logger.error("Factory daybook write failed (non-fatal):", { error: dbErr });
      }

      // WhatsApp rule check — prompt the frontend instead of auto-sending
      let waResult: { prompt: boolean; accountId?: number; voucherDate?: string; month?: string } = { prompt: false };
      try {
        waResult = await checkAccountWhatsAppRule({
          companyId: req.session.currentCompanyId!,
          accountId: paymentAccountId,
          accountType: paymentAccountType,
          voucherType: voucherType as "Payment" | "Receipt",
          voucherDate: voucherDate,
        });
      } catch (waErr: unknown) {
        logger.error("WhatsApp rule check error (non-fatal):", { error: waErr });
      }

      // Fire-and-forget intercompany notification check (Payment/Receipt only)
      triggerIntercompanyNotifications(
        req.session.currentCompanyId!,
        result.voucher.id,
        result.voucher.voucherNumber,
        result.voucher.voucherDate,
        result.voucher.totalAmount || "0",
        result.voucher.description,
        result.entries.map((e) => e.ledgerAccountId),
        result.voucher.voucherType
      ).catch(() => {});

      // Fire-and-forget: auto-rerun FIFO allocation for any Loans accounts touched
      autoReallocateLoansAccounts(
        req.session.currentCompanyId!,
        result.entries.map((e) => e.ledgerAccountId)
      ).catch(() => {});

      res.json({ ...result, whatsapp: waResult });
    } catch (error: unknown) {
      logger.error("Error creating payment/receipt voucher:", { error: error });
      res.status(errorStatus(error)).json({ message: getErrorMessage(error) });
    }
  });

  // Update Payment or Receipt voucher with all entries in one batch
  app.patch("/api/vouchers/:id/payment-receipt", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const voucherId = parseInt(req.params.id);
      if (isNaN(voucherId)) {
        return res.status(400).json({ message: "Invalid voucher ID" });
      }

      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const {
        voucherType, // "Payment" or "Receipt"
        voucherDate,
        paymentAccountType,
        paymentAccountId,
        entries,
        notes,
        optional,
        currency,
        exchangeRate,
        effectiveDate,
      } = req.body;

      // Validate required fields
      if (
        !voucherType ||
        !voucherDate ||
        !paymentAccountId ||
        !entries ||
        !Array.isArray(entries) ||
        entries.length === 0
      ) {
        return res.status(400).json({ message: "Missing required fields" });
      }

      if (voucherType !== "Payment" && voucherType !== "Receipt") {
        return res.status(400).json({ message: "voucherType must be 'Payment' or 'Receipt'" });
      }

      // Determine currency/rate for the PATCH (may preserve existing if not re-sent).
      const [priorVoucher] = await db
        .select()
        .from(vouchers)
        .where(and(eq(vouchers.id, voucherId), eq(vouchers.companyId, req.session.currentCompanyId!)))
        .limit(1);
      if (!priorVoucher) return res.status(404).json({ message: "Voucher not found" });
      const editBody = {
        voucherType,
        voucherDate,
        paymentAccountType,
        paymentAccountId,
        entries,
        notes,
        optional,
        currency,
        exchangeRate,
        effectiveDate,
      };
      const editPlan = paymentReceiptEditPlan(priorVoucher, editBody);
      if (!editPlan) return res.status(400).json({ message: "Invalid amount" });

      // Use database transaction for atomic operation (the edit itself: applyPaymentReceiptEditTx).
      const lanCapture = isPhase9LanPrimary();
      const result = await db.transaction(async (tx) => {
        const before = lanCapture ? await phase9PaymentSnapshotTx(tx, req.session.currentCompanyId!, voucherId) : null;
        const edited = await applyPaymentReceiptEditTx(tx, {
          companyId: req.session.currentCompanyId!,
          voucherId,
          body: editBody,
          plan: editPlan,
          actor: { userId: req.session.userId, username: req.session.username },
        });
        // Factory LAN server during an outage: record the edit, with the voucher as it stood, in this transaction.
        if (lanCapture && before) {
          await capturePhase9PaymentEditTx(tx, {
            ...paymentFollowUpActor(req),
            localVoucherId: voucherId,
            voucherRef: await phase9PaymentVoucherRefTx(tx, voucherId),
            beforeSha256: before,
            voucher: paymentReceiptEvidence({
              ...editBody,
              notes: editBody.notes || null,
              optional: editBody.optional ?? false,
              currency: editPlan.currency,
              exchangeRate: editPlan.rate === null ? null : String(editPlan.rate),
              effectiveDate: editBody.effectiveDate || null,
            }),
          });
        }
        return edited;
      });

      // WhatsApp rule check — prompt the frontend instead of auto-sending
      let waResultPatch: { prompt: boolean; accountId?: number; voucherDate?: string; month?: string } = {
        prompt: false,
      };
      try {
        waResultPatch = await checkAccountWhatsAppRule({
          companyId: req.session.currentCompanyId!,
          accountId: paymentAccountId,
          accountType: paymentAccountType,
          voucherType: voucherType as "Payment" | "Receipt",
          voucherDate: voucherDate,
        });
      } catch (waErr: unknown) {
        logger.error("WhatsApp rule check error (non-fatal):", { error: waErr });
      }

      res.json({ voucher: result.voucher, entries: result.entries, whatsapp: waResultPatch });
    } catch (error: unknown) {
      if (sendVoucherCorrectionRefusal(res, error)) return;
      logger.error("Error updating payment/receipt voucher:", { error: error });
      res.status(errorStatus(error)).json({ message: getErrorMessage(error) });
    }
  });

  // Create Journal voucher with all entries in one batch
}
