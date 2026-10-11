import type { Express } from "express";
import { requireAuth, requireNonPOS } from "../../auth";

import { getProfitLoss, getBalanceSheet } from "../../services/reports/financialReportsService";
import { optionalIsoDate } from "../../services/accounting/reporting/reportDates";
import { fiscalYearStart } from "../../services/accounting/reporting/classificationMap";
import { requireFinancialReportAccess } from "./financialReportAccess";
import { asOfReportContext, sendFinancialReportError } from "./financialStatementRoutes";

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

  // Phase 27: Admin/Owner/Manager (RP-15). Without an endDate the P&L stops at
  // the company's business date and flags the later vouchers (RP-8), and
  // without a startDate it starts on the fiscal year's first day (RP-4);
  // compareStartDate/compareEndDate add a comparative P&L (RP-7).
  app.get("/api/reports/profit-loss", requireAuth, requireNonPOS, requireFinancialReportAccess, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const context = await asOfReportContext(companyId, req.query.endDate, "endDate");
      // Without a startDate the P&L is the fiscal year (calendar year) to the end date (was all time).
      const startDate = optionalIsoDate(req.query.startDate, "startDate") ?? fiscalYearStart(context.asOf);
      const compareStart = optionalIsoDate(req.query.compareStartDate, "compareStartDate");
      const compareEnd = optionalIsoDate(req.query.compareEndDate, "compareEndDate");
      const [report, comparative] = await Promise.all([
        getProfitLoss(companyId, startDate, context.asOf),
        compareEnd ? getProfitLoss(companyId, compareStart ?? undefined, compareEnd) : Promise.resolve(null),
      ]);
      res.json({
        ...report,
        endDateDefaulted: context.defaulted,
        businessDate: context.businessDate,
        futureDated: context.futureDated,
        comparative,
      });
    } catch (error: unknown) {
      sendFinancialReportError(res, error);
    }
  });

  // Phase 27: as for the P&L; compareAsOfDate adds a comparative balance sheet.
  app.get("/api/reports/balance-sheet", requireAuth, requireNonPOS, requireFinancialReportAccess, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const context = await asOfReportContext(companyId, req.query.asOfDate, "asOfDate");
      const compareAsOf = optionalIsoDate(req.query.compareAsOfDate, "compareAsOfDate");
      const [sheet, comparative] = await Promise.all([
        getBalanceSheet(companyId, context.asOf),
        compareAsOf ? getBalanceSheet(companyId, compareAsOf) : Promise.resolve(null),
      ]);
      res.json({
        ...sheet,
        asOfDefaulted: context.defaulted,
        businessDate: context.businessDate,
        futureDated: context.futureDated,
        comparative,
      });
    } catch (error: unknown) {
      sendFinancialReportError(res, error);
    }
  });
}
