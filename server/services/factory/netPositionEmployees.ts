/**
 * Read-only Employee balance projection for Factory Net Position.
 *
 * Current-date rows deliberately preserve employees.current_balance (the
 * payroll page's source). Historic rows are reconstructed from the employee
 * opening and voucher entries, using the SAME credit-minus-debit sign rule as
 * employeeBalancePosting.ts. Never reverse today's cache to infer yesterday.
 *
 * Legacy EMP-<code> voucher entries were historically applied to the employee
 * cache by code when employee_id was absent. Count those once as well; the
 * caller excludes these mapped legacy ledger accounts from historical ledger
 * classification to avoid double counting.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { employees } from "@shared/schema";
import type { FactoryNetPositionAsOf } from "@shared/factoryNetPositionAsOf";
import { db } from "../../db";
import { MoneyDecimal, toMoney } from "../../lib/money";
import { resultRows } from "../../lib/queryResult";
import {
  netPositionKnownTransactionThrough,
  netPositionRecordedThrough,
  netPositionVoucherEntryKnown,
} from "./netPositionAsOf";

export interface FactoryNetPositionEmployee {
  id: number;
  name: string;
  code: string;
  balance: number; // Cr positive = payroll owed; Dr negative = employee receivable
}

export async function loadFactoryNetPositionEmployees(
  companyId: number,
  scope: FactoryNetPositionAsOf
): Promise<FactoryNetPositionEmployee[]> {
  if (!scope.isHistorical) {
    const rows = await db
      .select({
        id: employees.id,
        firstName: employees.firstName,
        lastName: employees.lastName,
        code: employees.code,
        currentBalance: employees.currentBalance,
      })
      .from(employees)
      .where(
        and(
          eq(employees.companyId, companyId),
          eq(employees.employeeType, "Employee"),
          eq(employees.active, true),
          isNull(employees.deletedAt)
        )
      )
      .orderBy(employees.firstName, employees.lastName, employees.id);
    return rows.map((e) => ({
      id: e.id,
      name: [e.firstName, e.lastName].filter(Boolean).join(" ").trim(),
      code: e.code,
      balance: toMoney(e.currentBalance).toDecimalPlaces(2).toNumber(),
    }));
  }

  const voucherKnown = netPositionKnownTransactionThrough(
    sql`COALESCE(v.effective_date, v.voucher_date)`,
    sql`v.created_at`,
    scope,
    "utc-naive-timestamp"
  );
  const entryKnown = netPositionVoucherEntryKnown(sql`ve.created_at`, sql`ve.voucher_id`, scope);
  const employeeKnown = netPositionRecordedThrough(sql`e.created_at`, scope, "utc-naive-timestamp");
  const employeeNotYetDeleted = sql`(e.deleted_at IS NULL OR NOT ${netPositionRecordedThrough(sql`e.deleted_at`, scope, "utc-naive-timestamp")})`;

  const rows = resultRows<{
    id: number;
    first_name: string;
    last_name: string;
    code: string;
    opening: string;
    movement: string;
  }>(
    await db.execute(sql`
    WITH eligible_entries AS (
      SELECT COALESCE(ve.employee_id, legacy_employee.id) AS employee_id,
             COALESCE(ve.credit_amount, 0)::numeric - COALESCE(ve.debit_amount, 0)::numeric AS movement
        FROM voucher_entries ve
        JOIN vouchers v ON v.id = ve.voucher_id
        LEFT JOIN ledger_accounts la
          ON la.id = ve.ledger_account_id AND la.company_id = ${companyId}
        LEFT JOIN employees legacy_employee
          ON ve.employee_id IS NULL
         AND legacy_employee.company_id = ${companyId}
         AND la.code = 'EMP-' || legacy_employee.code
       WHERE v.company_id = ${companyId}
         AND v.optional = false
         AND (v.deleted_at IS NULL OR NOT ${netPositionRecordedThrough(sql`v.deleted_at`, scope, "utc-naive-timestamp")})
         AND ${voucherKnown}
         AND ${entryKnown}
    ),
    sums AS (
      SELECT employee_id, SUM(movement) AS movement
        FROM eligible_entries
       WHERE employee_id IS NOT NULL
       GROUP BY employee_id
    )
    SELECT e.id, e.first_name, e.last_name, e.code,
           COALESCE(e.opening_balance, 0)::text AS opening,
           COALESCE(sums.movement, 0)::text AS movement
      FROM employees e
      LEFT JOIN sums ON sums.employee_id = e.id
     WHERE e.company_id = ${companyId}
       AND e.employee_type = 'Employee'
       -- Same population as today: the active flag has no dated history.
       AND e.active = true
       AND e.join_date <= ${scope.asOf}::date
       AND ${employeeKnown}
       AND ${employeeNotYetDeleted}
     ORDER BY e.first_name, e.last_name, e.id
  `)
  );

  return rows.map((e) => ({
    id: Number(e.id),
    name: [e.first_name, e.last_name].filter(Boolean).join(" ").trim(),
    code: e.code,
    balance: toMoney(e.opening).plus(toMoney(e.movement)).toDecimalPlaces(2, MoneyDecimal.ROUND_HALF_UP).toNumber(),
  }));
}
