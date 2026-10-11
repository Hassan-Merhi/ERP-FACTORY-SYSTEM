/**
 * The reviewed re-cost of unsold bales and open mixes (accounting audit wave
 * 11): preview → Owner confirm → apply. See services/factory/baleRecost.ts.
 */
import type { Express, Request, Response } from "express";

import { requireAuth, requireRole } from "../../../auth";
import { closedPeriodErrorResponse } from "../../../lib/closedPeriodError";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { applyBaleRecost, BaleRecostRefusal, planBaleRecost } from "../../../services/factory/baleRecost";

const companyOf = (req: Request) => req.session.factoryCompanyId || req.session.currentCompanyId;

export function registerBaleRecostRoutes(app: Express) {
  // The plan: per mix and per bale the old and new USD cost, unvalued rows, totals and its hash.
  app.get(
    "/api/factory/bale-cost/recost-preview",
    requireAuth,
    requireRole("Admin", "Owner"),
    async (req: Request, res: Response) => {
      try {
        const companyId = companyOf(req);
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        res.json(await planBaleRecost(companyId));
      } catch (error: unknown) {
        logger.error("Error previewing the bale re-cost:", { error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  // Applies the reviewed plan: Owner only, with { confirm: true, planHash }.
  app.post(
    "/api/factory/bale-cost/recost-apply",
    requireAuth,
    requireRole("Owner"),
    async (req: Request, res: Response) => {
      try {
        const companyId = companyOf(req);
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        if (req.body?.confirm !== true) return res.status(400).json({ message: "Confirmation is required" });
        const planHash = req.body?.planHash;
        if (typeof planHash !== "string" || !/^[0-9a-f]{64}$/.test(planHash)) {
          return res.status(400).json({ message: "The reviewed plan hash is required" });
        }
        const result = await applyBaleRecost(companyId, {
          planHash,
          actor: {
            userId: String(req.session.userId ?? ""),
            username: req.session.username || String(req.session.userId ?? "unknown"),
          },
        });
        res.json(result);
      } catch (error: unknown) {
        if (error instanceof BaleRecostRefusal) {
          return res.status(409).json({ code: error.code, message: error.message });
        }
        const closed = closedPeriodErrorResponse(error);
        if (closed) return res.status(closed.status).json(closed.body);
        logger.error("Error applying the bale re-cost:", { error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}
