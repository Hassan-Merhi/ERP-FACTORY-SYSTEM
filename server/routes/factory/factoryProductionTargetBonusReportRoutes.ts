import type { Express, Request, Response } from "express";
import { requireAuth } from "../../auth";
import { checkFactoryAdmin } from "./_helpers";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import {
  buildProductionTargetBonusReport,
  isBonusReportDate,
  type ProductionTargetBonusHistoryRow,
} from "@shared/productionTargetBonusReporting";

/**
 * Read-only reporting adapter. Phase 5/6 must supply an authoritative company-
 * scoped loader from its awards + POSTED Deposit Expense voucher tables.
 * This module never infers payment from approvals or creates accounting entries.
 */
export interface ProductionBonusHistoryLoadQuery {
  companyId: number;
  start: string;
  end: string;
  workerId: number | null;
}
export type ProductionBonusHistoryLoader =
  (query: ProductionBonusHistoryLoadQuery) => Promise<ProductionTargetBonusHistoryRow[]>;

export function registerFactoryProductionTargetBonusReportRoutes(
  app: Express,
  loadHistory: ProductionBonusHistoryLoader,
): void {
  app.get("/api/factory/production-target-bonuses/report", requireAuth,
    async (req: Request, res: Response) => {
      try {
        if (!checkFactoryAdmin(req, res)) return;
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No factory company selected" });
        const start = String(req.query.start ?? "");
        const end = String(req.query.end ?? "");
        if (!isBonusReportDate(start) || !isBonusReportDate(end) || start > end) {
          return res.status(400).json({ message: "Select a valid production date range" });
        }
        // Avoid unbounded reads/exports, but allow a full year of history.
        const days = (Date.parse(end + "T12:00:00Z") - Date.parse(start + "T12:00:00Z")) / 86400000 + 1;
        if (days > 366) {
          return res.status(400).json({ message: "Select up to 366 production days" });
        }
        const rawWorkerId = req.query.workerId;
        const workerId = rawWorkerId == null || rawWorkerId === "" ? null : Number(rawWorkerId);
        if (workerId !== null && (!Number.isSafeInteger(workerId) || workerId <= 0)) {
          return res.status(400).json({ message: "Invalid worker ID" });
        }

        const rows = await loadHistory({ companyId: Number(companyId), start, end, workerId });
        if (rows.length > 50000) {
          return res.status(413).json({ message: "Too many awards; narrow the date range" });
        }
        // Defense-in-depth: disallow a source adapter silently dropping the
        // requested worker scope. The adapter itself must query by company.
        if (workerId !== null && rows.some(row => row.workerId !== workerId)) {
          throw new Error("Bonus report source returned an unexpected worker");
        }
        const report = buildProductionTargetBonusReport(start, end, rows);
        res.setHeader("Cache-Control", "private, no-store");
        return res.json(report);
      } catch (error: unknown) {
        logger.error("Error loading production target bonus report", { error });
        return res.status(500).json({ message: getErrorMessage(error) });
      }
    },
  );
}
