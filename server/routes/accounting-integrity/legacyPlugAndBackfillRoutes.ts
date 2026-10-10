/**
 * Phase 20 Owner tools (accounting audit, production items A2 and B2):
 *
 *   GET  /api/accounting/legacy-equity-plug/plan                         Owner/Admin, read-only plan
 *   POST /api/accounting/legacy-equity-plug/apply                        Owner, { confirm: true, planHash }
 *   GET  /api/accounting/stock-adjustment-inventory-mirror-reversal/plan Owner/Admin, read-only plan
 *        ?offset=OPENING_BALANCE_EQUITY|INVENTORY_ADJUSTMENT&allowNonSupplierPartner=true&reason=…
 *   POST /api/accounting/stock-adjustment-inventory-mirror-reversal/apply
 *        Owner, { confirm: true, planHash, offset?, allowNonSupplierPartner?, reason? }
 *
 * The services hold the rules (services/accounting/legacyEquityPlug.ts and
 * stockAdjustmentBackfillReversal.ts). The reversal path does not name the
 * backfill: "backfill" is a maintenance keyword that admits only Admin and
 * Developer (privilegedMaintenanceRoutePolicy), and this is an Owner tool.
 * Both act on the session's current company only.
 */
import type { Express, Request, Response } from "express";

import { requireAuth, requireRole } from "../../auth";
import { closedPeriodErrorResponse } from "../../lib/closedPeriodError";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { toMoney } from "../../lib/money";
import {
  LegacyEquityPlugRefusal,
  applyLegacyEquityPlugClear,
  planLegacyEquityPlugClear,
} from "../../services/accounting/legacyEquityPlug";
import {
  BACKFILL_REVERSAL_OFFSET_CODES,
  BackfillReversalRefusal,
  applyStockAdjustmentBackfillReversal,
  planStockAdjustmentBackfillReversal,
  type BackfillReversalOptions,
} from "../../services/accounting/stockAdjustmentBackfillReversal";
import { resolveRequestCompanyId } from "../../services/security/requestCompanyScope";
import { computeRawBalance } from "../admin/userManagementRoutes";

const PLAN_HASH = /^[0-9a-f]{64}$/;
const PLUG_PLAN = "/api/accounting/legacy-equity-plug/plan";
const PLUG_APPLY = "/api/accounting/legacy-equity-plug/apply";
const MIRROR_PLAN = "/api/accounting/stock-adjustment-inventory-mirror-reversal/plan";
const MIRROR_APPLY = "/api/accounting/stock-adjustment-inventory-mirror-reversal/apply";

const actorOf = (req: Request) => ({
  userId: String(req.session.userId ?? ""),
  username: req.session.username || String(req.session.userId ?? "unknown"),
});

/** The raw import-cycle difference the plug hid (the figure POST /api/admin/recalculate-equity-adjustment reports). */
async function liveDifference(companyId: number): Promise<string> {
  return toMoney(await computeRawBalance(companyId)).toFixed(2);
}

function reversalOptions(source: Record<string, unknown> | undefined): BackfillReversalOptions | string {
  const offset = source?.offset;
  if (offset !== undefined && !BACKFILL_REVERSAL_OFFSET_CODES.includes(offset as never)) {
    return "offset must be OPENING_BALANCE_EQUITY or INVENTORY_ADJUSTMENT";
  }
  const allow = source?.allowNonSupplierPartner;
  const reason = source?.reason;
  return {
    offset: offset as BackfillReversalOptions["offset"],
    allowNonSupplierPartner: allow === true || allow === "true",
    reason: typeof reason === "string" ? reason : null,
  };
}

function reviewedHash(req: Request, res: Response): string | null {
  if (req.body?.confirm !== true) {
    res.status(400).json({ message: "Confirmation is required" });
    return null;
  }
  const planHash = req.body?.planHash;
  if (typeof planHash !== "string" || !PLAN_HASH.test(planHash)) {
    res.status(400).json({ message: "The reviewed plan hash is required" });
    return null;
  }
  return planHash;
}

export function registerLegacyPlugAndBackfillRoutes(app: Express): void {
  app.get(PLUG_PLAN, requireAuth, requireRole("Owner", "Admin"), async (req: Request, res: Response) => {
    try {
      const companyId = resolveRequestCompanyId(req);
      const [plan, liveImportCycleDifference] = await Promise.all([
        planLegacyEquityPlugClear(companyId),
        liveDifference(companyId),
      ]);
      res.json({ ...plan, liveImportCycleDifference });
    } catch (error: unknown) {
      logger.error(`GET ${PLUG_PLAN} error`, { error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post(PLUG_APPLY, requireAuth, requireRole("Owner"), async (req: Request, res: Response) => {
    try {
      const companyId = resolveRequestCompanyId(req);
      const planHash = reviewedHash(req, res);
      if (!planHash) return;
      const plan = await applyLegacyEquityPlugClear(companyId, {
        planHash,
        liveImportCycleDifference: await liveDifference(companyId),
        actor: actorOf(req),
      });
      res.json({ applied: true, plan });
    } catch (error: unknown) {
      if (error instanceof LegacyEquityPlugRefusal) {
        return res.status(error.status).json({ code: error.code, message: error.message });
      }
      logger.error(`POST ${PLUG_APPLY} error`, { error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get(MIRROR_PLAN, requireAuth, requireRole("Owner", "Admin"), async (req: Request, res: Response) => {
    try {
      const companyId = resolveRequestCompanyId(req);
      const options = reversalOptions(req.query as Record<string, unknown>);
      if (typeof options === "string") return res.status(400).json({ message: options });
      res.json(await planStockAdjustmentBackfillReversal(companyId, options));
    } catch (error: unknown) {
      logger.error(`GET ${MIRROR_PLAN} error`, { error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post(MIRROR_APPLY, requireAuth, requireRole("Owner"), async (req: Request, res: Response) => {
    try {
      const companyId = resolveRequestCompanyId(req);
      const planHash = reviewedHash(req, res);
      if (!planHash) return;
      const options = reversalOptions(req.body);
      if (typeof options === "string") return res.status(400).json({ message: options });
      const result = await applyStockAdjustmentBackfillReversal(companyId, {
        ...options,
        planHash,
        actor: actorOf(req),
      });
      res.json({ applied: true, ...result });
    } catch (error: unknown) {
      if (error instanceof BackfillReversalRefusal) {
        return res.status(error.status).json({ code: error.code, message: error.message });
      }
      const closed = closedPeriodErrorResponse(error);
      if (closed) return res.status(closed.status).json(closed.body);
      logger.error(`POST ${MIRROR_APPLY} error`, { error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
