/**
 * adminRepairRoutes: AdminEquityRepair endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 *
 * These routes used to store system_settings.equity_adjustment_<companyId> =
 * -rawBalance so that the import cycle balance read 0. That is a balancing plug:
 * it hides a real ledger/sub-ledger difference instead of explaining it (2026-10
 * accounting audit). They now report the raw difference and write nothing; a
 * difference is corrected only by a reviewed, posted entry.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { storage } from "../../../storage";
import { requireAuth, requireRole } from "../../../auth";
import { computeRawBalance } from "../userManagementRoutes";

const PLUG_DISABLED_MESSAGE =
  "Equity adjustments are no longer written. The difference is reported as it is; investigate it and post a correcting entry.";

export function registerAdminEquityRepairRoutes(app: Express) {
  app.post("/api/admin/recalculate-equity-adjustment", requireAuth, requireRole("Admin"), async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const rawBalance = await computeRawBalance(companyId);
      res.json({
        success: true,
        message: PLUG_DISABLED_MESSAGE,
        written: false,
        unreconciledDifference: rawBalance.toFixed(2),
      });
    } catch (error: unknown) {
      logger.error("Recalculate equity adjustment error:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/admin/recalculate-equity-adjustment-all", requireAuth, requireRole("Admin"), async (req, res) => {
    try {
      const allCompanies = await storage.getAllCompanies();
      const results: Array<{ companyId: number; companyName: string; rawBalance: number; balanced: boolean }> = [];
      for (const company of allCompanies) {
        const rawBalance = await computeRawBalance(company.id);
        results.push({
          companyId: company.id,
          companyName: company.name,
          rawBalance,
          balanced: Math.abs(rawBalance) <= 0.01,
        });
      }

      res.json({
        success: true,
        message: PLUG_DISABLED_MESSAGE,
        written: false,
        results,
      });
    } catch (error: unknown) {
      logger.error("Recalculate equity adjustment all error:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
