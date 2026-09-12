/**
 * employeeCrudRoutes: FactoryEmployeeAttendance endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../../lib/httpHandlers";
import { db } from "../../../../db";
import { requireAuth } from "../../../../auth";
import { employees } from "@shared/schema";
import { eq, and, sql } from "drizzle-orm";
import { sqlArray } from "../../../../lib/sqlArray";

export function registerFactoryEmployeeAttendanceRoutes(app: Express) {
  app.get("/api/factory/employee-attendance", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const { date } = req.query as { date?: string };
      if (!date) return res.status(400).json({ message: "date is required" });

      const emps = await db
        .select({
          id: employees.id,
          firstName: employees.firstName,
          lastName: employees.lastName,
          code: employees.code,
          department: employees.department,
        })
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

      if (emps.length === 0) return res.json({ employees: [], attendance: [] });

      const empIds = emps.map((e) => e.id);
      const existing = await db.execute(sql`
        SELECT * FROM employee_attendance
        WHERE company_id = ${companyId} AND attendance_date = ${date}
        AND employee_id = ANY(${sqlArray(empIds)})
      `);
      // Map snake_case raw SQL rows to camelCase for the frontend
      const attendance = ((existing.rows)).map((r) => ({
        id: r.id,
        employeeId: r.employee_id,
        attendanceDate: r.attendance_date,
        status: r.status,
        notes: r.notes,
      }));
      res.json({ employees: emps, attendance });
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  app.post("/api/factory/employee-attendance/bulk", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const { records } = req.body as {
        records: Array<{ employeeId: number; attendanceDate: string; status: string; notes?: string }>;
      };
      if (!Array.isArray(records) || records.length === 0)
        return res.status(400).json({ message: "records array is required" });

      for (const r of records) {
        await db.execute(sql`
          INSERT INTO employee_attendance (company_id, employee_id, attendance_date, status, notes)
          VALUES (${companyId}, ${r.employeeId}, ${r.attendanceDate}, ${r.status}, ${r.notes || null})
          ON CONFLICT (employee_id, attendance_date) DO UPDATE SET status = EXCLUDED.status, notes = EXCLUDED.notes
        `);
      }
      res.json({ saved: records.length });
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  // GET /api/factory/employee-attendance/employee/:id — per-employee attendance for a date range
  app.get("/api/factory/employee-attendance/employee/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const empId = parseInt(req.params.id);
      if (isNaN(empId)) return res.status(400).json({ message: "Invalid employee ID" });
      const { startDate, endDate } = req.query as { startDate?: string; endDate?: string };
      if (!startDate || !endDate) return res.status(400).json({ message: "startDate and endDate required" });
      const rows = await db.execute(sql`
        SELECT * FROM employee_attendance
        WHERE company_id = ${companyId} AND employee_id = ${empId}
          AND attendance_date >= ${startDate} AND attendance_date <= ${endDate}
        ORDER BY attendance_date
      `);
      // Map snake_case raw SQL rows to camelCase for the frontend
      const attendance = ((rows.rows)).map((r) => ({
        id: r.id,
        employeeId: r.employee_id,
        attendanceDate: r.attendance_date,
        status: r.status,
        notes: r.notes,
      }));
      res.json(attendance);
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });
}
