import { Express } from "express";
import type { Request, Response } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { db } from "../../db";
import { requireAuth } from "../../auth";
import { sql } from "drizzle-orm";
import { sqlArray } from "../../lib/sqlArray";
import { resultRows } from "../../lib/queryResult";
import { z } from "zod";
import {
  emptyBody,
  emptyQuery,
  stringParam,
  validateRequest,
  validatedInput,
  type RequestSchemas,
} from "../../lib/validateRequest";

// The date segment goes to SQL as-is, so any non-empty segment is accepted here.
const planDateParams = z.strictObject({ date: stringParam });
// Values are bound straight into SQL parameters; Postgres casts numeric strings.
const planNumber = z.union([z.number(), z.string()]);
const savePlanInput = {
  params: planDateParams,
  query: emptyQuery,
  body: z.strictObject({
    notes: z.string().nullable().optional(),
    categoryIds: z.array(planNumber).nullable().optional(),
    entries: z
      .array(
        z.strictObject({
          workerId: planNumber,
          targetBales: planNumber.nullable().optional(),
          workerCount: planNumber.nullable().optional(),
        })
      )
      .nullable()
      .optional(),
  }),
} satisfies RequestSchemas;
const deletePlanInput = { params: planDateParams, query: emptyQuery, body: emptyBody } satisfies RequestSchemas;

