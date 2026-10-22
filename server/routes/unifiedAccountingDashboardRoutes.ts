/** Phase 14 — read-only unified accounting dashboard, standalone company. */
import type { Express, Request, Response } from "express";
import { z } from "zod";
import { db } from "../db";
import { requireAuth, requireRole } from "../auth";
import { companyBusinessDate } from "../services/accounting/companyBusinessDate";
import { getErrorMessage } from "../lib/httpHandlers";
import { getHistoricalCurrencyReadiness } from "../services/accounting/historicalCurrencyReadiness";
import { unifiedAccountingDashboardTx } from "../services/accounting/unifiedAccountingDashboard";
const calendar = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const params = z.object({
  fromDate: calendar.optional(),
  asOfDate: calendar.optional(),
  valuationBasis: z.enum(["cost", "selling"]).default("cost"),
  includeOperational: z.enum(["true", "false"]).default("false"),
});
function validDay(s: string) {
  const d = new Date(s + "T00:00:00.000Z");
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(d.valueOf()) && d.toISOString().slice(0, 10) === s;
}
function sessionCompany(req: Request) {
  const n = Number(req.session.currentCompanyId);
  if (!Number.isSafeInteger(n) || n < 1) throw Object.assign(new Error("Select a company"), { status: 400 });
  return n;
}
function fail(res: Response, error: unknown) {
  const e = error as { status?: number };
  const message = getErrorMessage(error);
  const bad =
    e?.status === 400 ||
    e?.status === 403 ||
    /^DASHBOARD_(DATE|PERIOD|COMPANY)_INVALID$/.test(message) ||
    /^FINANCIAL_(PERIOD|COMPANY|FUTURE_DATE|BASE_CURRENCY)/.test(message);
  const status = e?.status === 403 ? 403 : bad ? 400 : 500;
  return res.status(status).json({
    code:
      status === 400
        ? "UNIFIED_DASHBOARD_INVALID_REQUEST"
        : status === 403
          ? "UNIFIED_DASHBOARD_ACCESS_DENIED"
          : "UNIFIED_DASHBOARD_UNAVAILABLE",
    message: status === 500 ? "Unable to assemble the posted accounting dashboard" : message,
  });
}
export function registerUnifiedAccountingDashboardRoutes(app: Express) {
  app.get(
    "/api/accounting/unified-dashboard",
    requireAuth,
    requireRole("Admin", "Owner", "Developer"),
    async (req: Request, res: Response) => {
      const parsed = params.safeParse(req.query);
      if (!parsed.success)
        return res.status(400).json({
          code: "UNIFIED_DASHBOARD_INVALID_REQUEST",
          message:
            "fromDate and asOfDate must be ISO dates; valuationBasis cost/selling; includeOperational true/false",
        });
      try {
        const companyId = sessionCompany(req);
        const today = await companyBusinessDate(companyId);
        const asOfDate = parsed.data.asOfDate ?? today;
        const fromDate = parsed.data.fromDate ?? asOfDate.slice(0, 4) + "-01-01";
        if (!validDay(asOfDate) || !validDay(fromDate) || fromDate > asOfDate)
          return res.status(400).json({
            code: "UNIFIED_DASHBOARD_INVALID_DATE",
            message: "Choose real ISO calendar dates, with the start not after the end",
          });
        const result = await db.transaction((tx) =>
          unifiedAccountingDashboardTx(tx, {
            companyId,
            asOfDate,
            fromDate,
            valuationBasis: parsed.data.valuationBasis,
            includeOperational: parsed.data.includeOperational === "true",
          })
        );
        // This compatibility reader can return 'ready' in pure legacy mode:
        // a passing value is never treated as independent certification.
        const historicalFx = await getHistoricalCurrencyReadiness(companyId, asOfDate);
        if (!historicalFx.ready) {
          result.controls.blockers.push(
            "Historical non-USD entries/openings lack verified USD base. This dashboard is not certified."
          );
        }
        if (historicalFx.legacyCompatibilityMode) {
          result.controls.warnings.push(
            "Historical FX is in legacy compatibility mode. No missing-row finding is NOT proof that older transactions had the correct original USD book values."
          );
        }
        res.setHeader("Cache-Control", "private, no-store");
        return res.json({
          ...result,
          historicalFx: {
            ...historicalFx,
            certified: false,
            caveat: "Legacy compatibility-ready does not prove historical FX backfill or audited base amounts.",
          },
        });
      } catch (error) {
        return fail(res, error);
      }
    }
  );
}
