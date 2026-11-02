import {
  assertApprovedZmwVoucherRate,
  assertLockedZmwVoucherEdit,
  assertResolvedZmwVoucherEntriesTx,
} from "../../services/accounting/zambiaVoucherRatePolicy";
import type { Express } from "express";
import { getErrorMessage, errorStatus } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { db } from "../../db";
import { voucherMutationBlockReason } from "../../lib/migratedVoucherGuard";
import { requireAuth, requireNonPOS } from "../../auth";
import { syncEmployeeBalancesFromEntries } from "../_helpers";
import {
  erpRequestSourceId,
} from "../../services/accounting/erpVoucherPosting";
import {
  assertVoucherEditableTx,
  recordVoucherEditAuditTx,
  sendVoucherCorrectionRefusal,
} from "../../services/accounting/voucherCorrection";
import { rebalanceVoucherRoundingTx } from "../../services/accounting/engineRounding";
import { triggerIntercompanyNotifications } from "../intercompanyNotificationRoutes";
import { autoReallocateLoansAccounts } from "../../lib/transporterAllocation";
import { vouchers, voucherEntries } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import { checkAccountWhatsAppRule } from "../factoryWhatsappRoutes";

import { normalizeVoucherEntryAmounts } from "../../services/accounting/currencyAmounts";
import { isVoucherAccountType, voucherEntryAccountLink } from "../../services/accounting/voucherEntryAccountLink";
import { syncContainerChargeVoucherEditTx } from "../../services/containers/offload-lifecycle/charge-voucher-sync";
import { randomUUID } from "node:crypto";
import {
  paymentVoucherTotals,
  postPaymentReceiptVoucherTx,
  writePaymentReceiptDaybookEntry,
} from "../../services/accounting/paymentReceiptVoucherPosting";
import { isPhase9LanPrimary } from "../../edge/phase9PosOutbox";
import { capturePhase9PaymentTx, paymentReceiptEvidence } from "../../edge/phase9PaymentOutbox";

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
      assertLockedZmwVoucherEdit(priorVoucher, { voucherDate, currency, exchangeRate });
      // Only a posted Kwacha voucher locks its currency and rate on edit; the
      // existing USD/CFA PATCH contract (caller-supplied currency/rate) is kept.
      const priorIsZmw = String(priorVoucher.currency || "USD").toUpperCase() === "ZMW";
      const pCurrency = priorIsZmw ? "ZMW" : (currency as string | undefined) || "USD";
      const pRateRaw = priorIsZmw
        ? String(priorVoucher.exchangeRate)
        : (exchangeRate as string | number | undefined) || null;
      // Base total (historical USD) — stored in vouchers.totalAmount
      const pTotals = paymentVoucherTotals(entries, pCurrency, pRateRaw);
      if (!pTotals) return res.status(400).json({ message: "Invalid amount" });
      const pBaseTotal = pTotals.baseTotal;

      // Use database transaction for atomic operation
      const result = await db.transaction(async (tx) => {
        // Verify voucher exists and belongs to current company
        const [existingVoucher] = await tx.select().from(vouchers).where(eq(vouchers.id, voucherId));

        if (!existingVoucher) {
          throw new Error("Voucher not found");
        }

        if (existingVoucher.companyId !== req.session.currentCompanyId) {
          throw new Error("Access denied: Voucher belongs to a different company");
        }

        const blockedVoucherReason = voucherMutationBlockReason(existingVoucher);
        if (blockedVoucherReason) {
          throw new Error(blockedVoucherReason);
        }
        // Phase 22 (B), PE9/G4: open-period edit, audited below; closed period → 409.
        const editContext = await assertVoucherEditableTx(tx, voucherId, {
          companyId: existingVoucher.companyId,
          newVoucherDate: voucherDate,
          newEffectiveDate: effectiveDate || null,
        });

        // Recheck the immutable FX header under the write transaction; a
        // second editor must not be able to alter it between read and save.
        assertLockedZmwVoucherEdit(existingVoucher, { voucherDate, currency, exchangeRate });
        // Get existing entries before deleting (for balance sync)
        const oldEntries = await tx.select().from(voucherEntries).where(eq(voucherEntries.voucherId, voucherId));
        if (existingVoucher.currency === "ZMW") {
          await assertResolvedZmwVoucherEntriesTx(tx, existingVoucher.companyId, oldEntries);
        }

        // Update voucher — store historical base (USD) total
        const [updatedVoucher] = await tx
          .update(vouchers)
          .set({
            voucherType,
            voucherDate,
            description: notes || null,
            totalAmount: pBaseTotal.toFixed(6),
            optional: optional ?? false,
            effectiveDate: effectiveDate || null,
          })
          .where(eq(vouchers.id, voucherId))
          .returning();

        // Delete existing voucher entries
        await tx.delete(voucherEntries).where(eq(voucherEntries.voucherId, voucherId));

        const voucherEntriesToCreate = [];

        // Create new entries with dual-currency normalization.
        for (const entry of entries) {
          const amount: string = entry.amount;
          const narration = notes || null;

          // Determine account field for entry account
          const entryAccountField = isVoucherAccountType(entry.accountType)
            ? voucherEntryAccountLink(entry.accountType, entry.accountId)
            : {};

          // Determine account field for payment account
          const paymentAccountField = isVoucherAccountType(paymentAccountType)
            ? voucherEntryAccountLink(paymentAccountType, paymentAccountId)
            : {};

          const isLiabilityPaymentAccount =
            paymentAccountType === "supplier" ||
            paymentAccountType === "factorySupplier" ||
            paymentAccountType === "employee";

          // Normalize once; debit/credit fields determined by voucher type below
          const normDR = normalizeVoucherEntryAmounts({
            transactionCurrency: pCurrency,
            baseCurrency: "USD",
            transactionDebitAmount: amount,
            transactionCreditAmount: "0",
            historicalRate: pRateRaw,
          });
          const normCR = normalizeVoucherEntryAmounts({
            transactionCurrency: pCurrency,
            baseCurrency: "USD",
            transactionDebitAmount: "0",
            transactionCreditAmount: amount,
            historicalRate: pRateRaw,
          });

          const mkDR = (acctField: Record<string, unknown>) => ({
            voucherId: updatedVoucher.id,
            ...acctField,
            debitAmount: normDR.debitAmount,
            creditAmount: normDR.creditAmount,
            transactionCurrency: normDR.transactionCurrency,
            transactionDebitAmount: normDR.transactionDebitAmount,
            transactionCreditAmount: normDR.transactionCreditAmount,
            baseDebitAmount: normDR.baseDebitAmount,
            baseCreditAmount: normDR.baseCreditAmount,
            historicalExchangeRate: normDR.historicalExchangeRate,
            rateConvention: normDR.rateConvention,
            narration,
          });
          const mkCR = (acctField: Record<string, unknown>) => ({
            voucherId: updatedVoucher.id,
            ...acctField,
            debitAmount: normCR.debitAmount,
            creditAmount: normCR.creditAmount,
            transactionCurrency: normCR.transactionCurrency,
            transactionDebitAmount: normCR.transactionDebitAmount,
            transactionCreditAmount: normCR.transactionCreditAmount,
            baseDebitAmount: normCR.baseDebitAmount,
            baseCreditAmount: normCR.baseCreditAmount,
            historicalExchangeRate: normCR.historicalExchangeRate,
            rateConvention: normCR.rateConvention,
            narration,
          });

          if (voucherType === "Payment") {
            if (isLiabilityPaymentAccount) {
              voucherEntriesToCreate.push(mkDR(paymentAccountField));
              voucherEntriesToCreate.push(mkCR(entryAccountField));
            } else {
              voucherEntriesToCreate.push(mkDR(entryAccountField));
              voucherEntriesToCreate.push(mkCR(paymentAccountField));
            }
          } else {
            if (isLiabilityPaymentAccount) {
              voucherEntriesToCreate.push(mkDR(entryAccountField));
              voucherEntriesToCreate.push(mkCR(paymentAccountField));
            } else {
              voucherEntriesToCreate.push(mkDR(paymentAccountField));
              voucherEntriesToCreate.push(mkCR(entryAccountField));
            }
          }
        }

        // Batch insert all new voucher entries
        const insertedEntries = await tx.insert(voucherEntries).values(voucherEntriesToCreate).returning();
        // Phase 22 A (D3): the rounding remainder of an engine voucher's new lines.
        await rebalanceVoucherRoundingTx(tx, { companyId: existingVoucher.companyId, voucherId });

        // An edited duty/transport/office charge voucher re-prices the offloaded bales.
        await syncContainerChargeVoucherEditTx(tx, {
          companyId: existingVoucher.companyId,
          voucherNumber: existingVoucher.voucherNumber,
          oldTotal: existingVoucher.optional ? 0 : existingVoucher.totalAmount,
          newTotal: updatedVoucher.optional ? 0 : updatedVoucher.totalAmount,
        });

        // Wave 12: employee balances move in this transaction, and the edit is
        // audited with the full before/after snapshot before it commits.
        if (!existingVoucher.optional) {
          await syncEmployeeBalancesFromEntries(oldEntries, req.session.currentCompanyId!, true, tx);
        }
        if (!updatedVoucher.optional) {
          await syncEmployeeBalancesFromEntries(insertedEntries, req.session.currentCompanyId!, false, tx);
        }
        const audited = await recordVoucherEditAuditTx(tx, {
          voucherId,
          before: editContext.before,
          actor: {
            userId: req.session.userId,
            username: req.session.username,
            companyId: req.session.currentCompanyId,
          },
          reason: `${voucherType} voucher update`,
        });
        const createdEntries = audited.entries;

        return {
          voucher: updatedVoucher,
          entries: createdEntries,
          oldEntries,
          existingVoucher,
          wasOptional: existingVoucher.optional,
        };
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
