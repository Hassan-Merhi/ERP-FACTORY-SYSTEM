import type { Express, RequestHandler } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { requireAuth, requireNonPOS } from "../auth";
import { getHistoricalCurrencyReadiness } from "../services/accounting/historicalCurrencyReadiness";

function isGuardedFinancialPath(pathname: string): boolean {
  // Only guard reports that AGGREGATE across currencies and need base-USD amounts
  // for correct cross-currency totals.  Per-account statement PDFs/Excels only
  // display a single account's own debit/credit amounts — they never reference
  // base_debit_amount — so the backfill readiness check is irrelevant for them.
  return (
    pathname === "/api/stats/net-profit" ||
    pathname.startsWith("/api/stats/net-position") ||
    pathname.startsWith("/api/reports/net-position") ||
    pathname.startsWith("/api/reports/net-profit")
  );
}

export const guardUnresolvedHistoricalCurrency: RequestHandler = async (req, res, next) => {
  if (req.method !== "GET" || !isGuardedFinancialPath(req.path)) return next();
  const companyId = req.session.currentCompanyId;
  if (!companyId) return next();

  try {
    const asOfDate = typeof req.query.toDate === "string"
      ? req.query.toDate
      : typeof req.query.endDate === "string"
        ? req.query.endDate
        : null;
    const readiness = await getHistoricalCurrencyReadiness(companyId, asOfDate);
    if (readiness.ready) return next();

    return res.status(409).json({
      code: "HISTORICAL_CURRENCY_DATA_UNRESOLVED",
      message:
        "This financial report is blocked because legacy foreign-currency entries or opening balances are unresolved. " +
        "Run the multi-currency backfill in dry-run mode, review ambiguous rows, then apply only approved repairs.",
      readiness,
      backfillWasRun: false,
    });
  } catch (error: unknown) {
    logger.error("Historical currency readiness check failed:", { error: error });
    return res.status(500).json({
      code: "HISTORICAL_CURRENCY_READINESS_FAILED",
      message: getErrorMessage(error),
    });
  }
};

export function registerHistoricalCurrencyGuardRoutes(app: Express) {
  app.use(guardUnresolvedHistoricalCurrency);

  app.get(
    "/api/accounts/multi-currency/readiness",
    requireAuth,
    requireNonPOS,
    async (req, res) => {
      try {
        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const asOfDate = typeof req.query.toDate === "string" ? req.query.toDate : null;
        return res.json(await getHistoricalCurrencyReadiness(companyId, asOfDate));
      } catch (error: unknown) {
        return res.status(500).json({ message: getErrorMessage(error) });
      }
    },
  );
}
