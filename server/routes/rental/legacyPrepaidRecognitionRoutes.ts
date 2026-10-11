/**
 * Legacy fully prepaid shop rent recognition, as a reviewed tool (accounting
 * audit wave 18 A, owner decision 2 of 2026-10-10).
 *
 *   GET  {prefix}/admin/legacy-prepaid-recognition/plan    Owner, read-only plan
 *   POST {prefix}/admin/legacy-prepaid-recognition/apply   Owner, { confirm: true, planHash }
 *
 * Mounted for the ERP and factory rentals. It used to run in the daily rental
 * job (maintenance scope, no audit, no closure check). The paths carry no
 * maintenance keyword, so the Owner is admitted (privilegedMaintenanceRoutePolicy
 * admits only Admin and Developer to "repair" paths).
 */
import type { Express, Request, Response } from "express";

import { requireAuth, requireRole } from "../../auth";
import { closedPeriodErrorResponse } from "../../lib/closedPeriodError";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import {
  LegacyPrepaidRefusal,
  applyLegacyPrepaidRecognition,
  planLegacyPrepaidRecognition,
} from "../../services/rental/legacyPrepaidRecognitionRepair";
import { resolveRequestCompanyId } from "../../services/security/requestCompanyScope";
import type { RentalModule } from "./shared";

const PLAN_HASH = /^[0-9a-f]{64}$/;

export function registerLegacyPrepaidRecognitionRoutes(
  app: Express,
  module: RentalModule,
  urlPrefix: string,
  shopExpenseAccountName: string
): void {
  const planRoute = `${urlPrefix}/admin/legacy-prepaid-recognition/plan`;
  const applyRoute = `${urlPrefix}/admin/legacy-prepaid-recognition/apply`;

  app.get(planRoute, requireAuth, requireRole("Owner"), async (req: Request, res: Response) => {
    try {
      const companyId = resolveRequestCompanyId(req);
      res.json(await planLegacyPrepaidRecognition(companyId, module, shopExpenseAccountName));
    } catch (error: unknown) {
      logger.error(`GET ${planRoute} error`, { error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post(applyRoute, requireAuth, requireRole("Owner"), async (req: Request, res: Response) => {
    try {
      const companyId = resolveRequestCompanyId(req);
      if (req.body?.confirm !== true) return res.status(400).json({ message: "Confirmation is required" });
      const planHash = req.body?.planHash;
      if (typeof planHash !== "string" || !PLAN_HASH.test(planHash)) {
        return res.status(400).json({ message: "The reviewed plan hash is required" });
      }
      const result = await applyLegacyPrepaidRecognition(companyId, module, shopExpenseAccountName, {
        planHash,
        actor: {
          userId: String(req.session.userId ?? ""),
          username: req.session.username || String(req.session.userId ?? "unknown"),
        },
      });
      res.json({ applied: true, ...result });
    } catch (error: unknown) {
      if (error instanceof LegacyPrepaidRefusal) {
        return res.status(error.status).json({ code: error.code, message: error.message });
      }
      const closed = closedPeriodErrorResponse(error);
      if (closed) return res.status(closed.status).json(closed.body);
      logger.error(`POST ${applyRoute} error`, { error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
