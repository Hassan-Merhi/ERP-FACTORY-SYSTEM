import { loadNetPositionFxActivity } from "../../../services/accounting/netPositionFxActivity";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import type { Express, Request, Response } from "express";
import { requireAuth } from "../../../auth";

import { registerEmployeeNetPositionRoutesPart1 } from "./registerEmployeeNetPositionRoutesPart1";

export function registerEmployeeNetPositionRoutes(app: Express) {
  // The Net Position evidence drill-down shares the parent page's Factory
  // permission boundary. It reads vouchers and rate changes but creates none.
  app.get("/api/factory/net-position/fx-activity", requireAuth, async (req: Request, res: Response) => {
    const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
    if (!companyId) return res.status(400).json({ message: "No company selected" });
    res.setHeader("Cache-Control", "private, no-store");
    try {
      return res.json(
        await loadNetPositionFxActivity({
          companyId,
          factory: true,
          from: req.query.from,
          to: req.query.to,
        })
      );
    } catch (error) {
      if (error instanceof Error && /Invalid history date|History start date/.test(error.message)) {
        return res.status(400).json({ message: error.message });
      }
      logger.error("Factory FX evidence history failed", { companyId, error });
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  registerEmployeeNetPositionRoutesPart1(app);

  // ─── Payroll Payable Breakdown (view-only, for Net Position page) ────────────
  // GET /api/factory/net-position/payroll-breakdown
  // Returns one row per active employee whose currentBalance > 0.
  // This endpoint is purely informational and does NOT affect any Net Position
  // calculation, account, or balance — it is read-only.
}
