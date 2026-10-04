/**
 * employeeCrudRoutes: FactoryEmployeeRecalculate endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../../lib/httpHandlers";
import { logger } from "../../../../lib/logger";
import { db } from "../../../../db";
import { requireAuth } from "../../../../auth";
import { employees } from "@shared/schema";
import { eq, and, sql } from "drizzle-orm";
import { firstRow, resultRows } from "../../../../lib/queryResult";

export function registerFactoryEmployeeRecalculateRoutes(app: Express) {
  // POST /api/factory/employees/recalculate-balances
  // Rebuilds currentBalance, totalDeposits, totalWithdrawals for every employee from surviving voucher entries.
  // Useful after deletions that didn't reverse balances (legacy bug).
  app.post("/api/factory/employees/recalculate-balances", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const role = (req.session.currentRole || req.session.role || "").toLowerCase();
      if (role !== "admin" && role !== "owner" && role !== "developer") {
        return res.status(403).json({ message: "Only Admin or Owner can recalculate balances" });
      }

      // Get all employees for this company
      const allEmployees = await db
        .select()
        .from(employees)
        .where(
          and(
            eq(employees.companyId, companyId),
            eq(employees.employeeType, "Employee"),
            sql`${employees.deletedAt} IS NULL`
          )
        );

      if (allEmployees.length === 0) return res.json({ updated: 0, employees: [] });

      // For each employee, sum voucher entry credits and debits from non-deleted vouchers
      // Join through employees table to avoid passing an array parameter to ANY()
      const entrySums = await db.execute(sql`
        SELECT
          ve.employee_id,
          COALESCE(SUM(ve.credit_amount::numeric), 0) AS total_credits,
          COALESCE(SUM(ve.debit_amount::numeric), 0)  AS total_debits
        FROM voucher_entries ve
        INNER JOIN vouchers v ON v.id = ve.voucher_id
        INNER JOIN employees e ON e.id = ve.employee_id
        WHERE e.company_id = ${companyId}
          AND e.employee_type = 'Employee'
          AND e.deleted_at IS NULL
          AND v.deleted_at IS NULL
          AND v.optional = false
        GROUP BY ve.employee_id
      `);

      // Build a map: empId → { totalCredits, totalDebits }
      const sumMap = new Map<number, { credits: number; debits: number }>();
      for (const row of resultRows<{ employee_id: number; total_credits: string | null; total_debits: string | null }>(
        entrySums
      )) {
        const empId = Number(row.employee_id);
        sumMap.set(empId, {
          credits: parseFloat(row.total_credits || "0"),
          debits: parseFloat(row.total_debits || "0"),
        });
      }

      const results = [];
      for (const emp of allEmployees) {
        const sums = sumMap.get(emp.id) || { credits: 0, debits: 0 };
        const openingBal = parseFloat(emp.openingBalance || "0");
        const newBalance = openingBal + sums.credits - sums.debits;
        const newDeposits = sums.credits;
        const newWithdrawals = sums.debits;

        await db
          .update(employees)
          .set({
            currentBalance: newBalance.toFixed(2),
            totalDeposits: newDeposits.toFixed(2),
            totalWithdrawals: newWithdrawals.toFixed(2),
          })
          .where(eq(employees.id, emp.id));

        results.push({
          id: emp.id,
          name: `${emp.firstName} ${emp.lastName}`,
          oldBalance: parseFloat(emp.currentBalance || "0"),
          newBalance,
          newDeposits,
          newWithdrawals,
        });
      }

      res.json({ updated: results.length, employees: results });
    } catch (error: unknown) {
      logger.error("Error recalculating employee balances:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // POST /api/factory/employees/:id/recalculate-balance
  // Rebuilds currentBalance, totalDeposits, totalWithdrawals for a single employee from surviving voucher entries.
  app.post("/api/factory/employees/:id/recalculate-balance", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const empId = parseInt(req.params.id);

      const [emp] = await db
        .select()
        .from(employees)
        .where(and(eq(employees.id, empId), eq(employees.companyId, companyId), sql`${employees.deletedAt} IS NULL`));
      if (!emp) return res.status(404).json({ message: "Employee not found" });

      const entrySums = await db.execute(sql`
        SELECT
          COALESCE(SUM(ve.credit_amount::numeric), 0) AS total_credits,
          COALESCE(SUM(ve.debit_amount::numeric), 0)  AS total_debits
        FROM voucher_entries ve
        INNER JOIN vouchers v ON v.id = ve.voucher_id
        WHERE ve.employee_id = ${empId}
          AND v.deleted_at IS NULL
          AND v.optional = false
      `);

      const row = firstRow<{ total_credits: string | null; total_debits: string | null }>(entrySums);
      const credits = parseFloat(row?.total_credits || "0");
      const debits = parseFloat(row?.total_debits || "0");
      const openingBal = parseFloat(emp.openingBalance || "0");
      const newBalance = openingBal + credits - debits;
      const newDeposits = credits;
      const newWithdrawals = debits;

      await db
        .update(employees)
        .set({
          currentBalance: newBalance.toFixed(2),
          totalDeposits: newDeposits.toFixed(2),
          totalWithdrawals: newWithdrawals.toFixed(2),
        })
        .where(eq(employees.id, empId));

      res.json({
        id: emp.id,
        name: `${emp.firstName} ${emp.lastName}`,
        oldBalance: parseFloat(emp.currentBalance || "0"),
        newBalance,
        newDeposits,
        newWithdrawals,
      });
    } catch (error: unknown) {
      logger.error("Error recalculating employee balance:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
