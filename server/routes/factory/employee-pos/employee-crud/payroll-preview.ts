/**
 * employeeCrudRoutes: FactoryEmployeePayrollPreview endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../../lib/httpHandlers";
import { db, type RawQueryRow } from "../../../../db";
import { requireAuth } from "../../../../auth";
import { employees } from "@shared/schema";
import { eq, and, sql } from "drizzle-orm";
import { sqlArray } from "../../../../lib/sqlArray";
import { toFiniteNumber, toPositiveInteger } from "@shared/typeGuards";

/**
 * Outstanding advance balance per employee. `SUM(numeric)` comes back as a
 * string, and the grouped id as whatever the driver maps int4 to, so both are
 * validated rather than coerced.
 */
interface AdvanceBalanceRow {
  employee_id: number | string | null;
  total_balance: string | null;
}

export function registerFactoryEmployeePayrollPreviewRoutes(app: Express) {
  // GET /api/factory/employee-payroll-preview?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
  // Returns attendance-based salary calculation for each active employee
  app.get("/api/factory/employee-payroll-preview", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const { startDate, endDate } = req.query as { startDate?: string; endDate?: string };
      if (!startDate || !endDate) return res.status(400).json({ message: "startDate and endDate are required" });

      const emps = await db
        .select()
        .from(employees)
        .where(
          and(
            eq(employees.companyId, companyId),
            eq(employees.employeeType, "Employee"),
            eq(employees.active, true),
            sql`${employees.deletedAt} IS NULL`
          )
        )
        .orderBy(employees.firstName);

      if (emps.length === 0) return res.json({ preview: [] });

      const empIds = emps.map((e) => e.id);
      const attResult = await db.execute(sql`
        SELECT employee_id, status, COUNT(*) as count
        FROM employee_attendance
        WHERE company_id = ${companyId}
          AND employee_id = ANY(${sqlArray(empIds)})
          AND attendance_date >= ${startDate}
          AND attendance_date <= ${endDate}
        GROUP BY employee_id, status
      `);

      // Build attendance map: employeeId -> { present: n, half: n, absent: n, late: n, leave: n }
      const attMap: Record<number, Record<string, number>> = {};
      for (const row of attResult.rows) {
        const eid = Number(row.employee_id);
        if (!attMap[eid]) attMap[eid] = {};
        attMap[eid][(row.status as string).toLowerCase()] = Number(row.count);
      }

      // Get outstanding advance balances per employee
      const advResult = await db.execute<RawQueryRow<AdvanceBalanceRow>>(sql`
        SELECT employee_id, SUM(remaining_balance::numeric) as total_balance
        FROM employee_advances
        WHERE company_id = ${companyId} AND fully_paid = false
          AND employee_id = ANY(${sqlArray(empIds)})
        GROUP BY employee_id
      `);
      const advMap: Record<number, number> = {};
      for (const row of advResult.rows) {
        const employeeId = toPositiveInteger(row.employee_id);
        if (employeeId === undefined) continue;
        advMap[employeeId] = toFiniteNumber(row.total_balance) ?? 0;
      }

      // Days in the month (use startDate's month)
      const monthStart = new Date(startDate + "T00:00:00");
      const daysInMonth = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0).getDate();

      const preview = emps.map((emp) => {
        const eid = emp.id;
        const a = attMap[eid] || {};
        const present = (a.present || 0) + (a.late || 0) + (a.leave || 0);
        const half = (a["half day"] || 0) + (a.halfday || 0);
        const absent = a.absent || 0;
        const totalMarkedDays = present + half + absent;
        const monthlySalary = parseFloat(emp.monthlySalary || "0");
        const dailyRate = daysInMonth > 0 ? monthlySalary / daysInMonth : 0;

        // Absence-deduction model: unmarked days within the period are treated as present.
        // Only explicitly marked absences and half-days reduce pay.
        const deductedDays = absent + half * 0.5;
        const effectivePresentDays = Math.max(0, daysInMonth - deductedDays);
        const calculatedPay = Math.max(0, monthlySalary - dailyRate * deductedDays);

        const outstandingAdvance = advMap[eid] || 0;
        const deduction = Math.min(outstandingAdvance, calculatedPay);
        const netPay = Math.max(0, calculatedPay - deduction);
        return {
          employeeId: eid,
          employeeName: `${emp.firstName} ${emp.lastName}`.trim(),
          department: emp.department,
          monthlySalary: monthlySalary.toFixed(2),
          daysInMonth,
          presentDays: effectivePresentDays,
          halfDays: half,
          absentDays: absent,
          totalMarkedDays,
          calculatedPay: calculatedPay.toFixed(2),
          outstandingAdvance: outstandingAdvance.toFixed(2),
          deduction: deduction.toFixed(2),
          netPay: netPay.toFixed(2),
        };
      });

      res.json({ preview });
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  // ─── Employee Attendance ──────────────────────────────────────────────────────
}
