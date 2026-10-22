/**
 * Phase 6: read-only historical Factory balance-sheet operational projections.
 * The live/current route remains the source of truth for today's totals.
 *
 * Rental contracts are evaluated as they existed by the selected date (not
 * their current ACTIVE status); worker advances are replayed from original
 * amount and dated individual repayments (not remaining_balance).
 */
import { and, eq, inArray, lte, sql, type SQL } from "drizzle-orm";
import {
  propertyContracts,
  propertyMonthlyLedger,
  propertyPayments,
  propertyUnits,
  factoryWorkerAdvances,
  factoryAdvanceRepayments,
  factoryPayrolls,
} from "@shared/schema";
import type { FactoryNetPositionAsOf } from "@shared/factoryNetPositionAsOf";
import { db } from "../../db";
import { MoneyDecimal, toMoney } from "../../lib/money";
import { getRentalBillingDay, getRentalPeriodDueDate } from "../rental/rentalPeriodService";
import { netPositionRecordedThrough } from "./netPositionAsOf";

const value = (v: string | number | null | undefined) => toMoney(v);
const cents = (v: InstanceType<typeof MoneyDecimal>) => v.toDecimalPlaces(2, MoneyDecimal.ROUND_HALF_UP).toNumber();
const recorded = (column: SQL, scope: FactoryNetPositionAsOf) =>
  netPositionRecordedThrough(column, scope, "utc-naive-timestamp");

export type HistoricalAssetLiabilityOperations = {
  workerAdvancesValue: number;
  prepaidRent: number;
  rentPayable: number;
  warnings: string[];
};

/** Preserve the live Factory report's per-contract absolute-balance rule. */
export function sumRentalContractPositions(positions: readonly { expected: string; paid: string }[]): number {
  return cents(
    positions.reduce((sum, p) => sum.plus(value(p.expected).minus(value(p.paid)).abs()), new MoneyDecimal(0))
  );
}

/** A repayment cannot make the advance an asset with a negative balance. */
export function remainingAdvanceAt(amount: string | number, repayments: readonly (string | number)[]): number {
  const repaid = repayments.reduce((sum, n) => sum.plus(value(n)), new MoneyDecimal(0));
  return cents(MoneyDecimal.max(value(amount).minus(repaid), 0));
}

export type DatedWorkerAdvance = {
  id: number;
  workerId: number;
  amount: string;
  advanceDate: string;
  repaymentType: string;
};

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

