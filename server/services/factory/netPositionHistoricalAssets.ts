/**
 * Phase 6: read-only historical Factory balance-sheet operational projections.
 * The live/current route remains the source of truth for today's totals.
 *
 * Rental contracts are evaluated as they existed by the selected date (not
 * their current ACTIVE status); worker advances are replayed from original
 * amount and dated individual repayments (not remaining_balance).
 */
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { factoryWorkerAdvances, factoryAdvanceRepayments, factoryPayrolls } from "@shared/schema";
import type { FactoryNetPositionAsOf } from "@shared/factoryNetPositionAsOf";
import { db } from "../../db";
import { MoneyDecimal } from "../../lib/money";
import { loadFactoryRowsKnownAt } from "./netPositionRowHistoryReader";
import {
  value,
  cents,
  recorded,
  factoryRentalAsOf,
  type HistoricalAssetLiabilityOperations,
  type DatedWorkerAdvance,
} from "./netPositionHistoricalAssetsHelpers";
export {
  sumRentalContractPositions,
  type HistoricalAssetLiabilityOperations,
  type DatedWorkerAdvance,
} from "./netPositionHistoricalAssetsHelpers";

/** A repayment cannot make the advance an asset with a negative balance. */
export function remainingAdvanceAt(amount: string | number, repayments: readonly (string | number)[]): number {
  const repaid = repayments.reduce((sum, n) => sum.plus(value(n)), new MoneyDecimal(0));
  return cents(MoneyDecimal.max(value(amount).minus(repaid), 0));
}

/**
 * Replay advances as the app's own reconcile does: original amount minus
 * linked repayments, then each payroll's advance deduction applied
 * oldest-first (settleAdvancesForPayroll and contract settlement reduce
 * remaining_balance that way without writing a repayment row).
 */
export function replayWorkerAdvances(
  advances: readonly DatedWorkerAdvance[],
  repaymentsByAdvance: ReadonlyMap<number, readonly string[]>,
  payrollDeductionsByWorker: ReadonlyMap<number, string>
): number {
  const byWorker = new Map<number, DatedWorkerAdvance[]>();
  for (const advance of advances) {
    const list = byWorker.get(advance.workerId) ?? [];
    list.push(advance);
    byWorker.set(advance.workerId, list);
  }
  let total = new MoneyDecimal(0);
  for (const [workerId, list] of byWorker) {
    // Salary-deduction advances are settled first, as on payroll generation.
    const ordered = [...list].sort(
      (a, b) =>
        Number(a.repaymentType !== "salary_deduction") - Number(b.repaymentType !== "salary_deduction") ||
        a.advanceDate.localeCompare(b.advanceDate) ||
        a.id - b.id
    );
    const balances = ordered.map((a) => value(remainingAdvanceAt(a.amount, repaymentsByAdvance.get(a.id) ?? [])));
    let deduction = value(payrollDeductionsByWorker.get(workerId) ?? "0");
    for (let i = 0; i < balances.length && deduction.gt(0); i++) {
      const applied = MoneyDecimal.min(balances[i], deduction);
      balances[i] = balances[i].minus(applied);
      deduction = deduction.minus(applied);
    }
    for (const balance of balances) total = total.plus(balance);
  }
  return cents(total);
}

/**
 * Restore advance amounts, repayments and payroll deductions as actually
 * recorded at the selected day. Used only after ALL three baselines exist.
 * Prior dates retain the original event-date replay and explicit limitation.
 */
async function recordedWorkerAdvancesAsOf(
  companyId: number,
  scope: FactoryNetPositionAsOf
): Promise<{ value: number; warnings: string[] } | null> {
  const [advances, repayments, payrolls] = await Promise.all([
    loadFactoryRowsKnownAt("factory_worker_advances", companyId, scope),
    loadFactoryRowsKnownAt("factory_advance_repayments", companyId, scope),
    loadFactoryRowsKnownAt("factory_payrolls", companyId, scope),
  ]);
  if (!advances.ready || !repayments.ready || !payrolls.ready) return null;
  const selected = [...advances.rows.values()]
    .filter((r) => r.deleted_at == null && String(r.advance_date ?? "").slice(0, 10) <= scope.asOf)
    .map((r) => ({
      id: Number(r.id),
      workerId: Number(r.worker_id),
      amount: String(r.amount ?? "0"),
      advanceDate: String(r.advance_date).slice(0, 10),
      repaymentType: String(r.repayment_type ?? ""),
    }));
  if (selected.some((r) => !Number.isSafeInteger(r.id) || !Number.isSafeInteger(r.workerId))) {
    throw new Error("HISTORICAL_WORKER_ADVANCE_ROW_INVALID");
  }
  const activeIds = new Set(selected.map((r) => r.id));
  const workers = new Set(selected.map((r) => r.workerId));
  const byAdvance = new Map<number, string[]>();
  const payrollsWithRepayments = new Set<number>();
  for (const r of repayments.rows.values()) {
    if (r.deleted_at != null || String(r.repayment_date ?? "").slice(0, 10) > scope.asOf) continue;
    const payrollId = Number(r.payroll_id);
    if (Number.isSafeInteger(payrollId) && payrollId > 0) payrollsWithRepayments.add(payrollId);
    const id = Number(r.advance_id);
    if (!activeIds.has(id)) continue;
    const bucket = byAdvance.get(id) ?? [];
    bucket.push(String(r.amount ?? "0"));
    byAdvance.set(id, bucket);
  }
  const deductions = new Map<number, string>();
  for (const r of payrolls.rows.values()) {
    const id = Number(r.id);
    const workerId = Number(r.worker_id);
    if (
      r.deleted_at != null ||
      !workers.has(workerId) ||
      payrollsWithRepayments.has(id) ||
      String(r.period_start ?? "").slice(0, 10) > scope.asOf
    )
      continue;
    const deduction = value(r.advances as string | number | null | undefined);
    if (deduction.lte(0)) continue;
    deductions.set(
      workerId,
      value(deductions.get(workerId) ?? "0")
        .plus(deduction)
        .toFixed()
    );
  }
  return { value: replayWorkerAdvances(selected, byAdvance, deductions), warnings: [] };
}

