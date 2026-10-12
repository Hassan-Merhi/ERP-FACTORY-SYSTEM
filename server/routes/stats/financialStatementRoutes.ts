/**
 * Financial statement routes added by accounting audit phase 27.
 *
 *   GET /api/reports/trial-balance?from&to&compare=none|priorPeriod|priorYear
 *       period trial balance with comparatives (RP-7/RP-8);
 *   GET /api/reports/cash-flow?from&to   indirect cash flow statement (RP-2);
 *   GET /api/reports/export/:report?format=xlsx|pdf&...   Excel/PDF of the
 *       trial balance, balance sheet, P&L, aging, ratios and cash flow, from the
 *       same services as the pages (RP-1).
 * All read-only, for the current company, Admin/Owner/Manager (RP-15).
 */
import type { Express, Response } from "express";

import { requireAuth } from "../../auth";
import { getErrorMessage } from "../../lib/httpHandlers";
import { storage } from "../../storage";
import { getBalanceSheet, getFinancialRatios, getProfitLoss } from "../../services/reports/financialReportsService";
import { AGING_KINDS, getAgingReport, type AgingKind } from "../../services/reports/agingReport";
import {
  buildPeriodTrialBalance,
  TRIAL_BALANCE_COMPARISONS,
  type TrialBalanceComparison,
} from "../../services/accounting/reporting/periodTrialBalance";
import { buildCashFlowStatement } from "../../services/accounting/reporting/cashFlowStatement";
import {
  futureDatedVouchers,
  optionalIsoDate,
  ReportDateError,
  resolveReportDate,
} from "../../services/accounting/reporting/reportDates";
import {
  exportFileStem,
  REPORT_EXPORT_FORMATS,
  renderReportTable,
  type ReportExportFormat,
  type ReportTable,
} from "../../services/accounting/reporting/reportExport";
import {
  agingTable,
  balanceSheetTable,
  cashFlowTable,
  profitLossTable,
  ratiosTable,
  trialBalanceTable,
} from "../../services/accounting/reporting/reportTables";
import { fiscalYearStart } from "../../services/accounting/reporting/classificationMap";
import { requireFinancialReportAccess } from "./financialReportAccess";

export const EXPORTABLE_REPORTS = [
  "trial-balance",
  "balance-sheet",
  "profit-loss",
  "aging",
  "ratios",
  "cash-flow",
] as const;
export type ExportableReport = (typeof EXPORTABLE_REPORTS)[number];

class ReportRequestError extends Error {}

function comparisonOf(value: unknown): TrialBalanceComparison {
  if (value === undefined || value === "") return "none";
  if (typeof value !== "string" || !TRIAL_BALANCE_COMPARISONS.includes(value as TrialBalanceComparison)) {
    throw new ReportRequestError("compare must be none, priorPeriod or priorYear");
  }
  return value as TrialBalanceComparison;
}

function sendError(res: Response, error: unknown) {
  if (error instanceof ReportDateError || error instanceof ReportRequestError || error instanceof RangeError) {
    return res.status(400).json({ message: error.message });
  }
  return res.status(500).json({ message: getErrorMessage(error) });
}

async function companyName(companyId: number): Promise<string> {
  const company = await storage.getCompanyById(companyId);
  return company?.name ?? `Company ${companyId}`;
}

/** The export's table, built from the same service the page reads. */
async function exportTable(
  companyId: number,
  report: ExportableReport,
  query: Record<string, unknown>
): Promise<{ table: ReportTable; date: string }> {
  const name = await companyName(companyId);
  switch (report) {
    case "trial-balance": {
      const result = await buildPeriodTrialBalance({
        companyId,
        from: optionalIsoDate(query.from, "from"),
        to: optionalIsoDate(query.to, "to"),
        compare: comparisonOf(query.compare),
      });
      return { table: trialBalanceTable(result, name), date: result.to };
    }
    case "balance-sheet": {
      const { asOf } = await resolveReportDate(companyId, optionalIsoDate(query.asOfDate, "asOfDate"));
      return { table: balanceSheetTable(await getBalanceSheet(companyId, asOf), asOf, name), date: asOf };
    }
    case "profit-loss":
    case "ratios": {
      const { asOf: endDate } = await resolveReportDate(companyId, optionalIsoDate(query.endDate, "endDate"));
      const startDate = optionalIsoDate(query.startDate, "startDate") ?? fiscalYearStart(endDate);
      const period = `${startDate} – ${endDate}`;
      if (report === "profit-loss") {
        return {
          table: profitLossTable(await getProfitLoss(companyId, startDate, endDate), period, name),
          date: endDate,
        };
      }
      return {
        table: ratiosTable(await getFinancialRatios(companyId, startDate, endDate), period, name),
        date: endDate,
      };
    }
    case "aging": {
      const kind = query.kind;
      if (typeof kind !== "string" || !AGING_KINDS.includes(kind as AgingKind)) {
        throw new ReportRequestError(`kind must be one of ${AGING_KINDS.join(", ")}`);
      }
      const result = await getAgingReport(companyId, kind as AgingKind, optionalIsoDate(query.asOf, "asOf"));
      return { table: agingTable(result, name), date: result.referenceDate };
    }
    case "cash-flow": {
      const result = await buildCashFlowStatement({
        companyId,
        from: optionalIsoDate(query.from, "from"),
        to: optionalIsoDate(query.to, "to"),
      });
      return { table: cashFlowTable(result, name), date: result.to };
    }
  }
}

export function registerFinancialStatementRoutes(app: Express) {
  app.get("/api/reports/trial-balance", requireAuth, requireFinancialReportAccess, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      res.json(
        await buildPeriodTrialBalance({
          companyId,
          from: optionalIsoDate(req.query.from, "from"),
          to: optionalIsoDate(req.query.to, "to"),
          compare: comparisonOf(req.query.compare),
        })
      );
    } catch (error: unknown) {
      sendError(res, error);
    }
  });

  app.get("/api/reports/cash-flow", requireAuth, requireFinancialReportAccess, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      res.json(
        await buildCashFlowStatement({
          companyId,
          from: optionalIsoDate(req.query.from, "from"),
          to: optionalIsoDate(req.query.to, "to"),
        })
      );
    } catch (error: unknown) {
      sendError(res, error);
    }
  });

  app.get("/api/reports/export/:report", requireAuth, requireFinancialReportAccess, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const report = req.params.report as ExportableReport;
      if (!EXPORTABLE_REPORTS.includes(report)) return res.status(404).json({ message: "Unknown report" });
      const format = (req.query.format ?? "xlsx") as ReportExportFormat;
      if (!REPORT_EXPORT_FORMATS.includes(format)) {
        return res.status(400).json({ message: "format must be xlsx or pdf" });
      }
      const { table, date } = await exportTable(companyId, report, req.query as Record<string, unknown>);
      const rendered = await renderReportTable(table, format);
      res.setHeader("Content-Type", rendered.contentType);
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${exportFileStem(table.title, date)}.${rendered.extension}"`
      );
      res.end(rendered.buffer);
    } catch (error: unknown) {
      sendError(res, error);
    }
  });
}

/** Business-date default and future-dated flags for the as-of reports (RP-8). */
export async function asOfReportContext(companyId: number, requested: unknown, name: string) {
  const resolved = await resolveReportDate(companyId, optionalIsoDate(requested, name));
  const futureDated = await futureDatedVouchers(companyId, resolved.businessDate);
  return { ...resolved, futureDated };
}
export { sendError as sendFinancialReportError };
