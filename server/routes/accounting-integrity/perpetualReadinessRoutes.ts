/**
 * Perpetual-inventory readiness routes (accounting audit wave 15).
 *
 *   GET  /api/accounting/perpetual-inventory/readiness             read-only checklist and blockers
 *   GET  /api/accounting/perpetual-inventory/readiness-resolution  read-only plan for orphaned and anomalous stock
 *   POST /api/accounting/perpetual-inventory/readiness-resolution/apply
 *        Owner, { confirm: true, planHash, actions: [{ locationId, action: "restore" | "writeOff" }],
 *        writeOffAnomalies }
 *
 * See services/accounting/perpetualInventory/readiness.ts and
 * services/inventory/inventoryReadinessResolution.ts.
 */
import type { Express, Request, Response } from "express";

import { requireAuth, requireRole } from "../../auth";
import { closedPeriodErrorResponse } from "../../lib/closedPeriodError";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { perpetualReadinessReport } from "../../services/accounting/perpetualInventory/readiness";
import {
  ReadinessResolutionRefusal,
  applyReadinessResolution,
  planReadinessResolution,
  type ReadinessAction,
} from "../../services/inventory/inventoryReadinessResolution";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const PLAN_HASH = /^[0-9a-f]{64}$/;

/** The body's actions, or null when they are not a list of { locationId, action }. */
function parseActions(value: unknown): ReadinessAction[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const actions: ReadinessAction[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return null;
    const { locationId, action } = entry as { locationId?: unknown; action?: unknown };
    if (typeof locationId !== "number" || !Number.isInteger(locationId) || locationId <= 0) return null;
    if (action !== "restore" && action !== "writeOff") return null;
    actions.push({ locationId, action });
  }
  return actions;
}

export function registerPerpetualReadinessRoutes(app: Express) {
  app.get(
    "/api/accounting/perpetual-inventory/readiness",
    requireAuth,
    requireRole("Admin", "Owner"),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const effectiveFrom = typeof req.query.effectiveFrom === "string" ? req.query.effectiveFrom : undefined;
        if (effectiveFrom !== undefined && !ISO_DATE.test(effectiveFrom)) {
          return res.status(400).json({ message: "Invalid date" });
        }
        res.json(await perpetualReadinessReport(companyId, effectiveFrom));
      } catch (error: unknown) {
        logger.error("Error building the perpetual inventory readiness report:", { error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  app.get(
    "/api/accounting/perpetual-inventory/readiness-resolution",
    requireAuth,
    requireRole("Admin", "Owner"),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        res.json(await planReadinessResolution(companyId));
      } catch (error: unknown) {
        logger.error("Error previewing the inventory readiness resolution:", { error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  app.post(
    "/api/accounting/perpetual-inventory/readiness-resolution/apply",
    requireAuth,
    requireRole("Owner"),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        if (req.body?.confirm !== true) return res.status(400).json({ message: "Confirmation is required" });
        const planHash = req.body?.planHash;
        if (typeof planHash !== "string" || !PLAN_HASH.test(planHash)) {
          return res.status(400).json({ message: "The reviewed plan hash is required" });
        }
        const actions = parseActions(req.body?.actions);
        if (actions === null) {
          return res.status(400).json({ message: "Each action needs a locationId and the action restore or writeOff" });
        }
        const result = await applyReadinessResolution(companyId, {
          planHash,
          actions,
          writeOffAnomalies: req.body?.writeOffAnomalies === true,
          actor: {
            userId: String(req.session.userId ?? ""),
            username: req.session.username || String(req.session.userId ?? "unknown"),
          },
        });
        res.json(result);
      } catch (error: unknown) {
        if (error instanceof ReadinessResolutionRefusal) {
          const status = error.code === "INVALID_ACTIONS" || error.code === "NOTHING_TO_APPLY" ? 400 : 409;
          return res.status(status).json({ code: error.code, message: error.message });
        }
        const closed = closedPeriodErrorResponse(error);
        if (closed) return res.status(closed.status).json(closed.body);
        logger.error("Error applying the inventory readiness resolution:", { error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}
