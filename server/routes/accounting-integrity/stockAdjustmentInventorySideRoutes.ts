/**
 * One-sided stock adjustment vouchers, as a reviewed Owner tool (merge of main
 * 365cf55: replaces main's boot backfill, see
 * services/accounting/stockAdjustmentInventorySide.ts).
 *
 *   GET  /api/accounting/stock-adjustment-inventory-side/plan    Owner, read-only plan
 *   POST /api/accounting/stock-adjustment-inventory-side/apply   Owner, { confirm: true, planHash }
 */
import type { Express, Request, Response } from "express";

import { requireAuth, requireRole } from "../../auth";
import { closedPeriodErrorResponse } from "../../lib/closedPeriodError";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import {
  StockAdjustmentInventoryRefusal,
  applyStockAdjustmentInventorySide,
  planStockAdjustmentInventorySide,
} from "../../services/accounting/stockAdjustmentInventorySide";

const PLAN_HASH = /^[0-9a-f]{64}$/;
const PLAN_ROUTE = "/api/accounting/stock-adjustment-inventory-side/plan";
const APPLY_ROUTE = "/api/accounting/stock-adjustment-inventory-side/apply";

export function registerStockAdjustmentInventorySideRoutes(app: Express) {
  app.get(PLAN_ROUTE, requireAuth, requireRole("Owner"), async (req: Request, res: Response) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      res.json(await planStockAdjustmentInventorySide(companyId));
    } catch (error: unknown) {
      logger.error("Error previewing the stock adjustment Inventory side:", { error });
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
      const plan = await applyStockAdjustmentInventorySide(companyId, {
        planHash,
        actor: {
          userId: String(req.session.userId ?? ""),
          username: req.session.username || String(req.session.userId ?? "unknown"),
        },
      });
      res.json({ applied: true, plan });
    } catch (error: unknown) {
      if (error instanceof StockAdjustmentInventoryRefusal) {
        const status = error.code === "NOTHING_TO_APPLY" ? 400 : 409;
        return res.status(status).json({ code: error.code, message: error.message });
      }
      const closed = closedPeriodErrorResponse(error);
      if (closed) return res.status(closed.status).json(closed.body);
      logger.error("Error applying the stock adjustment Inventory side:", { error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
