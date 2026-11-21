// Extracted from ./productionPositionPlannerRoutes.ts
import { sql } from "drizzle-orm";
import { db, type RawQueryRow } from "../../db";
import { type ProductionBonusMemberSnapshot } from "../../services/factory/productionBonusPreview";

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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

export interface PositionActualRow {
  positionId: number;
  actualBales: number | string | null;
}

export interface PlanRow {
  id: number;
}

export interface PositionNameRow {
  id: number;
  name: string;
}

export function companyIdFor(req: import("express").Request): number | null {
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

export async function loadEffectivePositionSnapshots(companyId: number, date: string): Promise<PositionSnapshot[]> {
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

export async function loadSavedPositionSnapshots(planId: number, companyId: number): Promise<PositionSnapshot[]> {
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

export function mergeSnapshots(saved: PositionSnapshot[], effective: PositionSnapshot[]): PositionSnapshot[] {
  const byId = new Map<number, PositionSnapshot>();
  for (const entry of effective) byId.set(entry.positionId, entry);
  for (const entry of saved) byId.set(entry.positionId, entry);
  return [...byId.values()].sort((a, b) => a.positionName.localeCompare(b.positionName));
}

export function validateEntries(value: unknown): PositionPlanInput[] {
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
