/**
 * Phase 3 historical accounting repair, as a reviewed tool (accounting audit wave 16 A).
 *
 *   GET  /api/accounting/phase3-historical/plan    Owner, read-only plan
 *   POST /api/accounting/phase3-historical/apply   Owner, { confirm: true, planHash }
 *
 * It used to run before every listen for every company (see
 * services/accounting/phase3HistoricalRepair.ts).
 */
import type { Express, Request, Response } from "express";

import { requireAuth, requireRole } from "../../auth";
import { closedPeriodErrorResponse } from "../../lib/closedPeriodError";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import {
  Phase3RepairRefusal,
  applyPhase3HistoricalRepair,
  planPhase3HistoricalRepair,
} from "../../services/accounting/phase3HistoricalRepair";

const PLAN_HASH = /^[0-9a-f]{64}$/;
const PLAN_ROUTE = "/api/accounting/phase3-historical/plan";
const APPLY_ROUTE = "/api/accounting/phase3-historical/apply";

export function registerPhase3HistoricalRepairRoutes(app: Express) {
  app.get(PLAN_ROUTE, requireAuth, requireRole("Owner"), async (req: Request, res: Response) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      res.json(await planPhase3HistoricalRepair(companyId));
    } catch (error: unknown) {
      if (error instanceof Phase3RepairRefusal)
        return res.status(409).json({ code: error.code, message: error.message });
      logger.error("Error previewing the Phase 3 historical repair:", { error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post(APPLY_ROUTE, requireAuth, requireRole("Owner"), async (req: Request, res: Response) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      if (req.body?.confirm !== true) return res.status(400).json({ message: "Confirmation is required" });
      const planHash = req.body?.planHash;
      if (typeof planHash !== "string" || !PLAN_HASH.test(planHash)) {
        return res.status(400).json({ message: "The reviewed plan hash is required" });
      }
      const plan = await applyPhase3HistoricalRepair(companyId, {
        planHash,
        actor: {
          userId: String(req.session.userId ?? ""),
          username: req.session.username || String(req.session.userId ?? "unknown"),
        },
      });
      res.json({ applied: true, plan });
    } catch (error: unknown) {
      if (error instanceof Phase3RepairRefusal) {
        const status = error.code === "NOTHING_TO_APPLY" ? 400 : 409;
        return res.status(status).json({ code: error.code, message: error.message });
      }
      const closed = closedPeriodErrorResponse(error);
      if (closed) return res.status(closed.status).json(closed.body);
      logger.error("Error applying the Phase 3 historical repair:", { error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
