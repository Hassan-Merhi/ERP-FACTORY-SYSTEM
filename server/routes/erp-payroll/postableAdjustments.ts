/**
 * Shared by the bulk payroll routes (bonus, withdrawal, salary deposit).
 */
import { and, eq, inArray } from "drizzle-orm";
import { employees } from "@shared/schema";
import { db } from "../../db";
import { parseMoneyInput } from "../../lib/money";

/**
 * The bulk rows that will actually post: a positive amount, taken at cents, for
 * an employee of the active company. Rows for another company's employee used
 * to be counted in the voucher total and the other leg and only then skipped,
 * which left the voucher unbalanced.
 */
export async function postableAdjustments(rows: Array<{ employeeId: number; amount: unknown }>, companyId: number) {
  const parsed = rows.flatMap((row) => {
    const amount = parseMoneyInput(row.amount);
    return amount && amount.gt(0) ? [{ employeeId: row.employeeId, amount: amount.toDecimalPlaces(2) }] : [];
  });
  const ids = Array.from(new Set(parsed.map((row) => Number(row.employeeId)).filter(Number.isInteger)));
  const companyEmployees =
    ids.length > 0
      ? await db
          .select()
          .from(employees)
          .where(and(inArray(employees.id, ids), eq(employees.companyId, companyId)))
      : [];
  const byId = new Map(companyEmployees.map((employee) => [employee.id, employee]));
  return parsed.flatMap((row) => {
    const employee = byId.get(Number(row.employeeId));
    return employee ? [{ employee, amount: row.amount }] : [];
  });
}
