import type { Express, Request, Response } from "express";
import { sql } from "drizzle-orm";
import { requireAuth } from "../../auth";
import { db, type RawQueryRow } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { sqlArray } from "../../lib/sqlArray";
import { calculateProductionBonusPreview } from "../../services/factory/productionBonusPreview";
import { loadActiveProductionWorkerLinks } from "../../services/factory/productionWorkerLinks";
import { checkFactoryAdmin } from "./_helpers";
import {
  DATE_RE,
  companyIdFor,
  loadEffectivePositionSnapshots,
  loadSavedPositionSnapshots,
  mergeSnapshots,
  validateEntries,
  type PositionActualRow,
  type PlanRow,
  type PositionNameRow,
} from "./productionPositionPlannerRoutesHelpers";

const ELIGIBLE_BALE_STATUSES = ["IN_STOCK", "SOLD", "RESERVED_FOR_ORDER", "DISPATCHED", "FINALIZED"] as const;

async function loadActuals(
  companyId: number,
  date: string
): Promise<{ actuals: Map<number, number>; unattributedBales: number }> {
  const actualResult = await db.execute<RawQueryRow<PositionActualRow>>(sql`
    SELECT a.production_position_id AS "positionId", COUNT(*)::integer AS "actualBales"
    FROM factory_bale_production_attributions a
    JOIN factory_bales b
      ON b.id = a.bale_id
     AND b.company_id = a.company_id
    WHERE a.company_id = ${companyId}
      AND a.stock_entry_date = ${date}::date
      AND a.production_position_id IS NOT NULL
      AND b.deleted_at IS NULL
      AND b.status = ANY(${sqlArray([...ELIGIBLE_BALE_STATUSES])})
    GROUP BY a.production_position_id
  `);
  const actuals = new Map<number, number>();
  for (const row of actualResult.rows) actuals.set(Number(row.positionId), Number(row.actualBales ?? 0));

  const unattributedResult = await db.execute<RawQueryRow<{ count: number }>>(sql`
    SELECT COUNT(*)::integer AS count
    FROM factory_bale_production_attributions a
    JOIN factory_bales b
      ON b.id = a.bale_id
     AND b.company_id = a.company_id
    WHERE a.company_id = ${companyId}
      AND a.stock_entry_date = ${date}::date
      AND a.worker_id IS NOT NULL
      AND a.production_position_id IS NULL
      AND b.deleted_at IS NULL
      AND b.status = ANY(${sqlArray([...ELIGIBLE_BALE_STATUSES])})
  `);
  const unattributedBales = Number(unattributedResult.rows[0]?.count ?? 0);
  return { actuals, unattributedBales };
}

async function buildPlannerResponse(companyId: number, date: string) {
  const planResult = await db.execute<RawQueryRow<PlanRow>>(sql`
    SELECT id, plan_date, notes
    FROM factory_production_plans
    WHERE company_id = ${companyId} AND plan_date = ${date}::date
    LIMIT 1
  `);
  const planRow = planResult.rows[0] ?? null;
  const planId = planRow ? Number(planRow.id) : null;

  const [effective, saved, actualData, activeWorkerLinks] = await Promise.all([
    loadEffectivePositionSnapshots(companyId, date),
    planId ? loadSavedPositionSnapshots(planId, companyId) : Promise.resolve([]),
    loadActuals(companyId, date),
    loadActiveProductionWorkerLinks(companyId, date),
  ]);

  const snapshots = mergeSnapshots(saved, effective);
  const entries = snapshots.map((entry) => {
    const actualBales = actualData.actuals.get(entry.positionId) ?? 0;
    const memberIds = new Set(entry.members.map((member) => member.workerId));
    const linkedWorkerGroups = activeWorkerLinks
      .map((link) => link.members.map((member) => member.workerId).filter((workerId) => memberIds.has(workerId)))
      .filter((workerIds) => workerIds.length >= 2);
    const preview = calculateProductionBonusPreview({
      targetBales: entry.targetBales,
      actualBales,
      bonusPerExtraBale: entry.bonusPerExtraBale,
      bonusEnabled: entry.bonusEnabled,
      members: entry.members,
      ...(linkedWorkerGroups.length > 0 ? { linkedWorkerGroups } : {}),
    });
    return {
      ...entry,
      actualBales,
      memberCount: entry.members.length,
      extraBales: preview.extraBales,
      bonusPool: preview.bonusPool,
      perWorkerMin: preview.perWorkerMin,
      perWorkerMax: preview.perWorkerMax,
      allocations: preview.allocations,
      distributable: preview.distributable,
      targetMet: entry.targetBales > 0 && actualBales >= entry.targetBales,
    };
  });

  const summary = entries.reduce(
    (acc, entry) => {
      acc.totalTarget += entry.targetBales;
      acc.totalActual += entry.actualBales;
      acc.totalExtra += entry.extraBales;
      acc.totalBonusPool = Number((acc.totalBonusPool + entry.bonusPool).toFixed(2));
      return acc;
    },
    {
      totalTarget: 0,
      totalActual: 0,
      totalExtra: 0,
      totalBonusPool: 0,
      unattributedBales: actualData.unattributedBales,
    }
  );

  return {
    plan: planRow
      ? { id: planId, planDate: String(planRow.plan_date), notes: planRow.notes ?? "", saved: saved.length > 0 }
      : { id: null, planDate: date, notes: "", saved: false },
    entries,
    summary,
  };
}