async function factoryWorkerAdvancesAsOf(companyId: number, scope: FactoryNetPositionAsOf) {
  const recordedAdvances = await recordedWorkerAdvancesAsOf(companyId, scope);
  if (recordedAdvances) return recordedAdvances;
  const advances = await db
    .select({
      id: factoryWorkerAdvances.id,
      workerId: factoryWorkerAdvances.workerId,
      amount: factoryWorkerAdvances.amount,
      advanceDate: factoryWorkerAdvances.advanceDate,
      repaymentType: factoryWorkerAdvances.repaymentType,
    })
    .from(factoryWorkerAdvances)
    .where(
      and(
        eq(factoryWorkerAdvances.companyId, companyId),
        lte(factoryWorkerAdvances.advanceDate, scope.asOf),
        recorded(sql`${factoryWorkerAdvances.createdAt}`, scope)
      )
    );
  if (!advances.length) return { value: 0, warnings: [] as string[] };

  const ids = advances.map((a) => a.id);
  const workerIds = [...new Set(advances.map((a) => a.workerId))];
  const [repayments, payrolls] = await Promise.all([
    db
      .select({
        advanceId: factoryAdvanceRepayments.advanceId,
        amount: factoryAdvanceRepayments.amount,
      })
      .from(factoryAdvanceRepayments)
      .where(
        and(
          eq(factoryAdvanceRepayments.companyId, companyId),
          inArray(factoryAdvanceRepayments.advanceId, ids),
          lte(factoryAdvanceRepayments.repaymentDate, scope.asOf),
          recorded(sql`${factoryAdvanceRepayments.createdAt}`, scope)
        )
      ),
    // Payroll deductions with no repayment row of their own (a payroll whose
    // deduction WAS written as repayment rows is already counted above).
    db
      .select({
        workerId: factoryPayrolls.workerId,
        advances: factoryPayrolls.advances,
      })
      .from(factoryPayrolls)
      .where(
        and(
          eq(factoryPayrolls.companyId, companyId),
          inArray(factoryPayrolls.workerId, workerIds),
          sql`COALESCE(${factoryPayrolls.advances}, 0) > 0`,
          lte(factoryPayrolls.periodStart, scope.asOf),
          recorded(sql`${factoryPayrolls.createdAt}`, scope),
          sql`NOT EXISTS (SELECT 1 FROM factory_advance_repayments r
                       WHERE r.company_id = ${companyId} AND r.payroll_id = ${factoryPayrolls.id})`
        )
      ),
  ]);
  const byAdvance = new Map<number, string[]>();
  for (const repayment of repayments) {
    const values = byAdvance.get(repayment.advanceId) ?? [];
    values.push(String(repayment.amount));
    byAdvance.set(repayment.advanceId, values);
  }
  const deductions = new Map<number, string>();
  for (const payroll of payrolls) {
    deductions.set(
      payroll.workerId,
      value(deductions.get(payroll.workerId) ?? "0")
        .plus(value(payroll.advances))
        .toFixed()
    );
  }
  return {
    value: replayWorkerAdvances(
      advances.map((a) => ({ ...a, amount: String(a.amount), advanceDate: String(a.advanceDate) })),
      byAdvance,
      deductions
    ),
    // Legacy updates, deletion of repayment/payroll rows and advance amount
    // amendments do not retain prior row versions. Do not assert completeness.
    warnings: ["HISTORICAL_WORKER_ADVANCE_EDITS_UNVERSIONED"],
  };
}

export async function computeHistoricalFactoryAssetLiabilityOperations(
  companyId: number,
  scope: FactoryNetPositionAsOf
): Promise<HistoricalAssetLiabilityOperations> {
  try {
    const [workerAdvances, rental] = await Promise.all([
      factoryWorkerAdvancesAsOf(companyId, scope),
      factoryRentalAsOf(companyId, scope),
    ]);
    return {
      workerAdvancesValue: workerAdvances.value,
      prepaidRent: rental.prepaidRent,
      rentPayable: rental.rentPayable,
      warnings: [...new Set([...workerAdvances.warnings, ...rental.warnings])],
    };
  } catch (cause) {
    throw new Error("HISTORICAL_NET_POSITION_ASSETS_FAILED", { cause });
  }
}
