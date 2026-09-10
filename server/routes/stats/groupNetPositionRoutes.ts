import type { Express, Request, Response } from "express";
import { requireAuth, requireNonPOS, requireRole } from "../../auth";
import { getClientDate } from "../../lib/dateUtils";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { getAccessibleCompanyIds } from "../../security/companyAccessBoundary";
import {
  calculateGroupNetPosition,
  GroupHistoricalCurrencyError,
} from "../../helpers/groupNetPosition";
import { generateGroupNetPositionExcel } from "../../helpers/generateGroupNetPositionExcel";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function resolveAsOfDate(req: Request): string {
  const value = req.query.toDate ? String(req.query.toDate) : getClientDate(req);
  if (!isValidIsoDate(value)) throw new Error("Invalid toDate. Expected YYYY-MM-DD.");
  return value;
}

async function resolveAllowedCompanyIds(req: Request): Promise<ReadonlySet<number>> {
  const userId = String(req.session?.userId ?? req.user?.id ?? "").trim();
  if (!userId) throw new Error("Authenticated user context is unavailable");
  return getAccessibleCompanyIds(userId);
}

function sendGroupError(res: Response, error: unknown, exportRequest = false) {
  const message = getErrorMessage(error);
  if (message.startsWith("Invalid toDate")) return res.status(400).json({ message });

  if (error instanceof GroupHistoricalCurrencyError) {
    return res.status(409).json({
      code: "HISTORICAL_CURRENCY_DATA_UNRESOLVED",
      message:
        `This Group Net Position report is blocked because ${error.companyName} has unresolved legacy foreign-currency data. ` +
        "Run the multi-currency backfill in dry-run mode, review ambiguous rows, then apply only approved repairs.",
      companyId: error.companyId,
      companyName: error.companyName,
      readiness: error.readiness,
      backfillWasRun: false,
    });
  }

  logger.error(exportRequest ? "Group Net Position Excel failed" : "Group Net Position calculation failed", {
    error: message,
  });
  return res.status(500).json({
    message: exportRequest ? "Failed to export Group Net Position" : "Failed to calculate Group Net Position",
  });
}

export function registerGroupNetPositionRoutes(app: Express) {
  const guards = [requireAuth, requireNonPOS, requireRole("Admin")];

  app.get("/api/stats/group-net-position", ...guards, async (req, res) => {
    try {
      const asOfDate = resolveAsOfDate(req);
      const allowedCompanyIds = await resolveAllowedCompanyIds(req);
      // When the requested date is the user's current date, use the same live ERP
      // snapshot as the normal Net Position page so cash/bank current translation
      // and every ERP presentation rule reconcile exactly. Older dates stay historical.
      const useCurrentSnapshot = asOfDate === getClientDate(req);
      const snapshot = await calculateGroupNetPosition(asOfDate, allowedCompanyIds, useCurrentSnapshot);
      res.setHeader("Cache-Control", "no-store");
      return res.json(snapshot);
    } catch (error: unknown) {
      return sendGroupError(res, error);
    }
  });

  app.get("/api/stats/group-net-position-excel", ...guards, async (req, res) => {
    try {
      const asOfDate = resolveAsOfDate(req);
      const allowedCompanyIds = await resolveAllowedCompanyIds(req);
      const useCurrentSnapshot = asOfDate === getClientDate(req);
      const snapshot = await calculateGroupNetPosition(asOfDate, allowedCompanyIds, useCurrentSnapshot);
      const workbook = await generateGroupNetPositionExcel(snapshot);
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="group-net-position-${asOfDate}.xlsx"`);
      res.setHeader("Cache-Control", "no-store");
      return res.send(workbook);
    } catch (error: unknown) {
      return sendGroupError(res, error, true);
    }
  });
}
