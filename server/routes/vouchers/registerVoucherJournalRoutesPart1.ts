// Extracted from ./voucherJournalRoutes.ts to keep that module under the source-size cap.
import { assertApprovedZmwVoucherRate } from "../../services/accounting/zambiaVoucherRatePolicy";
import type { Express } from "express";
import { errorStatus, getErrorMessage } from "../../lib/httpHandlers";
import { db } from "../../db";
import { requireAuth, requireNonPOS } from "../../auth";
import { z } from "zod";
import { emptyQuery, validateRequest, type RequestSchemas } from "../../lib/validateRequest";
import { journalBodyFields } from "./voucherWriteInputSchemas";
import { syncEmployeeBalancesFromEntries } from "../_helpers";
import { writeVoucherAuditTx } from "../helpers/voucherAuditTrail";
import {
  erpRequestSourceId,
  postManualVoucherTx,
  sessionPostingActor,
} from "../../services/accounting/erpVoucherPosting";
import { logger } from "../../lib/logger";
import { eq } from "drizzle-orm";
import { checkAccountWhatsAppRule } from "../factoryWhatsappRoutes";
import { factoryDaybookEntries as fde, factorySettings as fSettings } from "@shared/schema";
import { erpRateToDaybookFxRateToUsd, normalizeVoucherEntryAmounts } from "../../services/accounting/currencyAmounts";
import { isVoucherAccountType, voucherEntryAccountLink } from "../../services/accounting/voucherEntryAccountLink";
import { MoneyDecimal, toMoney } from "../../lib/money";
import { journalBaseTotal, journalRate, journalTotals, syncJournalToOrderCharge } from "./syncJournalToOrderCharge";

/** The journal form body. Active journals are posted by centralJournalCreateRoute.ts first. */
const createJournalInput = {
  query: emptyQuery,
  body: z.strictObject({
    ...journalBodyFields,
    // Read by the central create layer (centralJournalCreateRoute.ts) on this path.
    goldenCoastOwnerWithdrawalTemplate: z.boolean().optional(),
  }),
} satisfies RequestSchemas;