async function factoryWorkerAdvancesAsOf(companyId: number, scope: FactoryNetPositionAsOf) {
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

async function factoryRentalAsOf(companyId: number, scope: FactoryNetPositionAsOf) {
  const units = await db
    .select({ id: propertyUnits.id, active: propertyUnits.active })
    .from(propertyUnits)
    .where(
      and(
        eq(propertyUnits.companyId, companyId),
        eq(propertyUnits.module, "FACTORY"),
        recorded(sql`${propertyUnits.createdAt}`, scope)
      )
    );
  if (!units.length) return { value: 0, warnings: [] as string[] };

  // Today's report counts ACTIVE contracts on active units. Neither flag has
  // a dated history, so a contract that is no longer ACTIVE is counted only
  // while its own term still covered the selected date; one that ended (or
  // has no end date) before then is excluded as it is today.
  const activeUnitIds = new Set(units.filter((u) => u.active).map((u) => u.id));
  const allContracts = await db
    .select({
      id: propertyContracts.id,
      unitId: propertyContracts.unitId,
      startDate: propertyContracts.startDate,
      endDate: propertyContracts.endDate,
      status: propertyContracts.status,
    })
    .from(propertyContracts)
    .where(
      and(
        eq(propertyContracts.companyId, companyId),
        eq(propertyContracts.module, "FACTORY"),
        inArray(
          propertyContracts.unitId,
          units.map((u) => u.id)
        ),
        lte(propertyContracts.startDate, scope.asOf),
        recorded(sql`${propertyContracts.createdAt}`, scope)
      )
    );
  const contracts = allContracts.filter((c) =>
    c.status === "ACTIVE" ? activeUnitIds.has(c.unitId) : c.endDate != null && String(c.endDate) >= scope.asOf
  );
  if (!contracts.length) return { value: 0, warnings: [] as string[] };
  const ids = contracts.map((c) => c.id);
  const [ledger, payments] = await Promise.all([
    db
      .select({
        contractId: propertyMonthlyLedger.contractId,
        year: propertyMonthlyLedger.year,
        month: propertyMonthlyLedger.month,
        expectedAmount: propertyMonthlyLedger.expectedAmount,
      })
      .from(propertyMonthlyLedger)
      .where(
        and(
          eq(propertyMonthlyLedger.companyId, companyId),
          eq(propertyMonthlyLedger.module, "FACTORY"),
          inArray(propertyMonthlyLedger.contractId, ids),
          recorded(sql`${propertyMonthlyLedger.createdAt}`, scope)
        )
      ),
    db
      .select({
        contractId: propertyPayments.contractId,
        amount: propertyPayments.amount,
        status: propertyPayments.postingStatus,
        createdAt: propertyPayments.createdAt,
        postedAt: propertyPayments.postedAt,
      })
      .from(propertyPayments)
      .where(
        and(
          eq(propertyPayments.companyId, companyId),
          eq(propertyPayments.module, "FACTORY"),
          inArray(propertyPayments.contractId, ids),
          lte(propertyPayments.paymentDate, scope.asOf),
          recorded(sql`${propertyPayments.createdAt}`, scope),
          // For scheduled rows that were posted later, created_at is not enough.
          sql`(${propertyPayments.postedAt} IS NULL OR ${recorded(sql`${propertyPayments.postedAt}`, scope)})`
        )
      ),
  ]);
  const warnings = new Set<string>();
  warnings.add("HISTORICAL_RENT_EXPECTED_AMOUNTS_UNVERSIONED");
  // Status ACTIVE/EXPIRED/CANCELLED is mutable with no reliable transition
  // timestamps. Even currently ACTIVE contracts may have been reopened.
  warnings.add("HISTORICAL_RENT_CONTRACT_STATUS_UNVERSIONED");
  const sums = new Map<
    number,
    { expected: InstanceType<typeof MoneyDecimal>; paid: InstanceType<typeof MoneyDecimal> }
  >();
  for (const contract of contracts) sums.set(contract.id, { expected: new MoneyDecimal(0), paid: new MoneyDecimal(0) });
  const billingDays = new Map(contracts.map((c) => [c.id, getRentalBillingDay(c.startDate)]));
  for (const row of ledger) {
    const due = getRentalPeriodDueDate(row.year, row.month, billingDays.get(row.contractId)!);
    if (due > scope.asOf) continue;
    const sumsRow = sums.get(row.contractId);
    if (sumsRow) sumsRow.expected = sumsRow.expected.plus(value(row.expectedAmount));
  }
  for (const payment of payments) {
    if (payment.status !== "POSTED") {
      if (payment.status === "VOID") warnings.add("HISTORICAL_RENT_VOID_DATE_UNAVAILABLE");
      continue;
    }
    if (!payment.postedAt) warnings.add("HISTORICAL_RENT_POSTING_TIMESTAMP_MISSING");
    const sumsRow = sums.get(payment.contractId);
    if (sumsRow) sumsRow.paid = sumsRow.paid.plus(value(payment.amount));
  }
  const prepaidRent = sumRentalContractPositions(
    [...sums.values()].map((row) => ({
      expected: row.expected.toFixed(),
      paid: row.paid.toFixed(),
    }))
  );
  // Today's Factory report labels outstanding + tenant credits as a single
  // "Prepaid Rent" asset, with no extra Rent Payable liability.
  return { value: prepaidRent, warnings: [...warnings] };
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
      prepaidRent: rental.value,
      rentPayable: 0,
      warnings: [...new Set([...workerAdvances.warnings, ...rental.warnings])],
    };
  } catch (cause) {
    throw new Error("HISTORICAL_NET_POSITION_ASSETS_FAILED", { cause });
  }
}
