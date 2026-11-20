/**
 * Recomputes every salary advance balance of a company from its manual
 * deductions and the advance deductions of PAID ERP payroll runs (FIFO per
 * employee). Extracted unchanged from the POST /api/salary-advances/reconcile
 * handler in ./salaryAdvanceRoutes.ts.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type Decimal from "decimal.js";

import { db } from "../../db";
import { MoneyDecimal, toMoney } from "../../lib/money";
import { erpPayrollRunItems, erpPayrollRuns, salaryAdvanceDeductions, salaryAdvances } from "@shared/schema";

/** An advance is paid off only when nothing is left at cents. */
export function isPaidOff(remaining: Decimal): boolean {
  return !remaining.toDecimalPlaces(2).greaterThan(0);
}

/** Returns how many advances were corrected. */
export async function reconcileSalaryAdvanceBalances(companyId: number): Promise<number> {
  const allAdvances = await db
    .select()
    .from(salaryAdvances)
    .where(eq(salaryAdvances.companyId, companyId))
    .orderBy(salaryAdvances.employeeId, salaryAdvances.advanceDate);
  const allManualDeductions = await db
    .select()
    .from(salaryAdvanceDeductions)
    .where(
      allAdvances.length
        ? inArray(
            salaryAdvanceDeductions.salaryAdvanceId,
            allAdvances.map((advance) => advance.id)
          )
        : sql`false`
    );
  const manualByAdvance = new Map<number, Decimal>();
  for (const deduction of allManualDeductions) {
    manualByAdvance.set(
      deduction.salaryAdvanceId,
      (manualByAdvance.get(deduction.salaryAdvanceId) ?? new MoneyDecimal(0)).plus(toMoney(deduction.deductionAmount))
    );
  }
  const paidRuns = await db
    .select({ id: erpPayrollRuns.id })
    .from(erpPayrollRuns)
    .where(and(eq(erpPayrollRuns.companyId, companyId), eq(erpPayrollRuns.status, "PAID")));
  const payrollByEmployee = new Map<number, Decimal>();
  if (paidRuns.length) {
    const items = await db
      .select({ employeeId: erpPayrollRunItems.employeeId, deduction: erpPayrollRunItems.deduction })
      .from(erpPayrollRunItems)
      .where(
        inArray(
          erpPayrollRunItems.runId,
          paidRuns.map((run) => run.id)
        )
      );
    for (const item of items) {
      const amount = toMoney(item.deduction);
      if (amount.greaterThan(0) && item.employeeId) {
        payrollByEmployee.set(
          item.employeeId,
          (payrollByEmployee.get(item.employeeId) ?? new MoneyDecimal(0)).plus(amount)
        );
      }
    }
  }
  const grouped = new Map<number, typeof allAdvances>();
  for (const advance of allAdvances)
    grouped.set(advance.employeeId, [...(grouped.get(advance.employeeId) || []), advance]);

  let fixed = 0;
  await db.transaction(async (tx) => {
    for (const [employeeId, advances] of grouped) {
      const balances = advances.map((advance) => ({
        id: advance.id,
        balance: MoneyDecimal.max(
          0,
          toMoney(advance.amount).minus(manualByAdvance.get(advance.id) ?? new MoneyDecimal(0))
        ),
      }));
      let payrollRemaining: Decimal = payrollByEmployee.get(employeeId) ?? new MoneyDecimal(0);
      for (const entry of balances) {
        if (!payrollRemaining.greaterThan(0)) break;
        const deduction = MoneyDecimal.min(entry.balance, payrollRemaining);
        entry.balance = entry.balance.minus(deduction);
        payrollRemaining = payrollRemaining.minus(deduction);
      }
      for (let index = 0; index < advances.length; index++) {
        const advance = advances[index];
        const newBalance = MoneyDecimal.max(0, balances[index].balance).toDecimalPlaces(2);
        const fullyPaid = isPaidOff(newBalance);
        // Any difference at cents is corrected (a 0.01 drift used to be left in place).
        if (
          !toMoney(advance.remainingBalance).toDecimalPlaces(2).equals(newBalance) ||
          advance.fullyPaid !== fullyPaid
        ) {
          await tx
            .update(salaryAdvances)
            .set({ remainingBalance: newBalance.toFixed(2), fullyPaid })
            .where(eq(salaryAdvances.id, advance.id));
          fixed++;
        }
      }
    }
  });
  return fixed;
}
