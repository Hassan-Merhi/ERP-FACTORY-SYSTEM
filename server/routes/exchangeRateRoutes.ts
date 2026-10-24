/**
 * Company-scoped ERP exchange rate routes.
 *
 * ERP stores foreign currency per one accounting-base currency unit
 * (for Zambia: 1 USD = N ZMW). Factory rateToUsd uses the inverse direction.
 * No rate save here posts a voucher or revalues historical records.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { storage } from "../storage";
import { requireAuth, requireRole } from "../auth";
import { getCompanyBusinessDate } from "../lib/dateUtils";
import { insertExchangeRateSchema } from "@shared/schema";
import { normalizeAccountingCurrencyAlias } from "@shared/currencyCatalog";
import { companyRateValueSchema, companyRateDateSchema } from "@shared/companyRatePolicy";
import { saveCompanyExchangeRate } from "../services/accounting/exchangeRateWrites";

type CompanyCurrencyPair = { fromCurrency: string; toCurrency: string };

function activeRateCompanyId(req: Request, res: Response): number | null {
  const active = Number(req.session.currentCompanyId);
  if (!Number.isSafeInteger(active) || active <= 0) {
    res.status(400).json({ message: "Company not selected" });
    return null;
  }
  // Rates are current-company data, including for Developer. Never resolve a
  // rate using a different companyId while the session is on Mali or Zambia.
  const requested = req.query.companyId;
  if (requested !== undefined && (typeof requested !== "string" || requested !== String(active))) {
    res.status(403).json({
      code: "EXCHANGE_RATE_COMPANY_MISMATCH",
      message: "Switch to the requested company before accessing its exchange rates.",
    });
    return null;
  }
  return active;
}

function configuredRatePair(company: {
  baseCurrency?: string | null;
  displayCurrency?: string | null;
}): CompanyCurrencyPair | null {
  if (!company.baseCurrency || !company.displayCurrency || company.displayCurrency === "none") return null;
  const fromCurrency = normalizeAccountingCurrencyAlias(company.baseCurrency);
  const toCurrency = normalizeAccountingCurrencyAlias(company.displayCurrency);
  return fromCurrency && toCurrency && fromCurrency !== toCurrency ? { fromCurrency, toCurrency } : null;
}

function requestedPairMatches(
  req: Request,
  res: Response,
  configured: CompanyCurrencyPair | null,
  requirePair = false
): CompanyCurrencyPair | null {
  const from = req.query.fromCurrency;
  const to = req.query.toCurrency;
  if (from === undefined && to === undefined && !requirePair) return configured;
  if (typeof from !== "string" || typeof to !== "string") {
    res.status(400).json({ message: "Both fromCurrency and toCurrency are required." });
    return null;
  }
  if (
    !configured ||
    normalizeAccountingCurrencyAlias(from) !== configured.fromCurrency ||
    normalizeAccountingCurrencyAlias(to) !== configured.toCurrency
  ) {
    res.status(400).json({
      code: "EXCHANGE_RATE_PAIR_MISMATCH",
      message: "Exchange-rate pair does not match the active company's configured currencies.",
    });
    return null;
  }
  return configured;
}

function validRateRow(row: { rate: string } | null | undefined): boolean {
  return !!row && companyRateValueSchema.safeParse(String(row.rate)).success;
}

export function registerExchangeRateRoutes(app: Express) {
  app.get("/api/exchange-rates/check-today", requireAuth, async (req, res) => {
    try {
      const companyId = activeRateCompanyId(req, res);
      if (companyId === null) return;
      const company = await storage.getCompanyById(companyId);
      if (!company) return res.status(404).json({ message: "Company not found" });
      const settings = await storage.getCompanySettings(companyId);
      const today = getCompanyBusinessDate(settings?.timezone);
      const pair = configuredRatePair(company);
      if (!pair) return res.json({ hasRate: true, today, latestRate: null });

      const latestRate = await storage.getLatestExchangeRate(companyId, pair.fromCurrency, pair.toCurrency, today);
      if (!validRateRow(latestRate)) {
        // Invalid/missing historic rate is not a usable rate for a new sale.
        return res.json({ hasRate: false, today, latestRate: null, missingRate: true });
      }
      const effectiveDate =
        typeof latestRate!.effectiveDate === "string"
          ? latestRate!.effectiveDate.slice(0, 10)
          : new Date(latestRate!.effectiveDate).toISOString().slice(0, 10);
      res.json({ hasRate: effectiveDate === today, latestRate, today, missingRate: false });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Full history defaults to the active company; an optional pair filter is
  // always checked against its configured pair to prevent cross-pair reads.
  app.get("/api/exchange-rates", requireAuth, async (req, res) => {
    try {
      const companyId = activeRateCompanyId(req, res);
      if (companyId === null) return;
      const company = await storage.getCompanyById(companyId);
      if (!company) return res.status(404).json({ message: "Company not found" });
      const configured = configuredRatePair(company);
      const hasPairFilter = req.query.fromCurrency !== undefined || req.query.toCurrency !== undefined;
      const pair = hasPairFilter ? requestedPairMatches(req, res, configured, true) : null;
      if (hasPairFilter && !pair) return;
      const rates = await storage.getExchangeRates(companyId);
      res.json(
        pair
          ? rates.filter(
              (rate) =>
                normalizeAccountingCurrencyAlias(rate.fromCurrency) === pair.fromCurrency &&
                normalizeAccountingCurrencyAlias(rate.toCurrency) === pair.toCurrency
            )
          : rates
      );
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/exchange-rates/latest", requireAuth, async (req, res) => {
    try {
      const companyId = activeRateCompanyId(req, res);
      if (companyId === null) return;
      const company = await storage.getCompanyById(companyId);
      if (!company) return res.status(404).json({ message: "Company not found" });
      const pair = requestedPairMatches(req, res, configuredRatePair(company), true);
      if (!pair) return;
      const asOf = req.query.asOf;
      if (asOf !== undefined && (typeof asOf !== "string" || !companyRateDateSchema.safeParse(asOf).success)) {
        return res
          .status(400)
          .json({ code: "EXCHANGE_RATE_DATE_INVALID", message: "Use a valid YYYY-MM-DD asOf date." });
      }
      const settings = await storage.getCompanySettings(companyId);
      const businessDate = getCompanyBusinessDate(settings?.timezone);
      if (typeof asOf === "string" && asOf > businessDate) {
        return res.status(400).json({
          code: "EXCHANGE_RATE_FUTURE_DATE",
          message: "Cannot use a future-dated company rate for POS sales.",
        });
      }
      const rate =
        typeof asOf === "string"
          ? await storage.getExchangeRateForDate(companyId, pair.fromCurrency, pair.toCurrency, asOf)
          : await storage.getLatestExchangeRate(companyId, pair.fromCurrency, pair.toCurrency, businessDate);
      res.json(validRateRow(rate) ? rate : null);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Admin/Owner/Developer only (requireRole includes Developer), with an
  // atomic audited save. The server chooses the active company; the caller
  // cannot inject a rate into a different company or an unconfigured pair.
  app.post("/api/exchange-rates", requireAuth, requireRole("Admin", "Owner"), async (req, res) => {
    try {
      const companyId = activeRateCompanyId(req, res);
      if (companyId === null) return;
      const company = await storage.getCompanyById(companyId);
      if (!company) return res.status(404).json({ message: "Company not found" });
      const parsed = insertExchangeRateSchema.safeParse({ ...req.body, companyId });
      if (!parsed.success) {
        return res.status(400).json({ message: "Validation error", errors: parsed.error.issues });
      }
      // A company with a configured display currency may only save that pair
      // (Mali USD/CFA, Zambia USD/ZMW). A company without one keeps the original
      // contract: any pair quoted against its own accounting base.
      const configured = configuredRatePair(company);
      const requestedFrom = normalizeAccountingCurrencyAlias(parsed.data.fromCurrency);
      const requestedTo = normalizeAccountingCurrencyAlias(parsed.data.toCurrency);
      const pair: CompanyCurrencyPair | null =
        configured ??
        (requestedFrom === normalizeAccountingCurrencyAlias(company.baseCurrency || "USD") &&
        requestedFrom !== requestedTo
          ? { fromCurrency: requestedFrom, toCurrency: requestedTo }
          : null);
      if (!pair)
        return res.status(409).json({
          code: "EXCHANGE_RATE_NOT_CONFIGURED",
          message:
            "Rates are quoted against the company's accounting base currency; enable a display currency to use a fixed pair.",
        });
      // Daily popup submissions must be dated TODAY in the company's own
      // timezone, even if the popup remained open past midnight. The
      // historical rate settings form may intentionally save another date.
      if (req.body?.daily === true) {
        const settings = await storage.getCompanySettings(companyId);
        const businessDate = getCompanyBusinessDate(settings?.timezone);
        if (parsed.data.effectiveDate !== businessDate) {
          return res.status(409).json({
            code: "EXCHANGE_RATE_BUSINESS_DATE_CHANGED",
            message: "The company's business date changed. Reload the daily rate prompt before saving.",
            today: businessDate,
          });
        }
      }
      const fromCurrency = requestedFrom;
      const toCurrency = requestedTo;
      if (fromCurrency !== pair.fromCurrency || toCurrency !== pair.toCurrency) {
        return res.status(400).json({
          code: "EXCHANGE_RATE_PAIR_MISMATCH",
          message: "Only the active company's configured currency pair can be updated.",
        });
      }

      const rate = await saveCompanyExchangeRate(
        { userId: req.session.userId!, username: req.session.username || "unknown", companyId },
        { fromCurrency, toCurrency, rate: parsed.data.rate, effectiveDate: parsed.data.effectiveDate }
      );
      // No automatic FX-REVAL journal: report-time cash/bank translation only.
      // Previously-posted vouchers and historical rates remain unchanged.
      res.json(rate);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
