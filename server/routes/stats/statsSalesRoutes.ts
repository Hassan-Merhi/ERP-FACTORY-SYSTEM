import type { Express } from "express";
import { logger } from "../../lib/logger";
import { getMonetaryFxValuation } from "../../services/accounting/monetaryFxValuationService";
import { applyCurrentBalanceSheetFxOverlay } from "../../services/accounting/monetaryFxReportOverlay";
import { getErrorMessage } from "../../lib/httpHandlers";
import { requireAuth, requireNonPOS } from "../../auth";

import { getProfitLoss, getBalanceSheet } from "../../services/reports/financialReportsService";

export function registerStatsSalesRoutes(app: Express) {
  app.post("/api/sales-report/recalculate-costs", requireAuth, requireNonPOS, async (req, res) => {
    const companyId = req.session.currentCompanyId;
    if (!companyId) return res.status(400).json({ message: "No company selected" });

    // Historical sales are immutable. The old implementation rewrote every
    // posted sale from the location's current inventory average, corrupting
    // transaction-time COGS after later receipts/offloads.
    return res.status(409).json({
      code: "HISTORICAL_SALE_COST_IMMUTABLE",
      message:
        "Historical sale costs cannot be recalculated from current inventory. Use the audited historical-cost repair workflow instead.",
    });
  });

  app.get("/api/reports/profit-loss", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const { startDate, endDate } = req.query;
      res.json(await getProfitLoss(companyId, startDate as string | undefined, endDate as string | undefined));
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/reports/balance-sheet", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const { asOfDate } = req.query;
      const sheet = await getBalanceSheet(companyId, asOfDate as string | undefined);
      // Current statement only: eligible monetary lines (cash/bank, customers,
      // loans, approved monetary assets) at the company's current effective
      // rate, balanced by a reporting-only equity line. A dated statement keeps
      // its booked USD; no voucher or journal is written by this read.
      if (!asOfDate) {
        try {
          const valuation = await getMonetaryFxValuation(companyId);
          const projected = applyCurrentBalanceSheetFxOverlay(sheet, valuation);
          res.setHeader("Cache-Control", "private, no-store");
          return res.json({
            ...projected.payload,
            currencyRevaluation: {
              valuationMode: "CURRENT",
              currentMonetaryTranslationApplied: projected.appliedKeys.length > 0,
              appliedAccountKeys: projected.appliedKeys,
              skippedAccountKeys: projected.skipped,
              translationDifferenceUsd: projected.translationDifferenceUsd,
              unresolvedAccountCount: valuation.unresolvedAccountCount,
              needsReviewCount: valuation.needsReviewCount,
              rateErrorsByCurrency: valuation.rateErrorsByCurrency,
              bookBalancesModified: false,
              fxVouchersPosted: false,
            },
          });
        } catch (error) {
          logger.error("[reports/balance-sheet] Current monetary FX view unavailable; serving book USD", {
            companyId, error,
          });
        }
      }
      res.json(sheet);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
