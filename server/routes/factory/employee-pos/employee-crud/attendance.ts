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
import { requireAttendanceEditApproval } from "../../attendanceEditPolicy";
import { logAudit } from "../../../helpers/auditWriteAdapter";
import { inArray } from "drizzle-orm";

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
      const { records, adminUsername, adminPassword } = (req.body ?? {}) as {
        records: Array<{ employeeId: number; attendanceDate: string; status: string; notes?: string }>;
        adminUsername?: string;
        adminPassword?: string;
      };
      if (!Array.isArray(records) || !records.length || records.length > 500) {
        return res.status(400).json({ message: "Provide 1–500 attendance records" });
      }
      const allowedStatuses = new Set(["Present", "Absent", "Late", "Half Day", "Leave"]);
      const seen = new Set<string>();
      for (const record of records) {
        if (!Number.isSafeInteger(record?.employeeId) || record.employeeId <= 0 ||
            !allowedStatuses.has(record?.status) ||
            (record?.notes !== undefined && (typeof record.notes !== "string" || record.notes.length > 4000))) {
          return res.status(400).json({ message: "Invalid attendance record" });
        }
        const key = `${record.employeeId}:${record.attendanceDate}`;
        if (seen.has(key)) return res.status(400).json({ message: "Duplicate employee/date in attendance batch" });
        seen.add(key);
      }
      const approvedBy = await requireAttendanceEditApproval(
        req, res, companyId, records.map((record) => record.attendanceDate), { adminUsername, adminPassword }
      );
      if (approvedBy === undefined) return;
      const ids = [...new Set(records.map((record) => record.employeeId))];
      const companyEmployees = await db.select({ id: employees.id }).from(employees)
        .where(and(eq(employees.companyId, companyId), eq(employees.employeeType, "Employee"),
          sql`${employees.deletedAt} IS NULL`, inArray(employees.id, ids)));
      if (companyEmployees.length !== ids.length) {
        return res.status(400).json({ message: "Attendance includes an employee outside this factory company" });
      }
      const requesterId = String(req.session.userId || req.user?.id || "");
      const requesterName = String((req.user as { username?: string } | undefined)?.username || requesterId);
      await db.transaction(async (tx) => {
        for (const record of records) {
          const beforeRows = approvedBy ? await tx.execute(sql`
            SELECT id, status, notes FROM employee_attendance
            WHERE company_id = ${companyId} AND employee_id = ${record.employeeId}
              AND attendance_date = ${record.attendanceDate}
            LIMIT 1
          `) : null;
          const before = (beforeRows?.rows as Array<{ id: number; status: string; notes: string | null }> | undefined)?.[0];
          await tx.execute(sql`
            INSERT INTO employee_attendance (company_id, employee_id, attendance_date, status, notes)
            VALUES (${companyId}, ${record.employeeId}, ${record.attendanceDate}, ${record.status}, ${record.notes || null})
            ON CONFLICT (employee_id, attendance_date) DO UPDATE SET status = EXCLUDED.status, notes = EXCLUDED.notes
          `);
          if (approvedBy && (!before || before.status !== record.status ||
              (before.notes || null) !== (record.notes || null))) {
            await logAudit({
              userId: requesterId,
              username: requesterName,
              companyId,
              action: "update",
              tableName: "employee_attendance",
              recordId: before?.id ?? null,
              recordIdentifier: `${record.employeeId}:${record.attendanceDate}`,
              changes: {
                status: { old: before?.status ?? null, new: record.status },
                notes: { old: before?.notes ?? null, new: record.notes || null },
                approvedBy: { new: approvedBy.username },
                approvedByUserId: { new: approvedBy.id },
                attendanceDate: { new: record.attendanceDate },
              },
            }, tx);
          }
        }
      });
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
