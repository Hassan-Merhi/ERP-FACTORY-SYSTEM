import { pool } from "../db";
import { logger } from "../lib/logger";
import type { ManagedEmployeeAdvance } from "./employeeNetPosition";

type AdvanceRow = {
  employee_id: number | string;
  posted_debit: string | number | null;
  remaining_balance: string | number | null;
};

function parseRows(rows: AdvanceRow[]): ManagedEmployeeAdvance[] {
  return rows.map((row) => ({
    employeeId: Number(row.employee_id),
    postedDebit: Number.parseFloat(String(row.posted_debit ?? "0")) || 0,
    remainingBalance: Number.parseFloat(String(row.remaining_balance ?? "0")) || 0,
  }));
}

function postedAdvanceSql(baseColumns: boolean, historical: boolean): string {
  const postedDebit = baseColumns
    ? "COALESCE(ve.base_debit_amount, ve.debit_amount)"
    : "ve.debit_amount";
  const advanceDateClause = historical ? "AND sa.advance_date <= $3" : "";
  const voucherDateClause = historical ? "AND v.voucher_date <= $3" : "";

  if (!historical) {
    return `
      WITH posted AS (
        SELECT
          sa.id AS salary_advance_id,
          COALESCE(SUM(${postedDebit}::numeric), 0) AS posted_debit
        FROM salary_advances sa
        JOIN vouchers v
          ON v.id = sa.voucher_id
         AND v.company_id = $1
         AND v.optional = false
         AND v.deleted_at IS NULL
        JOIN voucher_entries ve
          ON ve.voucher_id = v.id
         AND ve.employee_id = sa.employee_id
        WHERE sa.company_id = $1
        GROUP BY sa.id
      )
      SELECT
        sa.employee_id,
        COALESCE(p.posted_debit, 0)::text AS posted_debit,
        COALESCE(sa.remaining_balance, 0)::text AS remaining_balance
      FROM salary_advances sa
      LEFT JOIN posted p ON p.salary_advance_id = sa.id
      WHERE sa.company_id = $1
    `;
  }

  return `
    WITH deduction_totals AS (
      SELECT
        salary_advance_id,
        COALESCE(SUM(deduction_amount::numeric), 0) AS deduction_total
      FROM salary_advance_deductions
      WHERE payroll_month <= $2
      GROUP BY salary_advance_id
    ),
    posted AS (
      SELECT
        sa.id AS salary_advance_id,
        COALESCE(SUM(${postedDebit}::numeric), 0) AS posted_debit
      FROM salary_advances sa
      JOIN vouchers v
        ON v.id = sa.voucher_id
       AND v.company_id = $1
       AND v.optional = false
       AND v.deleted_at IS NULL
       ${voucherDateClause}
      JOIN voucher_entries ve
        ON ve.voucher_id = v.id
       AND ve.employee_id = sa.employee_id
      WHERE sa.company_id = $1
        ${advanceDateClause}
      GROUP BY sa.id
    )
    SELECT
      sa.employee_id,
      COALESCE(p.posted_debit, 0)::text AS posted_debit,
      GREATEST(
        COALESCE(sa.amount, 0)::numeric - COALESCE(d.deduction_total, 0),
        0
      )::text AS remaining_balance
    FROM salary_advances sa
    LEFT JOIN posted p ON p.salary_advance_id = sa.id
    LEFT JOIN deduction_totals d ON d.salary_advance_id = sa.id
    WHERE sa.company_id = $1
      ${advanceDateClause}
  `;
}

/**
 * Return the managed salary-advance portion of the employee subledger.
 *
 * For current snapshots, remaining_balance is authoritative.
 * For historical snapshots, reconstruct remaining balance from the original
 * advance less deductions through the requested payroll month.
 */
export async function loadSalaryAdvanceNetPositionAdjustments(
  companyId: number,
  toDate?: string | null
): Promise<ManagedEmployeeAdvance[]> {
  const historical = Boolean(toDate);
  const params = historical ? [companyId, String(toDate).slice(0, 7), toDate] : [companyId];

  try {
    const result = await pool.query<AdvanceRow>(postedAdvanceSql(true, historical), params);
    return parseRows(result.rows);
  } catch {
    try {
      const result = await pool.query<AdvanceRow>(postedAdvanceSql(false, historical), params);
      return parseRows(result.rows);
    } catch (error: unknown) {
      logger.warn("[salary-advance-net-position] managed advance query skipped", {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }
}
