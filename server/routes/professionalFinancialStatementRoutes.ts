/** Phase 11 — read-only professional financial statements, ERP/Factory/Properties. */
import type { Express, Request, Response } from "express";
import { z } from "zod";
import { db } from "../db";
import { requireAuth, requireRole } from "../auth";
import { getErrorMessage } from "../lib/httpHandlers";
import { companyBusinessDate } from "../services/accounting/companyBusinessDate";
import { getHistoricalCurrencyReadiness } from "../services/accounting/historicalCurrencyReadiness";
import { professionalFinancialStatementsTx } from "../services/accounting/professionalFinancialStatements";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const params = z.object({
  asOfDate: date.optional(),
  fromDate: date.optional(),
  compare: z.enum(["true", "false"]).optional().default("false"),
});
function company(req: Request): number {
  const n = Number(req.session.currentCompanyId);
  if (!Number.isSafeInteger(n) || n <= 0) throw Object.assign(new Error("Select a company"), { status: 400 });
  return n;
}
function errorStatus(e: unknown) {
  const status = (e as { status?: number })?.status;
  if (status === 400 || status === 403) return status;
  const msg = getErrorMessage(e);
  return /^FINANCIAL_(FUTURE|PERIOD|COMPANY|BASE_CURRENCY)/.test(msg) ? 400 : 500;
}
export function registerProfessionalFinancialStatementRoutes(app: Express) {
  const gate = [requireAuth, requireRole("Admin", "Owner", "Developer")] as const;
  app.get("/api/accounting/statements/professional", ...gate, async (req: Request, res: Response) => {
    const parsed = params.safeParse(req.query);
    if (!parsed.success)
      return res.status(400).json({
        code: "FINANCIAL_STATEMENT_INVALID_REQUEST",
        message: "fromDate and asOfDate must be YYYY-MM-DD; compare must be true or false",
      });
    try {
      const companyId = company(req);
      const asOfDate = parsed.data.asOfDate ?? (await companyBusinessDate(companyId));
      const fromDate = parsed.data.fromDate ?? asOfDate.slice(0, 4) + "-01-01";
      const result = await db.transaction((tx) =>
        professionalFinancialStatementsTx(tx, {
          companyId,
          asOfDate,
          fromDate,
          compare: parsed.data.compare === "true",
        })
      );
      // FX readiness is a separate, read-only compatibility guard. Even
      // readiness=true may mean pure-legacy mode, not backfilled historical FX.
      const historicalFx = await getHistoricalCurrencyReadiness(companyId, asOfDate);
      if (!historicalFx.ready) {
        result.current.controls.blockers.push(
          "Current-period historical currency data is incomplete; financial statement amounts require review"
        );
      }
      if (historicalFx.legacyCompatibilityMode) {
        result.current.controls.warnings.push(
          "Current-period historical FX uses legacy compatibility mode; ready does not mean certified conversion."
        );
      }
      // The prior period must be assessed at its own accounting cutoff.
      // Never copy current-period FX readiness to the comparison column.
      const comparisonHistoricalFx = result.comparisonPeriod
        ? await getHistoricalCurrencyReadiness(companyId, result.comparisonPeriod.asOfDate)
        : null;
      if (result.comparison && comparisonHistoricalFx && !comparisonHistoricalFx.ready) {
        result.comparison.controls.blockers.push(
          "Comparison-period historical currency data is incomplete; comparison amounts require review"
        );
      }
      if (result.comparison && comparisonHistoricalFx?.legacyCompatibilityMode) {
        result.comparison.controls.warnings.push(
          "Comparison-period historical FX uses legacy compatibility mode; ready does not mean certified conversion."
        );
      }
      res.setHeader("Cache-Control", "no-store");
      return res.json({
        ...result,
        historicalFx: {
          ...historicalFx,
          certified: false,
          caveat: "Compatibility-ready in pure legacy mode does not prove complete historical USD conversion.",
        },
        comparisonHistoricalFx: comparisonHistoricalFx
          ? {
              ...comparisonHistoricalFx,
              certified: false,
              caveat: "Comparison-period compatibility is not independent certification of historical FX.",
            }
          : null,
      });
    } catch (e) {
      const status = errorStatus(e);
      return res.status(status).json({
        code: status === 400 ? "FINANCIAL_STATEMENT_INVALID_REQUEST" : "FINANCIAL_STATEMENT_READ_FAILED",
        message: status === 500 ? "Could not calculate the financial statements" : getErrorMessage(e),
      });
    }
  });
}
