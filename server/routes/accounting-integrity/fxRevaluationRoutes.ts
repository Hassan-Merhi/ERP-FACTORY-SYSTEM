/**
 * Phase 24 (M7): month-end revaluation of foreign-currency monetary balances,
 * a reviewed Owner tool (services/accounting/fx/monthEndRevaluation.ts).
 *
 *   GET  /api/accounting/fx-revaluation/preview?monthEnd=YYYY-MM-DD   Owner, read-only plan
 *   POST /api/accounting/fx-revaluation/apply                          Owner, { monthEnd, planHash, confirm: true }
 *
 * Also plugs realized FX (M6) into the phase 25 allocation events once, and
 * (integration review) the reviewed realized FX of allocations the listener
 * does not post automatically (services/accounting/fx/realizedFxHistory.ts):
 *
 *   GET  /api/accounting/realized-fx/history/plan    Admin/Owner, read-only plan
 *   POST /api/accounting/realized-fx/history/apply   Owner, { planHash, confirm: true }
 */
import type { Express, Request, Response } from "express";

import { requireAuth, requireRole } from "../../auth";
import { closedPeriodErrorResponse } from "../../lib/closedPeriodError";
import { errorStatus, getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import {
  FxRevaluationRefusal,
  applyFxRevaluation,
  previewFxRevaluation,
} from "../../services/accounting/fx/monthEndRevaluation";
import { registerRealizedFxListener } from "../../services/accounting/fx/realizedFx";
import {
  RealizedFxHistoryRefusal,
  applyRealizedFxHistory,
  previewRealizedFxHistory,
} from "../../services/accounting/fx/realizedFxHistory";
import { VoucherCorrectionError } from "../../services/accounting/voucherCorrection";

const PLAN_HASH = /^[0-9a-f]{64}$/;
const PREVIEW_ROUTE = "/api/accounting/fx-revaluation/preview";
const APPLY_ROUTE = "/api/accounting/fx-revaluation/apply";
const REALIZED_HISTORY_PLAN_ROUTE = "/api/accounting/realized-fx/history/plan";
const REALIZED_HISTORY_APPLY_ROUTE = "/api/accounting/realized-fx/history/apply";

function sendRefusal(res: Response, error: unknown): boolean {
  if (error instanceof FxRevaluationRefusal) {
    res.status(error.status).json(error.body);
    return true;
  }
  if (error instanceof RealizedFxHistoryRefusal) {
    res.status(error.statusCode).json(error.body);
    return true;
  }
  if (error instanceof VoucherCorrectionError) {
    res.status(error.statusCode).json(error.body());
    return true;
  }
  const closed = closedPeriodErrorResponse(error);
  if (closed) {
    res.status(closed.status).json(closed.body);
    return true;
  }
  return false;
}

export function registerFxRevaluationRoutes(app: Express) {
  registerRealizedFxListener();

  app.get(PREVIEW_ROUTE, requireAuth, requireRole("Owner"), async (req: Request, res: Response) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const monthEnd = typeof req.query.monthEnd === "string" ? req.query.monthEnd : "";
      res.json(await previewFxRevaluation(companyId, monthEnd));
    } catch (error: unknown) {
      if (sendRefusal(res, error)) return;
      logger.error("Error previewing the month-end FX revaluation:", { error });
      res.status(errorStatus(error)).json({ message: getErrorMessage(error) });
    }
  });

  app.post(APPLY_ROUTE, requireAuth, requireRole("Owner"), async (req: Request, res: Response) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      if (req.body?.confirm !== true) return res.status(400).json({ message: "Confirmation is required" });
      const planHash = req.body?.planHash;
      if (typeof planHash !== "string" || !PLAN_HASH.test(planHash)) {
        return res
          .status(400)
          .json({ code: "FX_REVALUATION_PLAN_HASH_REQUIRED", message: "The reviewed plan hash is required." });
      }
      const monthEnd = typeof req.body?.monthEnd === "string" ? req.body.monthEnd : "";
      const result = await applyFxRevaluation(companyId, {
        monthEnd,
        planHash,
        actor: {
          userId: String(req.session.userId ?? ""),
          username: req.session.username || String(req.session.userId ?? "unknown"),
        },
      });
      res.json({ applied: true, ...result });
    } catch (error: unknown) {
      if (sendRefusal(res, error)) return;
      logger.error("Error applying the month-end FX revaluation:", { error });
      res.status(errorStatus(error)).json({ message: getErrorMessage(error) });
    }
  });

  app.get(
    REALIZED_HISTORY_PLAN_ROUTE,
    requireAuth,
    requireRole("Admin", "Owner"),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        res.json(await previewRealizedFxHistory(companyId));
      } catch (error: unknown) {
        if (sendRefusal(res, error)) return;
        logger.error("Error previewing the realized exchange differences:", { error });
        res.status(errorStatus(error)).json({ message: getErrorMessage(error) });
      }
    }
  );

  app.post(REALIZED_HISTORY_APPLY_ROUTE, requireAuth, requireRole("Owner"), async (req: Request, res: Response) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      if (req.body?.confirm !== true) return res.status(400).json({ message: "Confirmation is required" });
      const planHash = req.body?.planHash;
      if (typeof planHash !== "string" || !PLAN_HASH.test(planHash)) {
        return res
          .status(400)
          .json({ code: "REALIZED_FX_HISTORY_PLAN_HASH_REQUIRED", message: "The reviewed plan hash is required." });
      }
      const result = await applyRealizedFxHistory(companyId, {
        planHash,
        actor: {
          userId: String(req.session.userId ?? ""),
          username: req.session.username || String(req.session.userId ?? "unknown"),
        },
      });
      res.json({ applied: true, ...result });
    } catch (error: unknown) {
      if (sendRefusal(res, error)) return;
      logger.error("Error applying the realized exchange differences:", { error });
      res.status(errorStatus(error)).json({ message: getErrorMessage(error) });
    }
  });
}
