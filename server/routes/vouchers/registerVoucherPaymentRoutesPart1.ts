// Extracted from ./voucherPaymentRoutes.ts
import { assertApprovedZmwVoucherRate } from "../../services/accounting/zambiaVoucherRatePolicy";
import type { Express } from "express";
import { errorBody, errorStatus } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { db } from "../../db";
import { requireAuth, requireNonPOS } from "../../auth";
import { erpRequestSourceId } from "../../services/accounting/erpVoucherPosting";
import { triggerIntercompanyNotifications } from "../intercompanyNotificationRoutes";
import { autoReallocateLoansAccounts } from "../../lib/transporterAllocation";
import { checkAccountWhatsAppRule } from "../factoryWhatsappRoutes";
import { randomUUID } from "node:crypto";
import {
  paymentVoucherTotals,
  postPaymentReceiptVoucherTx,
  writePaymentReceiptDaybookEntry,
} from "../../services/accounting/paymentReceiptVoucherPosting";
import { isPhase9LanPrimary } from "../../edge/phase9PosOutbox";
import { capturePhase9PaymentTx, paymentReceiptEvidence } from "../../edge/phase9PaymentOutbox";

export function registerVoucherPaymentRoutesPart1(app: Express) {
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
      res.status(errorStatus(error)).json(errorBody(error));
    }
  });
}
