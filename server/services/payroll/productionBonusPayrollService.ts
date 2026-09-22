import { sql } from "drizzle-orm";
import { sqlArray } from "../../lib/sqlArray";
import { resultRows as rows } from "../../lib/queryResult";
import type { DatabaseOrTransaction } from "../../db";
import { rebuildPayrollGenVoucher } from "../../routes/payroll/_payrollAccountingHelper";
import { calculateProductionBonusPreview, type ProductionBonusMemberSnapshot } from "../factory/productionBonusPreview";

const ELIGIBLE_BALE_STATUSES = ["IN_STOCK", "SOLD", "RESERVED_FOR_ORDER", "DISPATCHED", "FINALIZED"] as const;

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

const EMPTY_TOTALS: PayrollProductionBonusTotals = {
  approved: 0,
  pending: 0,
  rejected: 0,
  totalSuggested: 0,
  pendingCount: 0,
  approvedCount: 0,
  rejectedCount: 0,
};

async function loadSavedPlanEntries(
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

async function loadLinkedWorkerGroupsForPeriod(
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

function activeLinkedGroupsForDate(
  windows: LinkedWorkerGroupWindow[],
  productionDate: string,
  members: ProductionBonusMemberSnapshot[]
): number[][] {
  const memberIds = new Set(members.map((member) => member.workerId));
  return windows
    .filter(
      (window) =>
        window.effectiveFrom <= productionDate &&
        (window.effectiveTo === null || window.effectiveTo > productionDate)
    )
    .map((window) => window.workerIds.filter((workerId) => memberIds.has(workerId)))
    .filter((workerIds) => workerIds.length >= 2);
}

async function loadActualMap(
  executor: DatabaseOrTransaction,
  companyId: number,
  startDate: string,
  endDate: string
): Promise<Map<string, number>> {
  const result = await executor.execute(sql`
    SELECT a.stock_entry_date::text AS "productionDate", a.production_position_id AS "positionId",
           COUNT(*)::integer AS "actualBales"
    FROM factory_bale_production_attributions a
    JOIN factory_bales b ON b.id = a.bale_id AND b.company_id = a.company_id
    WHERE a.company_id = ${companyId}
      AND a.stock_entry_date BETWEEN ${startDate}::date AND ${endDate}::date
      AND a.production_position_id IS NOT NULL
      AND b.deleted_at IS NULL
      AND b.status = ANY(${sqlArray([...ELIGIBLE_BALE_STATUSES])})
    GROUP BY a.stock_entry_date, a.production_position_id
  `);
  const map = new Map<string, number>();
  for (const row of rows(result))
    map.set(`${String(row.productionDate)}:${Number(row.positionId)}`, Number(row.actualBales ?? 0));
  return map;
}

export async function syncProductionBonusProposalsForPeriod(
  executor: DatabaseOrTransaction,
  companyId: number,
  startDate: string,
  endDate: string
): Promise<void> {
  const [planEntries, actualMap, linkedWorkerWindows] = await Promise.all([
    loadSavedPlanEntries(executor, companyId, startDate, endDate),
    loadActualMap(executor, companyId, startDate, endDate),
    loadLinkedWorkerGroupsForPeriod(executor, companyId, startDate, endDate),
  ]);

  for (const entry of planEntries) {
    const existingResult = await executor.execute(sql`
      SELECT r.id,
             EXISTS (
               SELECT 1 FROM factory_production_bonus_allocations a
               WHERE a.run_id = r.id AND a.decision_status <> 'PENDING'
             ) AS "hasDecision"
      FROM factory_production_bonus_runs r
      WHERE r.company_id = ${companyId}
        AND r.production_date = ${entry.productionDate}::date
        AND r.position_id = ${entry.positionId}
      LIMIT 1
    `);
    const existing = rows(existingResult)[0] ?? null;
    if (existing?.hasDecision === true) continue;

    const actualBales = actualMap.get(`${entry.productionDate}:${entry.positionId}`) ?? 0;
    const linkedWorkerGroups = activeLinkedGroupsForDate(
      linkedWorkerWindows,
      entry.productionDate,
      entry.members
    );
    const preview = calculateProductionBonusPreview({
      targetBales: entry.targetBales,
      actualBales,
      bonusPerExtraBale: entry.bonusPerExtraBale,
      bonusEnabled: entry.bonusEnabled,
      members: entry.members,
      ...(linkedWorkerGroups.length > 0 ? { linkedWorkerGroups } : {}),
    });

    const runResult = await executor.execute(sql`
      INSERT INTO factory_production_bonus_runs (
        company_id, plan_id, plan_entry_id, production_date, position_id,
        position_name_snapshot, target_bales, actual_bales, extra_bales,
        bonus_per_extra_bale, bonus_pool, member_count, status, updated_at
      ) VALUES (
        ${companyId}, ${entry.planId}, ${entry.planEntryId}, ${entry.productionDate}::date, ${entry.positionId},
        ${entry.positionName}, ${entry.targetBales}, ${actualBales}, ${preview.extraBales},
        ${String(entry.bonusPerExtraBale)}, ${preview.bonusPool.toFixed(2)}, ${entry.members.length}, 'PENDING', NOW()
      )
      ON CONFLICT (company_id, production_date, position_id)
      DO UPDATE SET plan_id = EXCLUDED.plan_id, plan_entry_id = EXCLUDED.plan_entry_id,
        position_name_snapshot = EXCLUDED.position_name_snapshot, target_bales = EXCLUDED.target_bales,
        actual_bales = EXCLUDED.actual_bales, extra_bales = EXCLUDED.extra_bales,
        bonus_per_extra_bale = EXCLUDED.bonus_per_extra_bale, bonus_pool = EXCLUDED.bonus_pool,
        member_count = EXCLUDED.member_count, updated_at = NOW()
      RETURNING id
    `);
    const runId = Number(rows(runResult)[0]?.id);
    if (!runId) throw new Error("Could not create production bonus proposal");

    await executor.execute(sql`
      DELETE FROM factory_production_bonus_allocations
      WHERE run_id = ${runId} AND decision_status = 'PENDING'
    `);
    if (preview.bonusPool <= 0 || !preview.distributable) continue;

    for (const allocation of preview.allocations) {
      if (allocation.amount <= 0) continue;
      await executor.execute(sql`
        INSERT INTO factory_production_bonus_allocations (
          company_id, run_id, worker_id, worker_name_snapshot, amount,
          decision_status, created_at, updated_at
        ) VALUES (
          ${companyId}, ${runId}, ${allocation.workerId}, ${allocation.workerName},
          ${allocation.amount.toFixed(2)}, 'PENDING', NOW(), NOW()
        )
        ON CONFLICT (run_id, worker_id)
        DO UPDATE SET worker_name_snapshot = EXCLUDED.worker_name_snapshot,
          amount = EXCLUDED.amount, updated_at = NOW()
      `);
    }
  }
}

/**
 * Attach unclaimed allocations only to DRAFT payroll. If an APPROVED allocation
 * survived a deleted payroll, reattachment adds just that approved delta back to
 * total bonus/net and rebuilds the normal PAYROLL-GEN voucher. This preserves
 * transport and every other payroll component because net is adjusted by delta,
 * not reconstructed from a shortened formula.
 */
export async function attachProductionBonusesToPayroll(
  executor: DatabaseOrTransaction,
  payrollId: number
): Promise<void> {
  const payrollResult = await executor.execute(sql`
    SELECT id, company_id AS "companyId", worker_id AS "workerId",
           period_start::text AS "periodStart", period_end::text AS "periodEnd", status,
           bonuses::text AS bonuses, net_salary::text AS "netSalary"
    FROM factory_payrolls WHERE id = ${payrollId} LIMIT 1
  `);
  const payroll = rows(payrollResult)[0];
  if (!payroll) throw new Error("Payroll record not found");
  if (String(payroll.status) !== "DRAFT") return;

  const oldTotals = (await getProductionBonusTotalsForPayrollIds(executor, [payrollId])).get(payrollId) ?? EMPTY_TOTALS;
  await executor.execute(sql`
    UPDATE factory_production_bonus_allocations a
    SET payroll_id = ${payrollId}, updated_at = NOW()
    FROM factory_production_bonus_runs r
    WHERE a.run_id = r.id
      AND a.company_id = ${Number(payroll.companyId)}
      AND a.worker_id = ${Number(payroll.workerId)}
      AND a.payroll_id IS NULL
      AND r.production_date BETWEEN ${String(payroll.periodStart)}::date AND ${String(payroll.periodEnd)}::date
  `);
  const newTotals = (await getProductionBonusTotalsForPayrollIds(executor, [payrollId])).get(payrollId) ?? EMPTY_TOTALS;

  if (Math.abs(newTotals.approved - oldTotals.approved) > 0.0001) {
    const oldTotalBonus = Number(payroll.bonuses ?? 0);
    const otherBonus = Math.max(0, oldTotalBonus - oldTotals.approved);
    const newTotalBonus = Number((otherBonus + newTotals.approved).toFixed(2));
    const newNet = Number((Number(payroll.netSalary ?? 0) + (newTotalBonus - oldTotalBonus)).toFixed(2));
    await executor.execute(sql`
      UPDATE factory_payrolls
      SET bonuses = ${newTotalBonus.toFixed(2)}, net_salary = ${newNet.toFixed(2)}
      WHERE id = ${payrollId}
    `);
    await rebuildPayrollGenVoucher(
      executor,
      Number(payroll.companyId),
      String(payroll.periodStart),
      String(payroll.periodEnd)
    );
  }
}

export async function prepareProductionBonusesForPayroll(
  executor: DatabaseOrTransaction,
  payrollId: number
): Promise<void> {
  const payrollResult = await executor.execute(sql`
    SELECT company_id AS "companyId", period_start::text AS "periodStart",
           period_end::text AS "periodEnd", status
    FROM factory_payrolls WHERE id = ${payrollId} LIMIT 1
  `);
  const payroll = rows(payrollResult)[0];
  if (!payroll) throw new Error("Payroll record not found");
  if (String(payroll.status) !== "DRAFT") return;

  await syncProductionBonusProposalsForPeriod(
    executor,
    Number(payroll.companyId),
    String(payroll.periodStart),
    String(payroll.periodEnd)
  );
  await attachProductionBonusesToPayroll(executor, payrollId);
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

export async function getProductionBonusDetailsForPayroll(
  executor: DatabaseOrTransaction,
  payrollId: number
): Promise<{ totals: PayrollProductionBonusTotals; allocations: PayrollProductionBonusAllocationDetail[] }> {
  await prepareProductionBonusesForPayroll(executor, payrollId);
  const detailResult = await executor.execute(sql`
    SELECT a.id AS "allocationId", r.id AS "runId", r.production_date::text AS "productionDate",
      r.position_id AS "positionId", r.position_name_snapshot AS "positionName",
      r.target_bales AS "targetBales", r.actual_bales AS "actualBales", r.extra_bales AS "extraBales",
      r.bonus_per_extra_bale::text AS rate, r.bonus_pool::text AS "bonusPool", r.member_count AS "memberCount",
      a.worker_id AS "workerId", a.worker_name_snapshot AS "workerName", a.amount::text AS amount,
      a.decision_status AS "decisionStatus", a.decided_by AS "decidedBy",
      a.decided_at::text AS "decidedAt", a.decision_note AS "decisionNote"
    FROM factory_production_bonus_allocations a
    JOIN factory_production_bonus_runs r ON r.id = a.run_id
    WHERE a.payroll_id = ${payrollId}
    ORDER BY r.production_date, r.position_name_snapshot, a.worker_id
  `);
  const allocations = rows(detailResult).map((row) => ({
    allocationId: Number(row.allocationId),
    runId: Number(row.runId),
    productionDate: String(row.productionDate),
    positionId: Number(row.positionId),
    positionName: String(row.positionName),
    targetBales: Number(row.targetBales ?? 0),
    actualBales: Number(row.actualBales ?? 0),
    extraBales: Number(row.extraBales ?? 0),
    rate: Number(row.rate ?? 0),
    bonusPool: Number(row.bonusPool ?? 0),
    memberCount: Number(row.memberCount ?? 0),
    workerId: Number(row.workerId),
    workerName: String(row.workerName),
    amount: Number(row.amount ?? 0),
    decisionStatus: String(row.decisionStatus) as "PENDING" | "APPROVED" | "REJECTED",
    decidedBy: row.decidedBy == null ? null : String(row.decidedBy),
    decidedAt: row.decidedAt == null ? null : String(row.decidedAt),
    decisionNote: row.decisionNote == null ? null : String(row.decisionNote),
  }));
  const totals = (await getProductionBonusTotalsForPayrollIds(executor, [payrollId])).get(payrollId) ?? {
    ...EMPTY_TOTALS,
  };
  return { totals, allocations };
}

export async function updateProductionBonusRunStatuses(
  executor: DatabaseOrTransaction,
  runIds: number[]
): Promise<void> {
  for (const runId of [...new Set(runIds)]) {
    await executor.execute(sql`
      UPDATE factory_production_bonus_runs r
      SET status = CASE
        WHEN NOT EXISTS (SELECT 1 FROM factory_production_bonus_allocations a WHERE a.run_id = r.id) THEN 'PENDING'
        WHEN NOT EXISTS (SELECT 1 FROM factory_production_bonus_allocations a WHERE a.run_id = r.id AND a.decision_status <> 'APPROVED') THEN 'APPROVED'
        WHEN NOT EXISTS (SELECT 1 FROM factory_production_bonus_allocations a WHERE a.run_id = r.id AND a.decision_status <> 'REJECTED') THEN 'REJECTED'
        WHEN EXISTS (SELECT 1 FROM factory_production_bonus_allocations a WHERE a.run_id = r.id AND a.decision_status <> 'PENDING') THEN 'PARTIAL'
        ELSE 'PENDING'
      END,
      updated_at = NOW()
      WHERE r.id = ${runId}
    `);
  }
}
