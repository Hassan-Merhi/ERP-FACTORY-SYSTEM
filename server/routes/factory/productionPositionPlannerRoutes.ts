import type { Express, Request, Response } from "express";
import { sql } from "drizzle-orm";
import { requireAuth } from "../../auth";
import { db, type RawQueryRow } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { sqlArray } from "../../lib/sqlArray";
import {
  calculateProductionBonusPreview,
  type ProductionBonusMemberSnapshot,
} from "../../services/factory/productionBonusPreview";
import { checkFactoryAdmin } from "./_helpers";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ELIGIBLE_BALE_STATUSES = ["IN_STOCK", "SOLD", "RESERVED_FOR_ORDER", "DISPATCHED", "FINALIZED"] as const;

interface PositionPlanInput {
  positionId: number;
  targetBales: number;
  bonusPerExtraBale: number;
  bonusEnabled: boolean;
}

interface PositionSnapshot {
  positionId: number;
  positionName: string;
  targetBales: number;
  bonusPerExtraBale: number;
  bonusEnabled: boolean;
  members: ProductionBonusMemberSnapshot[];
  saved: boolean;
}

/**
 * Raw projections behind the production-position planner. The aliases are
 * quoted in SQL so the columns arrive camelCased; `bonus_per_extra_bale` is
 * cast to text in the saved-snapshot query, and `member_snapshot` is a jsonb
 * column parsed by parseMembers.
 */
interface PositionSnapshotRow {
  positionId: number;
  positionName: string;
  targetBales: number | string | null;
  bonusPerExtraBale: number | string | null;
  bonusEnabled: boolean | null;
  members: unknown;
}

interface PositionActualRow {
  positionId: number;
  actualBales: number | string | null;
}

interface PlanRow {
  id: number;
}

interface PositionNameRow {
  id: number;
  name: string;
}

function companyIdFor(req: import("express").Request): number | null {
  return req.session?.factoryCompanyId || req.session?.currentCompanyId || null;
}

function parseMembers(value: unknown): ProductionBonusMemberSnapshot[] {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((member) => ({
      workerId: Number(member?.workerId),
      workerName: String(member?.workerName ?? ""),
    }))
    .filter((member) => Number.isInteger(member.workerId) && member.workerId > 0 && member.workerName.trim().length > 0)
    .sort((a, b) => a.workerId - b.workerId);
}

async function loadEffectivePositionSnapshots(companyId: number, date: string): Promise<PositionSnapshot[]> {
  const result = await db.execute(sql`
    SELECT
      p.id AS "positionId",
      p.name AS "positionName",
      COALESCE(r.target_bales, 0)::integer AS "targetBales",
      COALESCE(r.bonus_per_extra_bale, 0)::text AS "bonusPerExtraBale",
      COALESCE(r.bonus_enabled, false) AS "bonusEnabled",
      COALESCE(
        jsonb_agg(
          jsonb_build_object('workerId', w.id, 'workerName', w.full_name)
          ORDER BY w.id
        ) FILTER (WHERE w.id IS NOT NULL),
        '[]'::jsonb
      ) AS members
    FROM factory_production_positions p
    LEFT JOIN LATERAL (
      SELECT target_bales, bonus_per_extra_bale, bonus_enabled
      FROM factory_production_position_rules r0
      WHERE r0.company_id = ${companyId}
        AND r0.position_id = p.id
        AND r0.effective_from <= ${date}::date
        AND (r0.effective_to IS NULL OR r0.effective_to > ${date}::date)
      ORDER BY r0.effective_from DESC
      LIMIT 1
    ) r ON TRUE
    LEFT JOIN factory_production_position_memberships m
      ON m.company_id = ${companyId}
     AND m.position_id = p.id
     AND m.effective_from <= ${date}::date
     AND (m.effective_to IS NULL OR m.effective_to > ${date}::date)
    LEFT JOIN factory_workers w
      ON w.id = m.worker_id
     AND w.company_id = ${companyId}
    WHERE p.company_id = ${companyId}
      AND (p.active = TRUE OR m.id IS NOT NULL)
    GROUP BY p.id, p.name, r.target_bales, r.bonus_per_extra_bale, r.bonus_enabled
    ORDER BY p.name
  `);

  return result.rows.map((row) => ({
    positionId: Number(row.positionId),
    positionName: String(row.positionName),
    targetBales: Number(row.targetBales ?? 0),
    bonusPerExtraBale: Number(row.bonusPerExtraBale ?? 0),
    bonusEnabled: row.bonusEnabled === true,
    members: parseMembers(row.members),
    saved: false,
  }));
}

