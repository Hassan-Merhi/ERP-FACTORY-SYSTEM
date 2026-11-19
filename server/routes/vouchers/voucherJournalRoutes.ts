import {
  assertLockedZmwVoucherEdit,
  assertResolvedZmwVoucherEntriesTx,
} from "../../services/accounting/zambiaVoucherRatePolicy";
import type { Express } from "express";
import { getErrorMessage, errorStatus } from "../../lib/httpHandlers";
import { db } from "../../db";
import { voucherMutationBlockReason } from "../../lib/migratedVoucherGuard";
import { requireAuth, requireNonPOS } from "../../auth";
import { syncEmployeeBalancesFromEntries } from "../_helpers";
import {
  assertNotIntercompanyTransferLeg,
  sendIntercompanyTransferLegRefusal,
} from "../../services/accounting/intercompanyTransferLegGuard";
import { logger } from "../../lib/logger";
import { vouchers, voucherEntries } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import {
  assertVoucherEditableTx,
  recordVoucherEditAuditTx,
  sendVoucherCorrectionRefusal,
} from "../../services/accounting/voucherCorrection";
import { rebalanceVoucherRoundingTx } from "../../services/accounting/engineRounding";
import { checkAccountWhatsAppRule } from "../factoryWhatsappRoutes";
import { normalizeVoucherEntryAmounts } from "../../services/accounting/currencyAmounts";
import { isVoucherAccountType, voucherEntryAccountLink } from "../../services/accounting/voucherEntryAccountLink";
import { journalBaseTotal, journalRate, journalTotals, syncJournalToOrderCharge } from "./syncJournalToOrderCharge";
import { registerVoucherJournalRoutesPart1 } from "./registerVoucherJournalRoutesPart1";

export function registerVoucherJournalRoutes(app: Express) {
  registerVoucherJournalRoutesPart1(app);
  registerVoucherJournalRoutesPart2(app);
}

