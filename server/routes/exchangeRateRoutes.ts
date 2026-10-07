/**
 * Exchange-rate routes.
 *
 * Daily exchange-rate existence check, listing, latest-rate lookup, and
 * create/update. Extracted from authRoutes.ts as a sub-registrar; behaviour is
 * unchanged.
 */
import type { Express } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { storage } from "../storage";
import { requireAuth } from "../auth";
import { getCompanyBusinessDate } from "../lib/dateUtils";
import { insertExchangeRateSchema } from "@shared/schema";

export function registerExchangeRateRoutes(app: Express) {
  // Check if today's exchange rate exists
  app.get("/api/exchange-rates/check-today", requireAuth, async (req, res) => {
    try {
      const companyId = req.query.companyId ? parseInt(req.query.companyId as string) : req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "Company not selected" });
      }

      const company = await storage.getCompanyById(companyId);
      if (!company?.displayCurrency || company.displayCurrency === "none") {
        return res.json({ hasRate: true });
      }

      // "Today" is the company's own business date (its configured timezone), never the
      // requesting browser's clock — otherwise two users in different timezones/devices
      // could disagree on whether "today's" rate has been set for this shared company.
      const companySettings = await storage.getCompanySettings(companyId);
      const today = getCompanyBusinessDate(companySettings?.timezone);

      const latestRate = await storage.getLatestExchangeRate(
        companyId,
        company.baseCurrency || "",
        company.displayCurrency
      );

      if (!latestRate) {
        return res.json({ hasRate: false, today });
      }

      const rateDate = new Date(latestRate.effectiveDate).toISOString().split("T")[0];
      const hasRate = rateDate === today;

      res.json({ hasRate, latestRate, today });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Exchange Rates - Get all rates for current company
  app.get("/api/exchange-rates", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "Company not selected" });
      }
      const rates = await storage.getExchangeRates(companyId);
      res.json(rates);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Get latest exchange rate for a currency pair
  app.get("/api/exchange-rates/latest", requireAuth, async (req, res) => {
    try {
      // Allow companyId from query param (for frontend context) or fall back to session
      const companyId = req.query.companyId ? parseInt(req.query.companyId as string) : req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "Company not selected" });
      }
      const { fromCurrency, toCurrency } = req.query;
      if (!fromCurrency || !toCurrency) {
        return res.status(400).json({ message: "fromCurrency and toCurrency are required" });
      }
      const rate = await storage.getLatestExchangeRate(companyId, fromCurrency as string, toCurrency as string);
      res.json(rate || null);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Create a new exchange rate
  app.post("/api/exchange-rates", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "Company not selected" });
      }
      const rateData = {
        ...req.body,
        companyId,
      };

      // Validate input with Zod schema
      const validationResult = insertExchangeRateSchema.safeParse(rateData);
      if (!validationResult.success) {
        return res.status(400).json({
          message: "Validation error",
          errors: validationResult.error.issues,
        });
      }

      // Atomic upsert — relies on the exchange_rates_company_date_pair_unique DB
      // constraint so two users saving the same company/date/pair concurrently can
      // never create duplicate rows; the second save simply updates the first's row.
      const rate = await storage.upsertExchangeRate(validationResult.data);

      // Saving a rate only saves the rate. An automatic "FX-REVAL" journal used to be
      // posted here (wave 9 ledger-safety audit, docs/accounting-audit-2026-10.md §7):
      // it treated every Cash ledger account as CFA (ledger accounts carry no currency),
      // used float maths, autocommit writes with swallowed errors and no audit, and
      // re-posted every time a rate was re-saved. Revaluation is now report-time only
      // (cashBankRevaluationService / /api/accounts/multi-currency/cash-bank-revaluation).
      // Historical FX-REVAL vouchers are left untouched.

      res.json(rate);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
