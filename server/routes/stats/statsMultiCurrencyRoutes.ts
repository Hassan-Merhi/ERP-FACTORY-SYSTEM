import type { Express } from "express";
import Decimal from "decimal.js";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { requireAuth, requireNonPOS } from "../../auth";
import { getMonetaryFxValuation } from "../../services/accounting/monetaryFxValuationService";
import { getMonetaryFxHistoricalRatePreview } from "../../services/accounting/monetaryFxHistoricalRatePreview";
import { MonetaryFxError } from "../../services/accounting/monetaryFxRates";
import {
  applyVerifiedMonetaryFxOverlay,
  type MonetaryNetPositionPayload,
} from "../../services/accounting/monetaryFxReportOverlay";
import {
  getCashBankAccountSummary,
  getCashBankRevaluation,
} from "../../services/accounting/cashBankRevaluationService";

/**
 * Registered from statsRoutes only to keep the top-level route registry small.
 * The account URLs deliberately live under /api/accounts so accounting users do
 * not need the separate Analytics-module permission to view cash/bank balances.
 */
export function registerStatsMultiCurrencyRoutes(app: Express) {
  // Phase 5: audit-friendly effective rates for a selected company-local date.
  // Historical ACCOUNT balances remain booked at their original USD basis.
  // A rate from today must never be applied to today's balances and passed
  // off as a historical balance-sheet snapshot.
  app.get("/api/accounts/multi-currency/rates-as-of", requireAuth, requireNonPOS, async (req, res) => {
    const companyId = req.session.currentCompanyId;
    if (!companyId) return res.status(400).json({ code: "FX_COMPANY_INVALID", message: "No company selected" });
    const asOf = req.query.asOf;
    if (typeof asOf !== "string") {
      return res.status(400).json({ code: "FX_DATE_INVALID", message: "Provide asOf in YYYY-MM-DD format" });
    }
    res.setHeader("Cache-Control", "private, no-store");
    try {
      return res.json(await getMonetaryFxHistoricalRatePreview(companyId, asOf));
    } catch (error: unknown) {
      if (error instanceof MonetaryFxError) {
        return res.status(error.status).json({ code: error.code, message: error.message });
      }
      logger.error("Historical company FX rate preview failed", { companyId, error });
      return res.status(500).json({ code: "FX_AS_OF_PREVIEW_FAILED", message: getErrorMessage(error) });
    }
  });

  // Phase 2: read-only four-category valuation. This does NOT adjust report
  // totals yet; later phases will integrate uniquely attributed rows.
  app.get("/api/accounts/multi-currency/monetary-valuation", requireAuth, requireNonPOS, async (req, res) => {
    const companyId = req.session.currentCompanyId;
    if (!companyId) return res.status(400).json({ message: "No company selected" });
    res.setHeader("Cache-Control", "private, no-store");
    try {
      return res.json(await getMonetaryFxValuation(companyId));
    } catch (error: unknown) {
      logger.error("Unable to calculate read-only monetary FX valuation", { companyId, error });
      return res.status(500).json({
        code: "MONETARY_FX_VALUATION_FAILED",
        message: getErrorMessage(error),
      });
    }
  });


  // Register before /api/stats/net-profit. Only the live, unfiltered ERP
  // snapshot is translated; historical/as-of views retain locked posted USD.
  // Group Net Position captures this wrapper too, keeping one projection.
  app.use(async (req, res, next) => {
    if (req.method !== "GET" || req.path !== "/api/stats/net-profit" || req.query.toDate) return next();
    const companyId = req.session.currentCompanyId;
    if (!companyId) return next();

    try {
      // Pure reporting valuation. No FX-REVAL vouchers are ever posted here.
      const valuation = await getMonetaryFxValuation(companyId);
      const originalJson = res.json.bind(res);
      res.json = ((payload: MonetaryNetPositionPayload) => {
        if (!payload?.forUs || !payload.onUs) return originalJson(payload);
        // The source report is cached and shared. Clone before overlay so that
        // repeated reads never apply the same translation a second time.
        const copy = JSON.parse(JSON.stringify(payload)) as MonetaryNetPositionPayload;
        const translated = applyVerifiedMonetaryFxOverlay(copy, valuation);
        const adjusted = translated.payload;
        if (adjusted.equity && adjusted.equity.includedInNetPosition == null) {
          adjusted.equity.includedInNetPosition = false;
        }
        const isCashBankKey = (key: string) => key.startsWith("ledger:") || key.startsWith("bank:");
        const cashBankApplied = translated.appliedKeys.some(isCashBankKey);
        if (adjusted.currency) {
          if (cashBankApplied) adjusted.currency.currentCashBankTranslationApplied = true;
          else adjusted.currency.currentCashBankTranslationApplied = false;
          adjusted.currency.currentMonetaryTranslationApplied = translated.appliedKeys.length > 0;
        }
        // Compatibility figures of the former cash/bank-only translation: the
        // company's current CFA / ZMW quotes (foreign per USD) and the cash/bank
        // share of the translation difference, both read from the same
        // valuation so no second rate lookup can disagree with it.
        const quoteForeignPerUsd = (currency: string): string | null => {
          const quote = valuation.rates.find((rate) => rate.currency === currency);
          if (!quote) return null;
          const rate = new Decimal(quote.rate);
          if (!rate.isFinite() || rate.lte(0)) return null;
          return (quote.direction === "FOREIGN_PER_USD" ? rate : new Decimal(1).div(rate))
            .toDecimalPlaces(10).toFixed(10);
        };
        const appliedKeySet = new Set(translated.appliedKeys);
        const cashBankDifference = valuation.accounts
          .filter((account) => appliedKeySet.has(account.accountKey) && isCashBankKey(account.accountKey))
          .reduce((sum, account) => sum.plus(account.translationDifferenceUsd ?? 0), new Decimal(0));
        const unresolvedAccounts = valuation.accounts
          .filter((account) => account.provisional && account.eligibility !== "needs_review")
          .map((account) => ({
            accountKind: account.accountKind,
            accountKey: account.accountKey,
            id: account.id,
            name: account.name,
            category: account.category,
            openingBalanceCurrencyUnresolved: account.unresolvedOpening,
            openingBookMismatch: account.openingBookMismatch,
            unresolvedLegacyEntryCount: account.unresolvedEntryCount,
            currentRateMissing: account.unresolvedCurrencies.some(
              (currency) => valuation.rateErrorsByCurrency[currency] !== undefined
            ),
            unresolvedTranslationCurrencies: account.unresolvedCurrencies,
          }));
        const previous = adjusted.currencyRevaluation ?? {};
        adjusted.currencyRevaluation = {
          ...previous,
          valuationMode: "CURRENT",
          currentCfaPerUsd: quoteForeignPerUsd("CFA"),
          currentZmwPerUsd: quoteForeignPerUsd("ZMW"),
          currentCashBankTranslationDifference: cashBankDifference.toDecimalPlaces(2).toNumber(),
          unresolvedAccounts,
          currentMonetaryTranslationApplied: translated.appliedKeys.length > 0,
          currentMonetaryTranslationDifferenceUsd: translated.currentMonetaryTranslationDifferenceUsd,
          appliedAccountKeys: translated.appliedKeys,
          skippedAccountKeys: translated.skipped,
          unresolvedAccountCount: valuation.unresolvedAccountCount,
          needsReviewCount: valuation.needsReviewCount,
          rateErrorsByCurrency: valuation.rateErrorsByCurrency,
          appliedToCurrentSnapshotOnly: true,
          reportTotalsProvisional: Boolean(previous.reportTotalsProvisional) ||
            valuation.unresolvedAccountCount > 0 || valuation.needsReviewCount > 0,
          // Compatibility for existing clients that display the monetary
          // translation status under its former cash/bank-only indicator.
          currentTranslatedLedgerAccountIds: translated.appliedKeys
            .filter((key) => key.startsWith("ledger:")).map((key) => Number(key.slice(7))),
          currentTranslatedBankAccountIds: translated.appliedKeys
            .filter((key) => key.startsWith("bank:")).map((key) => Number(key.slice(5))),
        };
        return originalJson(adjusted);
      }) as typeof res.json;
    } catch (error) {
      // A missing/out-of-scope rate cannot modify or corrupt the historical
      // book view. Keep it visible and report the skipped valuation.
      logger.error("Unable to prepare current monetary Net Position translation", {
        companyId, error,
      });
    }
    return next();
  });

  app.get("/api/accounts/multi-currency/cash-bank-revaluation", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      return res.json(await getCashBankRevaluation(companyId));
    } catch (error: unknown) {
      logger.error("Multi-currency cash/bank revaluation failed:", {
        error: error,
      });
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/accounts/multi-currency/:kind/:id", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const kind = req.params.kind;
      if (kind !== "ledger" && kind !== "bank") {
        return res.status(400).json({ message: "Account kind must be ledger or bank" });
      }
      const accountId = Number.parseInt(req.params.id, 10);
      if (!Number.isInteger(accountId) || accountId <= 0) {
        return res.status(400).json({ message: "Invalid account ID" });
      }

      const summary = await getCashBankAccountSummary(companyId, kind, accountId);
      if (!summary) return res.status(404).json({ message: "Cash/bank account not found" });
      return res.json(summary);
    } catch (error: unknown) {
      logger.error("Multi-currency account summary failed:", {
        error: error,
      });
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