function registerVoucherJournalRoutesPart2(app: Express) {
  // Update Journal voucher with all entries in one batch
  app.patch("/api/vouchers/:id/journal", requireAuth, requireNonPOS, async (req, res) => {
    const _t = Date.now();
    const _uid = req.session.userId;
    const _cid = req.session.currentCompanyId;
    try {
      logger.info("journal voucher update started", {
        module: "vouchers",
        action: "updateJournal",
        userId: _uid,
        companyId: _cid,
      });
      const voucherId = parseInt(req.params.id);
      if (isNaN(voucherId)) {
        return res.status(400).json({ message: "Invalid voucher ID" });
      }

      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const {
        voucherDate,
        entries,
        notes,
        optional,
        currency,
        exchangeRate,
        effectiveDate,
        mainAccountId: mainAccountIdPatch,
        mainAccountType: mainAccountTypePatch,
      } = req.body;

      // Validate required fields
      if (!voucherDate || !entries || !Array.isArray(entries) || entries.length === 0) {
        return res.status(400).json({ message: "Missing required fields" });
      }

      // Phase 19 C (MC-2): an intercompany transfer leg (a Payment, Receipt or
      // draft journal reaching this legacy editor) is not edited here (409): the
      // transfer is deleted (both legs) and recorded again. This editor used to
      // rescale the other company's voucher after commit, outside a transaction.
      try {
        await assertNotIntercompanyTransferLeg(voucherId);
      } catch (legError: unknown) {
        if (sendIntercompanyTransferLegRefusal(res, legError)) return;
        throw legError;
      }

      // Determine voucher currency and rate for the PATCH handler.
      // currency/exchangeRate may not be sent on a PATCH (preserve existing values).
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
      const vCurrencyPatch = priorIsZmw ? "ZMW" : (currency as string | undefined) || "USD";
      const vRateRawPatch = priorIsZmw
        ? String(priorVoucher.exchangeRate)
        : (exchangeRate as string | number | undefined) || null;
      const cfaPerUsdPatch = journalRate(vCurrencyPatch, vRateRawPatch);

      // Calculate total debits and credits in transaction currency
      const totals = journalTotals(entries);

      // Validate debits equal credits (for non-optional vouchers)
      if (!optional && totals.debits.minus(totals.credits).abs().greaterThanOrEqualTo(0.01)) {
        return res.status(400).json({ message: "Total debits must equal total credits" });
      }

      // vouchers.totalAmount stores the historical base (USD) amount.
      const baseTotalMaxPatch = journalBaseTotal(vCurrencyPatch, totals, cfaPerUsdPatch);

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

        // Update voucher
        const [updatedVoucher] = await tx
          .update(vouchers)
          .set({
            voucherDate,
            description: notes || null,
            // Store historical base (USD) total.
            totalAmount: baseTotalMaxPatch.toFixed(6),
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
          const narration = entry.narration || null;

          // Determine account field
          const accountField = isVoucherAccountType(entry.accountType)
            ? voucherEntryAccountLink(entry.accountType, entry.accountId)
            : {};

          const norm = normalizeVoucherEntryAmounts({
            transactionCurrency: vCurrencyPatch,
            baseCurrency: "USD",
            transactionDebitAmount: entry.type === "DR" ? amount : "0",
            transactionCreditAmount: entry.type === "CR" ? amount : "0",
            historicalRate: vRateRawPatch,
          });

          voucherEntriesToCreate.push({
            voucherId: updatedVoucher.id,
            ...accountField,
            debitAmount: norm.debitAmount,
            creditAmount: norm.creditAmount,
            transactionCurrency: norm.transactionCurrency,
            transactionDebitAmount: norm.transactionDebitAmount,
            transactionCreditAmount: norm.transactionCreditAmount,
            baseDebitAmount: norm.baseDebitAmount,
            baseCreditAmount: norm.baseCreditAmount,
            historicalExchangeRate: norm.historicalExchangeRate,
            rateConvention: norm.rateConvention,
            narration,
          });
        }

        // Batch insert all new voucher entries
        const insertedEntries = await tx.insert(voucherEntries).values(voucherEntriesToCreate).returning();
        // Phase 22 A (D3): the rounding remainder of an engine voucher's new lines.
        await rebalanceVoucherRoundingTx(tx, { companyId: existingVoucher.companyId, voucherId });

        // Wave 12: employee balances move in this transaction (reverse the old
        // lines, apply the new), and the edit is audited with the full
        // before/after snapshot before it commits.
        if (!existingVoucher.optional) {
          await syncEmployeeBalancesFromEntries(oldEntries, req.session.currentCompanyId!, true, tx);
        }
        if (!updatedVoucher.optional) {
          await syncEmployeeBalancesFromEntries(insertedEntries, req.session.currentCompanyId!, false, tx);
        }
        // Sync order charges: a customer line + a CR ledger line matching a charge
        // on one of their orders updates that charge, in this transaction.
        await syncJournalToOrderCharge(tx, req.session.currentCompanyId!, insertedEntries, voucherId);
        const audited = await recordVoucherEditAuditTx(tx, {
          voucherId,
          before: editContext.before,
          actor: {
            userId: req.session.userId,
            username: req.session.username,
            companyId: req.session.currentCompanyId,
          },
          reason: "Journal voucher update",
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
      let waJournalPatch: { prompt: boolean; accountId?: number; voucherDate?: string; month?: string } = {
        prompt: false,
      };
      try {
        let waAccountId = mainAccountIdPatch ? Number(mainAccountIdPatch) : null;
        let waAccountType = mainAccountTypePatch ? String(mainAccountTypePatch) : "ledger";
        if (!waAccountId) {
          const firstLedgerDr = entries.find(
            (e) => e.accountType === "ledger" && e.type === "DR" && Number(e.accountId) > 0
          );
          if (firstLedgerDr) {
            waAccountId = Number(firstLedgerDr.accountId);
            waAccountType = "ledger";
          }
        }
        if (waAccountId) {
          waJournalPatch = await checkAccountWhatsAppRule({
            companyId: req.session.currentCompanyId!,
            accountId: waAccountId,
            accountType: waAccountType,
            voucherType: "Journal",
            voucherDate: voucherDate,
          });
        }
      } catch (waErr: unknown) {
        logger.error("WhatsApp rule check error (non-fatal):", { error: waErr });
      }

      logger.info("journal voucher update succeeded", {
        module: "vouchers",
        action: "updateJournal",
        userId: _uid,
        companyId: _cid,
        voucherId: result.voucher.id,
        durationMs: Date.now() - _t,
      });
      res.json({ voucher: result.voucher, entries: result.entries, whatsapp: waJournalPatch });
    } catch (error: unknown) {
      logger.error("journal voucher update failed", {
        module: "vouchers",
        action: "updateJournal",
        userId: _uid,
        companyId: _cid,
        durationMs: Date.now() - _t,
        error,
      });
      logger.error("Error updating journal voucher:", { error: error });
      if (sendVoucherCorrectionRefusal(res, error)) return;
      res.status(errorStatus(error)).json({ message: getErrorMessage(error) });
    }
  });
}
