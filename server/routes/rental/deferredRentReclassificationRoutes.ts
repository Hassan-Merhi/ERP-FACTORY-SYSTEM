/**
 * Properties Deferred Rent Revenue reclassification, as a reviewed tool
 * (accounting audit wave 16 A, owner decision of 2026-10-09).
 *
 *   GET  /api/properties/rental/admin/deferred-rent-reclassification/plan    Owner, read-only plan
 *   POST /api/properties/rental/admin/deferred-rent-reclassification/apply   Owner, { confirm: true, planHash }
 *
 * It used to run at route registration (every boot, every Properties company,
 * maintenance scope) and on every PROPERTIES request. The paths carry no
 * maintenance keyword, so the Owner is admitted (privilegedMaintenanceRoutePolicy
 * admits only Admin and Developer to "repair" paths).
 */
import type { Express, Request, Response } from "express";

import { requireAuth, requireRole } from "../../auth";
import { closedPeriodErrorResponse } from "../../lib/closedPeriodError";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import {
  DeferredRentReclassRefusal,
  applyDeferredRentReclassification,
  planDeferredRentReclassification,
} from "../../services/rental/deferredRentReclassification";
import { resolveRequestCompanyId } from "../../services/security/requestCompanyScope";

const PLAN_HASH = /^[0-9a-f]{64}$/;

export function registerDeferredRentReclassificationRoutes(app: Express, urlPrefix: string): void {
  const planRoute = `${urlPrefix}/admin/deferred-rent-reclassification/plan`;
  const applyRoute = `${urlPrefix}/admin/deferred-rent-reclassification/apply`;

  app.get(planRoute, requireAuth, requireRole("Owner"), async (req: Request, res: Response) => {
    try {
      const companyId = resolveRequestCompanyId(req);
      res.json(await planDeferredRentReclassification(companyId));
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
      const result = await applyDeferredRentReclassification(companyId, {
        planHash,
        actor: {
          userId: String(req.session.userId ?? ""),
          username: req.session.username || String(req.session.userId ?? "unknown"),
        },
      });
      res.json({ applied: true, ...result });
    } catch (error: unknown) {
      if (error instanceof DeferredRentReclassRefusal) {
        return res.status(error.status).json({ code: error.code, message: error.message });
      }
      const closed = closedPeriodErrorResponse(error);
      if (closed) return res.status(closed.status).json(closed.body);
      logger.error(`POST ${applyRoute} error`, { error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
