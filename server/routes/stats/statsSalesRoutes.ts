import type { Express } from "express";
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
      res.json(await getBalanceSheet(companyId, asOfDate as string | undefined));
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