export function registerVoucherJournalRoutesPart1(app: Express) {
  app.post(
    "/api/vouchers/journal",
    requireAuth,
    requireNonPOS,
    validateRequest(createJournalInput),
    async (req, res) => {
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

        // Validate required fields
        if (!voucherDate || !entries || !Array.isArray(entries) || entries.length === 0) {
          return res.status(400).json({ message: "Missing required fields" });
        }

        // Determine voucher currency and rate (CFA per USD convention for non-USD).
        // totalDebits/totalCredits below are in the voucher's transaction currency (e.g. CFA).
        const vCurrency = (currency as string | undefined) || "USD";
        const vRateRaw = await assertApprovedZmwVoucherRate(
          req.session.currentCompanyId!,
          voucherDate,
          vCurrency,
          exchangeRate
        );
        const cfaPerUsd = journalRate(vCurrency, vRateRaw);

        // Calculate total debits and credits in transaction currency
        const totals = journalTotals(entries);

        // Validate debits equal credits (for non-optional vouchers)
        if (!optional && totals.debits.minus(totals.credits).abs().greaterThanOrEqualTo(0.01)) {
          return res.status(400).json({ message: "Total debits must equal total credits" });
        }

        // vouchers.totalAmount stores the historical base (USD) amount.
        // For CFA: baseTotalMax = max(totalDebits, totalCredits) / cfaPerUsd
        const baseTotalMax = journalBaseTotal(vCurrency, totals, cfaPerUsd);

        // Use database transaction for atomic operation
        const result = await db.transaction(async (tx) => {
          const voucherEntriesToCreate = [];

          // Create entries.
          // Each entry.amount is the original transaction-currency (CFA) value.
          // normalizeVoucherEntryAmounts() produces the historical base (USD) amounts
          // for debitAmount / creditAmount (backward compat) and fills all new fields.
          for (const entry of entries) {
            const amount: string = entry.amount;
            const narration = entry.narration || null;

            // Determine account field
            const accountField = isVoucherAccountType(entry.accountType)
              ? voucherEntryAccountLink(entry.accountType, entry.accountId)
              : {};

            const norm = normalizeVoucherEntryAmounts({
              transactionCurrency: vCurrency,
              baseCurrency: "USD",
              transactionDebitAmount: entry.type === "DR" ? amount : "0",
              transactionCreditAmount: entry.type === "CR" ? amount : "0",
              historicalRate: vRateRaw,
            });

            voucherEntriesToCreate.push({
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

          // Phase 22 (B): an active journal posts through the central engine (number
          // allocated there); an optional one keeps a direct insert with an
          // allocated number (it is off the ledger and may be unbalanced).
          const posted = await postManualVoucherTx(tx, {
            companyId: req.session.currentCompanyId!,
            voucherType: "Journal",
            voucherDate,
            description: notes || null,
            currency: vCurrency,
            exchangeRate: vRateRaw ? String(vRateRaw) : null,
            effectiveDate: effectiveDate || null,
            optional: optional === true,
            optionalTotalAmount: baseTotalMax.toFixed(6),
            entries: voucherEntriesToCreate,
            source: { type: "manual-journal-legacy", id: `${req.session.currentCompanyId}:${erpRequestSourceId(req)}` },
            actor: sessionPostingActor(req, "Journal creation"),
          });
          if (posted.replayed) return { voucher: posted.voucher, entries: posted.entries };
          const createdVoucher = posted.voucher;
          const createdEntries = posted.entries;
          // Sync order charges automatically, in this transaction.
          await syncJournalToOrderCharge(tx, req.session.currentCompanyId!, createdEntries, createdVoucher.id);

          // Wave 12: employee balances and the audit row are written in this transaction.
          if (!createdVoucher.optional) {
            await syncEmployeeBalancesFromEntries(createdEntries, req.session.currentCompanyId!, false, tx);
          }
          await writeVoucherAuditTx(tx, {
            actor: {
              userId: req.session.userId,
              username: req.session.username,
              companyId: req.session.currentCompanyId,
            },
            action: "create",
            voucherId: createdVoucher.id,
            before: null,
            after: { voucher: createdVoucher, entries: createdEntries },
          });

          return { voucher: createdVoucher, entries: createdEntries };
        });

        // Write to factory daybook if this company has factory settings
        try {
          const cid = req.session.currentCompanyId!;
          const [fSetting] = await db.select().from(fSettings).where(eq(fSettings.companyId, cid));
          if (fSetting) {
            const daybookCurrencyJ = result.voucher.currency || "USD";
            // vouchers.totalAmount now stores the historical base (USD) amount.
            const daybookBaseTotalJ = toMoney(result.voucher.totalAmount);
            const daybookRateJ = result.voucher.exchangeRate
              ? toMoney(result.voucher.exchangeRate)
              : new MoneyDecimal(1);
            // Reconstruct the original CFA total: base × rate (TRANSACTION_PER_BASE).
            const daybookAmtCurrencyJ =
              daybookCurrencyJ !== "USD" && daybookRateJ.greaterThan(0)
                ? daybookBaseTotalJ.times(daybookRateJ)
                : daybookBaseTotalJ;
            // factory_daybook_entries.fx_rate_to_usd expects USD-per-foreign-unit.
            // The ERP voucher stores CFA-per-USD, so we store the inverse.
            const daybookFxRateToUsdJ = erpRateToDaybookFxRateToUsd(
              daybookCurrencyJ,
              "USD",
              result.voucher.exchangeRate
            );
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
            const firstLedgerDr = entries.find(
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
        res.status(errorStatus(error)).json({ message: getErrorMessage(error) });
      }
    }
  );
}
