/**
 * Supplier Partner Goods-OTW supplier link repair (accounting audit wave 16 A).
 *
 *   GET  /api/sp/admin/supplier-voucher-links/plan    Owner, read-only plan
 *   POST /api/sp/admin/supplier-voucher-links/apply   Owner, { confirm: true, planHash }
 *
 * The repair used to run at every boot, across every company in maintenance
 * scope, with no audit. It is now this reviewed tool: the preview lists each
 * voucher and line whose supplier would change (with its amounts) and a plan
 * hash; the apply runs for the current company only, in one transaction, skips
 * vouchers in a closed period (by voucher and effective date) and writes its
 * audit row in that transaction (spSupplierVoucherSync.ts).
 */
import type { Express, Request, Response } from "express";

import { requireAuth, requireRole } from "../../auth";
import { closedPeriodErrorResponse } from "../../lib/closedPeriodError";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import {
  SpSupplierLinkRepairRefusal,
  applySpSupplierVoucherLinkRepair,
  planSpSupplierVoucherLinkRepair,
} from "./spSupplierVoucherSync";

const PLAN_HASH = /^[0-9a-f]{64}$/;
const PLAN_ROUTE = "/api/sp/admin/supplier-voucher-links/plan";
const APPLY_ROUTE = "/api/sp/admin/supplier-voucher-links/apply";

export function registerSpSupplierVoucherLinkRepairRoutes(app: Express) {
  app.get(PLAN_ROUTE, requireAuth, requireRole("Owner"), async (req: Request, res: Response) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      res.json(await planSpSupplierVoucherLinkRepair(companyId));
    } catch (error: unknown) {
      logger.error("Error previewing the SP supplier voucher link repair:", { error });
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
      const result = await applySpSupplierVoucherLinkRepair(companyId, {
        planHash,
        actor: {
          userId: String(req.session.userId ?? ""),
          username: req.session.username || String(req.session.userId ?? "unknown"),
        },
      });
      res.json(result);
    } catch (error: unknown) {
      if (error instanceof SpSupplierLinkRepairRefusal) {
        return res.status(409).json({ code: error.code, message: error.message });
      }
      const closed = closedPeriodErrorResponse(error);
      if (closed) return res.status(closed.status).json(closed.body);
      logger.error("Error applying the SP supplier voucher link repair:", { error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
