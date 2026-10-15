import type { Express, Request, Response } from "express";
import { pool } from "../../../db";
import { requireAuth, requireRole } from "../../../auth";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";

interface PlannerRow {
  allocations_20t: Record<string, number> | null;
  is_locked: boolean;
  revision: number;
  updated_at: Date;
  updated_by: string | null;
}

const EDITORS = [requireAuth, requireRole("Admin", "Developer", "Owner")] as const;

function companyIdFor(req: Request): number | null {
  const raw = req.session.factoryCompanyId || req.session.currentCompanyId;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function sendPlanner(res: Response, row?: PlannerRow) {
  return res.json({
    allocations20t: row?.allocations_20t ?? {},
    locked: row?.is_locked ?? false,
    revision: row?.revision ?? 0,
    updatedAt: row?.updated_at ?? null,
    updatedBy: row?.updated_by ?? null,
  });
}

/**
 * Only the editable 20-ton allocation is persisted. In-hand and OTW must always
 * come from the existing live raw-stock and factory-containers endpoints.
 */
export function registerFixedProductionPlannerRoutes(app: Express) {
  app.get("/api/factory/raw-stock/fixed-production-planner", requireAuth, async (req: Request, res: Response) => {
    const companyId = companyIdFor(req);
    if (!companyId) return res.status(400).json({ message: "No company selected" });
    try {
      const result = await pool.query<PlannerRow>(
        `SELECT allocations_20t, is_locked, revision, updated_at, updated_by
           FROM factory_fixed_production_plans WHERE company_id = $1`,
        [companyId]
      );
      return sendPlanner(res, result.rows[0]);
    } catch (error) {
      logger.error("Fixed Production Planner load failed", { error });
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/factory/raw-stock/fixed-production-planner/save", ...EDITORS, async (req: Request, res: Response) => {
    const companyId = companyIdFor(req);
    if (!companyId) return res.status(400).json({ message: "No company selected" });
    const input: unknown = req.body?.allocations20t;
    const expectedRevision = req.body?.expectedRevision;
    if (input === null || typeof input !== "object" || Array.isArray(input) ||
        !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      return res.status(400).json({ message: "Invalid allocations or plan revision" });
    }
    const entries = Object.entries(input);
    if (entries.length > 1000) return res.status(400).json({ message: "Too many supplier allocations" });
    const allocations: Record<string, number> = {};
    for (const [supplierId, value] of entries) {
      if (!/^[1-9][0-9]*$/.test(supplierId) || !Number.isSafeInteger(Number(supplierId)) ||
          typeof value !== "number" || !Number.isFinite(value) || value < 0 ||
          !Number.isSafeInteger(Math.trunc(value)) || !/^\d+(?:\.\d{1,3})?$/.test(String(value))) {
        return res.status(400).json({ message: `Invalid 20-ton quantity for supplier ${supplierId}` });
      }
      allocations[supplierId] = value;
    }
    try {
      // Never accept an allocation for a supplier outside the currently selected factory company.
      const suppliers = await pool.query<{ id: number }>(
        "SELECT id FROM factory_suppliers WHERE company_id = $1",
        [companyId]
      );
      const valid = new Set(suppliers.rows.map((supplier) => String(supplier.id)));
      if (Object.keys(allocations).some((id) => !valid.has(id))) {
        return res.status(400).json({ message: "One or more suppliers do not belong to this company" });
      }
      const actor = String(req.session.userId || req.user?.id || "unknown");
      // Atomic compare-and-set: concurrent editors cannot overwrite a saved/locked plan.
      const result = await pool.query<PlannerRow>(
        `INSERT INTO factory_fixed_production_plans
           (company_id, allocations_20t, is_locked, revision, updated_by, updated_at)
         VALUES ($1, $2::jsonb, true, 1, $3, now())
         ON CONFLICT (company_id) DO UPDATE SET
           allocations_20t = EXCLUDED.allocations_20t,
           is_locked = true,
           revision = factory_fixed_production_plans.revision + 1,
           updated_by = EXCLUDED.updated_by,
           updated_at = now()
         WHERE factory_fixed_production_plans.is_locked = false
           AND factory_fixed_production_plans.revision = $4
         RETURNING allocations_20t, is_locked, revision, updated_at, updated_by`,
        [companyId, JSON.stringify(allocations), actor, expectedRevision]
      );
      if (!result.rows[0]) return res.status(409).json({ message: "Planner was locked or edited elsewhere. Refresh before saving." });
      return sendPlanner(res, result.rows[0]);
    } catch (error) {
      logger.error("Fixed Production Planner save failed", { error });
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/factory/raw-stock/fixed-production-planner/unlock", ...EDITORS, async (req: Request, res: Response) => {
    const companyId = companyIdFor(req);
    if (!companyId) return res.status(400).json({ message: "No company selected" });
    const expectedRevision = req.body?.expectedRevision;
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision <= 0) {
      return res.status(400).json({ message: "Invalid plan revision" });
    }
    try {
      const actor = String(req.session.userId || req.user?.id || "unknown");
      const result = await pool.query<PlannerRow>(
        `UPDATE factory_fixed_production_plans
           SET is_locked = false, revision = revision + 1, updated_by = $2, updated_at = now()
         WHERE company_id = $1 AND is_locked = true AND revision = $3
         RETURNING allocations_20t, is_locked, revision, updated_at, updated_by`,
        [companyId, actor, expectedRevision]
      );
      if (!result.rows[0]) return res.status(409).json({ message: "Plan already changed. Refresh before unlocking." });
      return sendPlanner(res, result.rows[0]);
    } catch (error) {
      logger.error("Fixed Production Planner unlock failed", { error });
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
