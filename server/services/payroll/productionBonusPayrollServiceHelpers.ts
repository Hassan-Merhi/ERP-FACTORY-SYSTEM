// Extracted from ./productionBonusPayrollService.ts
import { sql } from "drizzle-orm";
import { sqlArray } from "../../lib/sqlArray";
import { resultRows as rows } from "../../lib/queryResult";
import type { DatabaseOrTransaction } from "../../db";
import { type ProductionBonusMemberSnapshot } from "../factory/productionBonusPreview";

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
    .map((member) => ({ workerId: Number(member?.workerId), workerName: String(member?.workerName ?? "") }))
    .filter((member) => Number.isInteger(member.workerId) && member.workerId > 0 && member.workerName.trim().length > 0)
    .sort((a, b) => a.workerId - b.workerId);
}

interface LinkedWorkerGroupWindow {
  effectiveFrom: string;
  effectiveTo: string | null;
  workerIds: number[];
}

interface SavedPlanEntry {
  planId: number;
  planEntryId: number;
  productionDate: string;
  positionId: number;
  positionName: string;
  targetBales: number;
  bonusPerExtraBale: number;
  bonusEnabled: boolean;
  members: ProductionBonusMemberSnapshot[];
}

export interface PayrollProductionBonusTotals {
  approved: number;
  pending: number;
  rejected: number;
  totalSuggested: number;
  pendingCount: number;
  approvedCount: number;
  rejectedCount: number;
}

export interface PayrollProductionBonusAllocationDetail {
  allocationId: number;
  runId: number;
  productionDate: string;
  positionId: number;
  positionName: string;
  targetBales: number;
  actualBales: number;
  extraBales: number;
  rate: number;
  bonusPool: number;
  memberCount: number;
  workerId: number;
  workerName: string;
  amount: number;
  decisionStatus: "PENDING" | "APPROVED" | "REJECTED";
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
}

export const EMPTY_TOTALS: PayrollProductionBonusTotals = {
  approved: 0,
  pending: 0,
  rejected: 0,
  totalSuggested: 0,
  pendingCount: 0,
  approvedCount: 0,
  rejectedCount: 0,
};

export async function loadSavedPlanEntries(
  executor: DatabaseOrTransaction,
  companyId: number,
  startDate: string,
  endDate: string
): Promise<SavedPlanEntry[]> {
  const result = await executor.execute(sql`
    SELECT p.id AS "planId", e.id AS "planEntryId", p.plan_date::text AS "productionDate",
           e.position_id AS "positionId", e.position_name_snapshot AS "positionName",
           e.target_bales AS "targetBales", e.bonus_per_extra_bale::text AS "bonusPerExtraBale",
           e.bonus_enabled AS "bonusEnabled", e.member_snapshot AS members
    FROM factory_production_plans p
    JOIN factory_production_position_plan_entries e ON e.plan_id = p.id
    WHERE p.company_id = ${companyId} AND e.company_id = ${companyId}
      AND p.plan_date BETWEEN ${startDate}::date AND ${endDate}::date
    ORDER BY p.plan_date, e.position_id
  `);
  return rows(result).map((row) => ({
    planId: Number(row.planId),
    planEntryId: Number(row.planEntryId),
    productionDate: String(row.productionDate),
    positionId: Number(row.positionId),
    positionName: String(row.positionName),
    targetBales: Number(row.targetBales ?? 0),
    bonusPerExtraBale: Number(row.bonusPerExtraBale ?? 0),
    bonusEnabled: row.bonusEnabled === true,
    members: parseMembers(row.members),
  }));
}

export async function loadLinkedWorkerGroupsForPeriod(
  executor: DatabaseOrTransaction,
  companyId: number,
  startDate: string,
  endDate: string
): Promise<LinkedWorkerGroupWindow[]> {
  const result = await executor.execute(sql`
    SELECT
      l.effective_from::text AS "effectiveFrom",
      l.effective_to::text AS "effectiveTo",
      array_agg(m.worker_id ORDER BY m.worker_id) AS "workerIds"
    FROM factory_worker_production_links l
    JOIN factory_worker_production_link_members m
      ON m.link_id = l.id
     AND m.company_id = l.company_id
    WHERE l.company_id = ${companyId}
      AND l.effective_from <= ${endDate}::date
      AND (l.effective_to IS NULL OR l.effective_to > ${startDate}::date)
    GROUP BY l.id, l.effective_from, l.effective_to
    ORDER BY l.effective_from, l.id
  `);

  return rows(result).map((row) => ({
    effectiveFrom: String(row.effectiveFrom),
    effectiveTo: row.effectiveTo == null ? null : String(row.effectiveTo),
    workerIds: Array.isArray(row.workerIds)
      ? row.workerIds.map(Number).filter((id) => Number.isInteger(id) && id > 0)
      : [],
  }));
}

export function activeLinkedGroupsForDate(
  windows: LinkedWorkerGroupWindow[],
  productionDate: string,
  members: ProductionBonusMemberSnapshot[]
): number[][] {
  const memberIds = new Set(members.map((member) => member.workerId));
  return windows
    .filter(
      (window) =>
        window.effectiveFrom <= productionDate && (window.effectiveTo === null || window.effectiveTo > productionDate)
    )
    .map((window) => window.workerIds.filter((workerId) => memberIds.has(workerId)))
    .filter((workerIds) => workerIds.length >= 2);
}

export async function getProductionBonusTotalsForPayrollIds(
  executor: DatabaseOrTransaction,
  payrollIds: number[]
): Promise<Map<number, PayrollProductionBonusTotals>> {
  const map = new Map<number, PayrollProductionBonusTotals>();
  if (payrollIds.length === 0) return map;
  const result = await executor.execute(sql`
    SELECT payroll_id AS "payrollId",
      COALESCE(SUM(amount) FILTER (WHERE decision_status = 'APPROVED'), 0)::text AS approved,
      COALESCE(SUM(amount) FILTER (WHERE decision_status = 'PENDING'), 0)::text AS pending,
      COALESCE(SUM(amount) FILTER (WHERE decision_status = 'REJECTED'), 0)::text AS rejected,
      COALESCE(SUM(amount), 0)::text AS "totalSuggested",
      COUNT(*) FILTER (WHERE decision_status = 'PENDING')::integer AS "pendingCount",
      COUNT(*) FILTER (WHERE decision_status = 'APPROVED')::integer AS "approvedCount",
      COUNT(*) FILTER (WHERE decision_status = 'REJECTED')::integer AS "rejectedCount"
    FROM factory_production_bonus_allocations
    WHERE payroll_id = ANY(${sqlArray(payrollIds)})
    GROUP BY payroll_id
  `);
  for (const row of rows(result)) {
    map.set(Number(row.payrollId), {
      approved: Number(row.approved ?? 0),
      pending: Number(row.pending ?? 0),
      rejected: Number(row.rejected ?? 0),
      totalSuggested: Number(row.totalSuggested ?? 0),
      pendingCount: Number(row.pendingCount ?? 0),
      approvedCount: Number(row.approvedCount ?? 0),
      rejectedCount: Number(row.rejectedCount ?? 0),
    });
  }
  return map;
}
