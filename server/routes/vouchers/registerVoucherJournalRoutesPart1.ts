// Extracted from ./voucherJournalRoutes.ts to keep that module under the source-size cap.
import type { Express } from "express";
import { errorBody, errorStatus } from "../../lib/httpHandlers";
import { db } from "../../db";
import { requireAuth, requireNonPOS } from "../../auth";
import { erpRequestSourceId, sessionPostingActor } from "../../services/accounting/erpVoucherPosting";
import {
  checkJournalVoucherInput,
  JournalVoucherInputError,
  postJournalVoucherTx,
} from "../../services/accounting/journalVoucherPosting";
import { logger } from "../../lib/logger";
import { eq } from "drizzle-orm";
import { checkAccountWhatsAppRule } from "../factoryWhatsappRoutes";
import { factoryDaybookEntries as fde, factorySettings as fSettings } from "@shared/schema";
import { erpRateToDaybookFxRateToUsd } from "../../services/accounting/currencyAmounts";
import { MoneyDecimal, toMoney } from "../../lib/money";

export function registerVoucherJournalRoutesPart1(app: Express) {
  app.post("/api/vouchers/journal", requireAuth, requireNonPOS, async (req, res) => {
    const _t = Date.now();
    const _uid = req.session.userId;
    const _cid = req.session.currentCompanyId;
    try {
      logger.info("journal voucher create started", {
        module: "vouchers",
        action: "createJournal",
        userId: _uid,
        companyId: _cid,
      });
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const {
        voucherDate,
        entries, // Array of { type: "DR" | "CR", accountType, accountId, accountName, amount }
        notes,
        optional,
        currency,
        exchangeRate,
        effectiveDate,
        mainAccountId, // optional: ledger account ID to use for WhatsApp auto-statement
        mainAccountType, // optional: account type for the main account (default: "ledger")
      } = req.body;

      // The journal itself (validation, rate, entries, posting, order charges,
      // employee balances, audit) is the shared service, on one transaction.
      // Required fields and balance are checked before any transaction opens.
      try {
        checkJournalVoucherInput({ voucherDate, entries, optional: optional === true });
      } catch (error) {
        if (error instanceof JournalVoucherInputError) return res.status(400).json({ message: error.message });
        throw error;
      }
      let result: { voucher: Awaited<ReturnType<typeof postJournalVoucherTx>>["voucher"]; entries: unknown[] };
      try {
        const posted = await db.transaction((tx) =>
          postJournalVoucherTx(tx, {
            companyId: req.session.currentCompanyId!,
            voucherDate,
            entries,
            notes: notes || null,
            optional: optional === true,
            currency: (currency as string | undefined) || "USD",
            exchangeRate,
            effectiveDate: effectiveDate || null,
            sourceType: "manual-journal-legacy",
            sourceId: `${req.session.currentCompanyId}:${erpRequestSourceId(req)}`,
            postingActor: sessionPostingActor(req, "Journal creation"),
            auditActor: { userId: req.session.userId, username: req.session.username },
          })
        );
        result = { voucher: posted.voucher, entries: posted.entries };
      } catch (error) {
        if (error instanceof JournalVoucherInputError) return res.status(400).json({ message: error.message });
        throw error;
      }

      // Write to factory daybook if this company has factory settings
      try {
        const cid = req.session.currentCompanyId!;
        const [fSetting] = await db.select().from(fSettings).where(eq(fSettings.companyId, cid));
        if (fSetting) {
          const daybookCurrencyJ = result.voucher.currency || "USD";
          // vouchers.totalAmount now stores the historical base (USD) amount.
          const daybookBaseTotalJ = toMoney(result.voucher.totalAmount);
          const daybookRateJ = result.voucher.exchangeRate ? toMoney(result.voucher.exchangeRate) : new MoneyDecimal(1);
          // Reconstruct the original CFA total: base × rate (TRANSACTION_PER_BASE).
          const daybookAmtCurrencyJ =
            daybookCurrencyJ !== "USD" && daybookRateJ.greaterThan(0)
              ? daybookBaseTotalJ.times(daybookRateJ)
              : daybookBaseTotalJ;
          // factory_daybook_entries.fx_rate_to_usd expects USD-per-foreign-unit.
          // The ERP voucher stores CFA-per-USD, so we store the inverse.
          const daybookFxRateToUsdJ = erpRateToDaybookFxRateToUsd(daybookCurrencyJ, "USD", result.voucher.exchangeRate);
          await db.insert(fde).values({
            companyId: cid,
            txDate: result.voucher.voucherDate,
            txType: "JOURNAL",
            referenceId: result.voucher.id,
            referenceTable: "vouchers",
            description: result.voucher.description || `Journal voucher #${result.voucher.voucherNumber}`,
            currencyCode: daybookCurrencyJ,
            amountCurrency: daybookAmtCurrencyJ.toFixed(),
            fxRateToUsd: daybookFxRateToUsdJ,
            amountUsd: daybookBaseTotalJ.toFixed(),
            createdBy: null,
          });
        }
      } catch (dbErr) {
        logger.error("Factory daybook write failed (non-fatal):", { error: dbErr });
      }

      // WhatsApp rule check — prompt the frontend instead of auto-sending
      // Resolve main account: prefer explicitly passed mainAccountId,
      // fallback to first ledger-type DR entry in entries array.
      let waJournalResult: { prompt: boolean; accountId?: number; voucherDate?: string; month?: string } = {
        prompt: false,
      };
      try {
        let waAccountId = mainAccountId ? Number(mainAccountId) : null;
        let waAccountType = mainAccountType ? String(mainAccountType) : "ledger";
        if (!waAccountId) {
          const firstLedgerDr = (entries as Array<{ accountType?: unknown; type?: unknown; accountId?: unknown }>).find(
            (e) => e.accountType === "ledger" && e.type === "DR" && Number(e.accountId) > 0
          );
          if (firstLedgerDr) {
            waAccountId = Number(firstLedgerDr.accountId);
            waAccountType = "ledger";
          }
        }
        if (waAccountId) {
          waJournalResult = await checkAccountWhatsAppRule({
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

      logger.info("journal voucher create succeeded", {
        module: "vouchers",
        action: "createJournal",
        userId: _uid,
        companyId: _cid,
        voucherId: result.voucher.id,
        durationMs: Date.now() - _t,
      });
      res.json({ ...result, whatsapp: waJournalResult });
    } catch (error: unknown) {
      logger.error("journal voucher create failed", {
        module: "vouchers",
        action: "createJournal",
        userId: _uid,
        companyId: _cid,
        durationMs: Date.now() - _t,
        error,
      });
      logger.error("Error creating journal voucher:", { error: error });
      res.status(errorStatus(error)).json(errorBody(error));
    }
  });
}