export function registerProductionPositionPlannerRoutes(app: Express) {
  app.get("/api/factory/production-position-planner/:date", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = companyIdFor(req);
      const date = String(req.params.date ?? "");
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      if (!DATE_RE.test(date)) return res.status(400).json({ message: "Date must be YYYY-MM-DD" });
      res.json(await buildPlannerResponse(companyId, date));
    } catch (error: unknown) {
      logger.error("[ProductionPositionPlanner] GET error", { error: getErrorMessage(error) });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/factory/production-position-planner/:date", requireAuth, async (req: Request, res: Response) => {
    try {
      if (!checkFactoryAdmin(req, res)) return;
      const companyId = companyIdFor(req);
      const date = String(req.params.date ?? "");
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      if (!DATE_RE.test(date)) return res.status(400).json({ message: "Date must be YYYY-MM-DD" });
      const entries = validateEntries(req.body?.entries);
      const notes = typeof req.body?.notes === "string" ? req.body.notes.slice(0, 5000) : null;

      const effective = await loadEffectivePositionSnapshots(companyId, date);
      const effectiveById = new Map(effective.map((entry) => [entry.positionId, entry]));

      const requestedIds = entries.map((entry) => entry.positionId);
      if (requestedIds.length > 0) {
        const existingResult = await db.execute<RawQueryRow<PositionNameRow>>(sql`
          SELECT id, name
          FROM factory_production_positions
          WHERE company_id = ${companyId} AND id = ANY(${sqlArray(requestedIds)})
        `);
        if (existingResult.rows.length !== requestedIds.length) {
          return res
            .status(400)
            .json({ message: "One or more production positions belong to another company or do not exist" });
        }
      }

      await db.transaction(async (tx) => {
        await tx.execute(sql`
          INSERT INTO factory_production_plans (company_id, plan_date, category_ids, notes)
          VALUES (${companyId}, ${date}::date, '[]', ${notes})
          ON CONFLICT (company_id, plan_date)
          DO UPDATE SET notes = EXCLUDED.notes
        `);
        const planResult = await tx.execute<RawQueryRow<PlanRow>>(sql`
          SELECT id FROM factory_production_plans
          WHERE company_id = ${companyId} AND plan_date = ${date}::date
          LIMIT 1
        `);
        const planId = Number(planResult.rows[0]?.id);
        if (!planId) throw new Error("Could not resolve production plan");

        await tx.execute(sql`DELETE FROM factory_production_position_plan_entries WHERE plan_id = ${planId}`);

        for (const entry of entries) {
          let snapshot = effectiveById.get(entry.positionId) ?? null;
          if (!snapshot) {
            const positionResult = await tx.execute<RawQueryRow<PositionNameRow>>(sql`
              SELECT id, name FROM factory_production_positions
              WHERE company_id = ${companyId} AND id = ${entry.positionId}
              LIMIT 1
            `);
            const position = positionResult.rows[0];
            if (!position) throw new Error("Production position not found");
            snapshot = {
              positionId: Number(position.id),
              positionName: String(position.name),
              targetBales: 0,
              bonusPerExtraBale: 0,
              bonusEnabled: false,
              members: [],
              saved: false,
            };
          }
          const memberJson = JSON.stringify(snapshot.members);
          await tx.execute(sql`
            INSERT INTO factory_production_position_plan_entries (
              plan_id, company_id, position_id, position_name_snapshot,
              target_bales, bonus_per_extra_bale, bonus_enabled, member_snapshot,
              updated_at
            ) VALUES (
              ${planId}, ${companyId}, ${entry.positionId}, ${snapshot.positionName},
              ${entry.targetBales}, ${String(entry.bonusPerExtraBale)}, ${entry.bonusEnabled},
              ${memberJson}::jsonb, NOW()
            )
          `);
        }
      });

      res.json(await buildPlannerResponse(companyId, date));
    } catch (error: unknown) {
      logger.error("[ProductionPositionPlanner] POST error", { error: getErrorMessage(error) });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.get(
    "/api/factory/production-position-planner/:date/copy-previous",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const companyId = companyIdFor(req);
        const date = String(req.params.date ?? "");
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        if (!DATE_RE.test(date)) return res.status(400).json({ message: "Date must be YYYY-MM-DD" });

        const previousResult = await db.execute<RawQueryRow<PlanRow>>(sql`
        SELECT p.id, p.plan_date, p.notes
        FROM factory_production_plans p
        WHERE p.company_id = ${companyId}
          AND p.plan_date < ${date}::date
          AND EXISTS (
            SELECT 1 FROM factory_production_position_plan_entries e WHERE e.plan_id = p.id
          )
        ORDER BY p.plan_date DESC
        LIMIT 1
      `);
        const previous = previousResult.rows[0];
        if (!previous) return res.json({ fromDate: null, notes: "", entries: [] });

        const previousEntries = await loadSavedPositionSnapshots(Number(previous.id), companyId);
        const currentEntries = await loadEffectivePositionSnapshots(companyId, date);
        const previousById = new Map(previousEntries.map((entry) => [entry.positionId, entry]));
        const merged = currentEntries.map((entry) => {
          const prior = previousById.get(entry.positionId);
          return prior
            ? {
                ...entry,
                targetBales: prior.targetBales,
                bonusPerExtraBale: prior.bonusPerExtraBale,
                bonusEnabled: prior.bonusEnabled,
              }
            : entry;
        });
        res.json({
          fromDate: String(previous.plan_date),
          notes: previous.notes ?? "",
          entries: merged,
        });
      } catch (error: unknown) {
        logger.error("[ProductionPositionPlanner] copy previous error", { error: getErrorMessage(error) });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}