async function loadSavedPositionSnapshots(planId: number, companyId: number): Promise<PositionSnapshot[]> {
  const result = await db.execute<RawQueryRow<PositionSnapshotRow>>(sql`
    SELECT
      position_id AS "positionId",
      position_name_snapshot AS "positionName",
      target_bales AS "targetBales",
      bonus_per_extra_bale::text AS "bonusPerExtraBale",
      bonus_enabled AS "bonusEnabled",
      member_snapshot AS members
    FROM factory_production_position_plan_entries
    WHERE plan_id = ${planId} AND company_id = ${companyId}
    ORDER BY position_name_snapshot
  `);
  return result.rows.map((row) => ({
    positionId: Number(row.positionId),
    positionName: String(row.positionName),
    targetBales: Number(row.targetBales ?? 0),
    bonusPerExtraBale: Number(row.bonusPerExtraBale ?? 0),
    bonusEnabled: row.bonusEnabled === true,
    members: parseMembers(row.members),
    saved: true,
  }));
}

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

function mergeSnapshots(saved: PositionSnapshot[], effective: PositionSnapshot[]): PositionSnapshot[] {
  const byId = new Map<number, PositionSnapshot>();
  for (const entry of effective) byId.set(entry.positionId, entry);
  for (const entry of saved) byId.set(entry.positionId, entry);
  return [...byId.values()].sort((a, b) => a.positionName.localeCompare(b.positionName));
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

  const [effective, saved, actualData] = await Promise.all([
    loadEffectivePositionSnapshots(companyId, date),
    planId ? loadSavedPositionSnapshots(planId, companyId) : Promise.resolve([]),
    loadActuals(companyId, date),
  ]);

  const snapshots = mergeSnapshots(saved, effective);
  const entries = snapshots.map((entry) => {
    const actualBales = actualData.actuals.get(entry.positionId) ?? 0;
    const preview = calculateProductionBonusPreview({
      targetBales: entry.targetBales,
      actualBales,
      bonusPerExtraBale: entry.bonusPerExtraBale,
      bonusEnabled: entry.bonusEnabled,
      members: entry.members,
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

function validateEntries(value: unknown): PositionPlanInput[] {
  if (!Array.isArray(value)) throw new Error("entries must be an array");
  const seen = new Set<number>();
  return value.map((raw) => {
    const positionId = Number(raw?.positionId);
    const targetBales = Number(raw?.targetBales);
    const bonusPerExtraBale = Number(raw?.bonusPerExtraBale);
    const bonusEnabled = raw?.bonusEnabled === true;
    if (!Number.isInteger(positionId) || positionId <= 0) throw new Error("Invalid production position");
    if (seen.has(positionId)) throw new Error("Duplicate production position in plan");
    seen.add(positionId);
    if (!Number.isInteger(targetBales) || targetBales < 0 || targetBales > 100000) {
      throw new Error("Target bales must be a whole number from 0 to 100000");
    }
    if (!Number.isFinite(bonusPerExtraBale) || bonusPerExtraBale < 0 || bonusPerExtraBale > 1000000) {
      throw new Error("Bonus per extra bale must be 0 or more");
    }
    return { positionId, targetBales, bonusPerExtraBale, bonusEnabled };
  });
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