export function registerProductionPlannerRoutes(app: Express) {
  const getCompanyId = (req: import("express").Request): number | null =>
    req.session.factoryCompanyId || req.session.currentCompanyId || null;

  // ── GET plan for a date ──────────────────────────────────────────────────────
  app.get("/api/factory/production-planner/:date", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const { date } = req.params;

      const plans = await db.execute(sql`
        SELECT id, plan_date, category_ids, notes
        FROM factory_production_plans
        WHERE company_id = ${companyId} AND plan_date = ${date}
      `);
      const planRows = Array.isArray(plans) ? plans : resultRows(plans);
      const plan = planRows[0] ?? null;

      if (!plan) return res.json({ plan: null, entries: [], actuals: {} });

      const planId = Number(plan.id);

      const entryResult = await db.execute(sql`
        SELECT e.id, e.worker_id AS "workerId", w.full_name AS "workerName",
               e.target_bales AS "targetBales",
               COALESCE(e.worker_count, 0) AS "workerCount"
        FROM factory_production_plan_entries e
        JOIN factory_workers w ON w.id = e.worker_id
        WHERE e.plan_id = ${planId}
        ORDER BY w.full_name
      `);
      const entries = Array.isArray(entryResult) ? entryResult : resultRows(entryResult);

      const workerIds = entries.map((e) => Number(e.workerId));
      let categoryIds: number[] = [];
      try {
        const parsed = JSON.parse(plan.category_ids || "[]");
        if (Array.isArray(parsed)) categoryIds = parsed.map(Number).filter((n) => !isNaN(n));
      } catch {
        categoryIds = [];
      }

      const actuals: Record<number, number> = {};
      if (workerIds.length > 0) {
        let teamWorkerFilter = sql``;
        let skipActuals = false;
        if (categoryIds.length > 0) {
          const wcResult = await db.execute(sql`
            SELECT worker_ids FROM factory_worker_categories
            WHERE company_id = ${companyId}
              AND id = ANY(${sqlArray(categoryIds)})
          `);
          const wcRows = Array.isArray(wcResult) ? wcResult : resultRows(wcResult);
          const teamWorkerIds = wcRows.flatMap((r) => {
            const ids = r.worker_ids;
            if (Array.isArray(ids)) return ids.map(Number);
            try {
              return JSON.parse(ids || "[]").map(Number);
            } catch {
              return [];
            }
          });
          if (teamWorkerIds.length > 0) {
            teamWorkerFilter = sql`AND fb.finalized_by = ANY(${sqlArray(teamWorkerIds)})`;
          } else {
            skipActuals = true;
          }
        }

        if (!skipActuals) {
          const actualResult = await db.execute(sql`
            SELECT fb.finalized_by AS worker_id, COUNT(*)::integer AS bale_count
            FROM factory_bales fb
            WHERE fb.company_id = ${companyId}
              AND fb.stock_entry_date = ${date}
              AND fb.finalized_by = ANY(${sqlArray(workerIds)})
              AND fb.status IN ('IN_STOCK','SOLD','RESERVED_FOR_ORDER','DISPATCHED','FINALIZED')
              ${teamWorkerFilter}
            GROUP BY fb.finalized_by
          `);
          const actualRows = Array.isArray(actualResult) ? actualResult : resultRows(actualResult);
          for (const row of actualRows) {
            actuals[Number(row.worker_id)] = Number(row.bale_count);
          }
          for (const entry of entries) {
            const wid = Number(entry.workerId);
            actuals[wid] = actuals[wid] ?? 0;
          }
        }
      }

      res.json({
        plan: {
          id: planId,
          planDate: String(plan.plan_date),
          categoryIds,
          notes: plan.notes ?? "",
        },
        entries,
        actuals,
      });
    } catch (e: unknown) {
      logger.error("[ProductionPlanner] GET error:", { error: getErrorMessage(e) });
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  // ── POST — upsert plan for a date ───────────────────────────────────────────
  app.post(
    "/api/factory/production-planner/:date",
    requireAuth,
    validateRequest(savePlanInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = getCompanyId(req);
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const { params, body } = validatedInput(req, savePlanInput);
        const { date } = params;
        const { notes, categoryIds, entries } = body;

        const catJson = JSON.stringify(categoryIds ?? []);

        await db.execute(sql`
        INSERT INTO factory_production_plans (company_id, plan_date, category_ids, notes)
        VALUES (${companyId}, ${date}, ${catJson}, ${notes ?? null})
        ON CONFLICT (company_id, plan_date)
        DO UPDATE SET category_ids = EXCLUDED.category_ids, notes = EXCLUDED.notes
      `);

        const planResult = await db.execute(sql`
        SELECT id FROM factory_production_plans
        WHERE company_id = ${companyId} AND plan_date = ${date}
      `);
        const planRows = Array.isArray(planResult) ? planResult : resultRows(planResult);
        const planId = Number(planRows[0].id);

        await db.execute(sql`DELETE FROM factory_production_plan_entries WHERE plan_id = ${planId}`);

        if (entries && entries.length > 0) {
          for (const entry of entries) {
            const wc = entry.workerCount ?? 0;
            await db.execute(sql`
            INSERT INTO factory_production_plan_entries (plan_id, worker_id, role, target_bales, worker_count)
            VALUES (${planId}, ${entry.workerId}, 'WORKER', ${entry.targetBales ?? 0}, ${wc})
          `);
          }
        }

        res.json({ message: "Plan saved successfully" });
      } catch (e: unknown) {
        logger.error("[ProductionPlanner] POST error:", { error: getErrorMessage(e) });
        res.status(500).json({ message: getErrorMessage(e) });
      }
    }
  );

  // ── GET — copy previous day's plan entries ──────────────────────────────────
  app.get("/api/factory/production-planner/:date/copy-previous", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const { date } = req.params;

      const prevResult = await db.execute(sql`
        SELECT id, plan_date, category_ids, notes
        FROM factory_production_plans
        WHERE company_id = ${companyId} AND plan_date < ${date}
        ORDER BY plan_date DESC LIMIT 1
      `);
      const prevRows = Array.isArray(prevResult) ? prevResult : resultRows(prevResult);
      if (!prevRows[0]) return res.json({ entries: [], categoryIds: [], fromDate: null });

      const prevPlanId = Number(prevRows[0].id);

      const entryResult = await db.execute(sql`
        SELECT e.worker_id AS "workerId", w.full_name AS "workerName",
               e.target_bales AS "targetBales",
               COALESCE(e.worker_count, 0) AS "workerCount"
        FROM factory_production_plan_entries e
        JOIN factory_workers w ON w.id = e.worker_id
        WHERE e.plan_id = ${prevPlanId}
        ORDER BY w.full_name
      `);
      const entries = Array.isArray(entryResult) ? entryResult : resultRows(entryResult);

      let prevCategoryIds: number[] = [];
      try {
        const parsed = JSON.parse(prevRows[0].category_ids || "[]");
        if (Array.isArray(parsed)) prevCategoryIds = parsed.map(Number).filter((n) => !isNaN(n));
      } catch {
        prevCategoryIds = [];
      }
      res.json({
        entries,
        categoryIds: prevCategoryIds,
        notes: prevRows[0].notes ?? "",
        fromDate: String(prevRows[0].plan_date),
      });
    } catch (e: unknown) {
      logger.error("[ProductionPlanner] copy-previous error:", { error: getErrorMessage(e) });
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  // ── GET — worker plan map for a date (used by StockEntryHistory) ─────────────
  app.get("/api/factory/production-planner/:date/worker-targets", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const { date } = req.params;

      const planResult = await db.execute(sql`
        SELECT id FROM factory_production_plans
        WHERE company_id = ${companyId} AND plan_date = ${date}
      `);
      const planRows = Array.isArray(planResult) ? planResult : resultRows(planResult);
      if (!planRows[0]) return res.json({});

      const planId = Number(planRows[0].id);

      const entryResult = await db.execute(sql`
        SELECT e.worker_id AS "workerId",
               e.target_bales AS "targetBales",
               COALESCE(e.worker_count, 0) AS "workerCount"
        FROM factory_production_plan_entries e
        WHERE e.plan_id = ${planId}
      `);
      const entries = Array.isArray(entryResult) ? entryResult : resultRows(entryResult);

      const map: Record<number, { targetBales: number; workerCount: number }> = {};
      for (const e of entries) {
        map[Number(e.workerId)] = { targetBales: Number(e.targetBales), workerCount: Number(e.workerCount) };
      }
      res.json(map);
    } catch (e: unknown) {
      logger.error("[ProductionPlanner] worker-targets error:", { error: getErrorMessage(e) });
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  // ── DELETE plan for a date ──────────────────────────────────────────────────
  app.delete(
    "/api/factory/production-planner/:date",
    requireAuth,
    validateRequest(deletePlanInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = getCompanyId(req);
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const { date } = validatedInput(req, deletePlanInput).params;

        const planResult = await db.execute(sql`
        SELECT id FROM factory_production_plans
        WHERE company_id = ${companyId} AND plan_date = ${date}
      `);
        const planRows = Array.isArray(planResult) ? planResult : resultRows(planResult);
        if (planRows[0]) {
          const planId = Number(planRows[0].id);
          await db.execute(sql`DELETE FROM factory_production_plan_entries WHERE plan_id = ${planId}`);
          await db.execute(sql`DELETE FROM factory_production_plans WHERE id = ${planId}`);
        }

        res.json({ message: "Plan deleted" });
      } catch (e: unknown) {
        res.status(500).json({ message: getErrorMessage(e) });
      }
    }
  );
}
