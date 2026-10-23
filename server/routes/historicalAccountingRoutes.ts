/** Phase 10 — read-only historical accounting across ERP, Factory and Properties. */
import type { Express, Request, Response } from "express";
import { z } from "zod";
import { db } from "../db";
import { requireAuth, requireRole } from "../auth";
import { companyBusinessDate } from "../services/accounting/companyBusinessDate";
import {
  historicalFinancialWorkpaperTx,
  historicalErpStockAtCostTx,
} from "../services/accounting/historicalFinancialWorkpaper";
import { getHistoricalCurrencyReadiness } from "../services/accounting/historicalCurrencyReadiness";
import { getErrorMessage } from "../lib/httpHandlers";

const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const reportQuery = z.object({ asOfDate: iso.optional(), fromDate: iso.optional() });
function companyId(req: Request) {
  const id = Number(req.session.currentCompanyId);
  if (!Number.isSafeInteger(id) || id <= 0) throw Object.assign(new Error("Select a company"), { status: 400 });
  return id;
}
function date(v: string) {
  const d = new Date(v + "T00:00:00.000Z");
  if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== v)
    throw Object.assign(new Error("Invalid historical date"), { status: 400 });
  return v;
}
function fail(res: Response, error: unknown) {
  if (error instanceof z.ZodError)
    return res.status(400).json({
      code: "HISTORICAL_ACCOUNTING_DATE_INVALID",
      message: error.issues.map((e) => e.message).join("; "),
    });
  const reason = getErrorMessage(error);
  const status =
    (error as { status?: number })?.status ?? (/^HISTORICAL_(DATE|PERIOD|FUTURE|COMPANY)/.test(reason) ? 400 : 500);
  return res.status(status).json({
    code: status === 400 ? "HISTORICAL_ACCOUNTING_REQUEST_INVALID" : "HISTORICAL_ACCOUNTING_REPORT_FAILED",
    message: status === 500 ? "Cannot generate the historical accounting workpaper" : reason,
  });
}
export function registerHistoricalAccountingRoutes(app: Express) {
  const gate = [requireAuth, requireRole("Admin", "Owner", "Developer")] as const;
  app.get("/api/accounting/history/report", ...gate, async (req, res) => {
    try {
      const query = reportQuery.parse(req.query),
        company = companyId(req);
      const asOfDate = date(query.asOfDate ?? (await companyBusinessDate(company)));
      const fromDate = date(query.fromDate ?? asOfDate.slice(0, 4) + "-01-01");
      if (fromDate > asOfDate)
        return res.status(400).json({
          code: "HISTORICAL_ACCOUNTING_PERIOD_INVALID",
          message: "From date must not be after as-of date",
        });
      const report = await db.transaction((tx) =>
        historicalFinancialWorkpaperTx(tx, {
          companyId: company,
          asOfDate,
          fromDate,
        })
      );
      // Historical currency readiness is a *secondary* read-only safety signal.
      // Pure legacy mode permits reporting, but is not proof of full FX history.
      const historicalFx = await getHistoricalCurrencyReadiness(company, asOfDate);
      res.setHeader("Cache-Control", "no-store");
      return res.json({
        ...report,
        historicalFx: {
          ...historicalFx,
          certified: false,
          note: historicalFx.legacyCompatibilityMode
            ? "Legacy FX compatibility mode: original USD historical conversion is not verified."
            : historicalFx.ready
              ? "Historical base-field completeness gate passed; original FX rates and past state remain uncertified."
              : "Non-USD historical base values are unresolved by the selected accounting cutoff.",
        },
      });
    } catch (e) {
      return fail(res, e);
    }
  });
  app.get("/api/accounting/history/erp-stock", ...gate, async (req, res) => {
    try {
      const body = z.object({ asOfDate: iso }).parse(req.query);
      const company = companyId(req),
        asOfDate = date(body.asOfDate);
      const report = await db.transaction((tx) =>
        historicalErpStockAtCostTx(tx, {
          companyId: company,
          asOfDate,
        })
      );
      res.setHeader("Cache-Control", "no-store");
      return res.json(report);
    } catch (e) {
      return fail(res, e);
    }
  });
}
