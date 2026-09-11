import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import type { Express, Request, Response } from "express";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";

import { factoryWorkers, employees } from "@shared/schema";
import { eq, and, sql, isNull } from "drizzle-orm";
import { sqlArray } from "../../../lib/sqlArray";
import { resultRows } from "../../../lib/queryResult";

export function registerEmployeeAttendanceRoutes(app: Express) {
  app.get("/api/factory/net-position/payroll-breakdown", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

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
        .orderBy(employees.firstName, employees.lastName);

      const result = rows
        .map((r) => ({
          id: r.id,
          name: `${r.firstName} ${r.lastName}`.trim(),
          code: r.code ?? "",
          balance: parseFloat(r.currentBalance || "0"),
        }))
        // Only show employees the company owes money to (positive balance = payroll payable).
        // Negative-balance employees owe the company — they appear on the "What We Have"
        // side as receivables and must NOT appear here too.
        .filter((r) => r.balance > 0);

      res.json({ employees: result });
    } catch (error: unknown) {
      logger.error("Payroll breakdown error:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ─── Monthly Attendance Report ───────────────────────────────────────────────
  // GET /api/factory/workers/attendance-report?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
  // Also supports legacy ?year=YYYY&month=M params.
  // Returns all active workers + attendance matrix for the given date range.
  app.get("/api/factory/workers/attendance-report", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const DAY_ABBR = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

      let startDate: string;
      let endDate: string;

      if (req.query.startDate && req.query.endDate) {
        startDate = req.query.startDate as string;
        endDate = req.query.endDate as string;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
          return res.status(400).json({ message: "Invalid date format, use YYYY-MM-DD" });
        }
      } else {
        const year = parseInt((req.query.year as string) || String(new Date().getFullYear()));
        const month = parseInt((req.query.month as string) || String(new Date().getMonth() + 1));
        if (isNaN(year) || isNaN(month) || month < 1 || month > 12) {
          return res.status(400).json({ message: "Invalid year or month" });
        }
        const daysInMonth = new Date(year, month, 0).getDate();
        startDate = `${year}-${String(month).padStart(2, "0")}-01`;
        endDate = `${year}-${String(month).padStart(2, "0")}-${String(daysInMonth).padStart(2, "0")}`;
      }

      // Build dates array
      const dates: { date: string; label: string; abbr: string; isWeekend: boolean }[] = [];
      const startMs = new Date(startDate + "T00:00:00").getTime();
      const endMs = new Date(endDate + "T00:00:00").getTime();
      if (isNaN(startMs) || isNaN(endMs) || startMs > endMs) {
        return res.status(400).json({ message: "Invalid date range" });
      }
      const multiMonth = startDate.substring(0, 7) !== endDate.substring(0, 7);
      const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      for (let ms = startMs; ms <= endMs; ms += 86400000) {
        const d = new Date(ms);
        const iso = d.toISOString().substring(0, 10);
        const dow = d.getDay();
        const dayNum = d.getDate();
        const label = multiMonth ? `${MONTH_ABBR[d.getMonth()]} ${dayNum}` : String(dayNum);
        dates.push({ date: iso, label, abbr: DAY_ABBR[dow], isWeekend: dow === 0 || dow === 6 });
      }

      // All active workers for this company
      const workers = await db
        .select({
          id: factoryWorkers.id,
          employeeCode: factoryWorkers.employeeCode,
          fullName: factoryWorkers.fullName,
          active: factoryWorkers.active,
          baseSalary: factoryWorkers.baseSalary,
          salaryType: factoryWorkers.salaryType,
          transportAllowance: factoryWorkers.transportAllowance,
        })
        .from(factoryWorkers)
        .where(and(eq(factoryWorkers.companyId, companyId), eq(factoryWorkers.active, true)))
        .orderBy(factoryWorkers.fullName);

      if (workers.length === 0) {
        return res.json({
          startDate,
          endDate,
          dates,
          workers: [],
          dailySummary: {},
          totals: { workers: 0, presentDays: 0, absentDays: 0, totalPossibleDays: 0 },
        });
      }

      const workerIds = workers.map((w) => w.id);

      // Attendance rows for this date range
      const attRows = await db.execute(
        sql`SELECT worker_id AS "workerId",
                   attendance_date::date AS date,
                   status
            FROM factory_attendance
            WHERE company_id = ${companyId}
              AND attendance_date::date >= ${startDate}::date
              AND attendance_date::date <= ${endDate}::date
              AND worker_id = ANY(${sqlArray(workerIds)})
            ORDER BY attendance_date`
      );
      const attRecords: { workerId: number; date: string; status: string }[] = resultRows<{
        workerId: number;
        date: string;
        status: string;
      }>(attRows).map((r) => ({
        workerId: Number(r.workerId),
        date: typeof r.date === "string" ? r.date.substring(0, 10) : new Date(r.date).toISOString().substring(0, 10),
        status: r.status,
      }));

      // Build per-worker attendance map: { workerId → { isoDate → status } }
      const workerAttMap = new Map<number, Map<string, string>>();
      for (const r of attRecords) {
        if (!workerAttMap.has(r.workerId)) workerAttMap.set(r.workerId, new Map());
        workerAttMap.get(r.workerId)!.set(r.date, r.status);
      }

      // Build daily summary: { isoDate → { present, absent } }
      const dailySummary: Record<string, { present: number; absent: number }> = {};
      for (const { date } of dates) dailySummary[date] = { present: 0, absent: 0 };
      for (const r of attRecords) {
        if (!dailySummary[r.date]) dailySummary[r.date] = { present: 0, absent: 0 };
        if (r.status === "Present") dailySummary[r.date].present++;
        else if (r.status === "Absent") dailySummary[r.date].absent++;
      }

      // Fetch paid payrolls overlapping the date range for these workers
      const paidPayrollRows = await db.execute(
        sql`SELECT worker_id AS "workerId", net_salary AS "netSalary"
            FROM factory_payrolls
            WHERE company_id = ${companyId}
              AND status = 'PAID'
              AND period_start <= ${endDate}::date
              AND period_end   >= ${startDate}::date
              AND worker_id = ANY(${sqlArray(workerIds)})`
      );
      const paidPayrollList: { workerId: number; netSalary: string }[] = resultRows<{
        workerId: number;
        netSalary: string | null;
      }>(paidPayrollRows).map((r) => ({
        workerId: Number(r.workerId),
        netSalary: r.netSalary ?? "0",
      }));
      const paidSalaryMap = new Map<number, number>();
      for (const r of paidPayrollList) {
        paidSalaryMap.set(r.workerId, (paidSalaryMap.get(r.workerId) || 0) + parseFloat(r.netSalary));
      }

      let totalPresent = 0;
      let totalAbsent = 0;

      const workerResults = workers.map((w) => {
        const dayMap = workerAttMap.get(w.id) || new Map<string, string>();
        const attendance: Record<string, string> = {};
        for (const [d, s] of dayMap) attendance[d] = s;

        let presentCount = 0;
        let absentCount = 0;
        for (const s of dayMap.values()) {
          if (s === "Present") presentCount++;
          else if (s === "Absent") absentCount++;
        }
        totalPresent += presentCount;
        totalAbsent += absentCount;

        const recordedCount = presentCount + absentCount;
        const attendancePct = recordedCount > 0 ? Math.round((presentCount / recordedCount) * 100) : null;

        return {
          id: w.id,
          employeeCode: w.employeeCode,
          fullName: w.fullName,
          attendance,
          presentCount,
          absentCount,
          recordedCount,
          attendancePct,
          baseSalary: w.baseSalary ?? "0",
          salaryType: w.salaryType ?? "Monthly",
          transportAllowance: w.transportAllowance ?? "0",
          paidSalary: (paidSalaryMap.get(w.id) || 0).toFixed(2),
        };
      });

      res.json({
        startDate,
        endDate,
        dates,
        workers: workerResults,
        dailySummary,
        totals: {
          workers: workers.length,
          presentDays: totalPresent,
          absentDays: totalAbsent,
          totalPossibleDays: workers.length * dates.length,
        },
      });
    } catch (error: unknown) {
      logger.error("Attendance report error:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // GET /api/factory/monthly-salary-summary?date=YYYY-MM-DD
  // Returns month totals prorated to the given date (defaults to today)
  app.get("/api/factory/monthly-salary-summary", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const dateParam =
        typeof req.query.date === "string" && req.query.date.match(/^\d{4}-\d{2}-\d{2}$/) ? req.query.date : null;
      const now = dateParam ? new Date(dateParam + "T12:00:00") : new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, "0");
      const monthStart = `${year}-${month}-01`;

      const daysInMonth = new Date(year, now.getMonth() + 1, 0).getDate();
      const currentDay = now.getDate();
      const ratio = currentDay / daysInMonth;
      const monthEnd = `${year}-${month}-${String(daysInMonth).padStart(2, "0")}`;

      const includeBreakdown = req.query.includeBreakdown === "true";

      // ── Aggregate totals via SQL SUM — three independent queries run concurrently ──
      const [workerAgg, payrollAgg, employeeAgg] = await Promise.all([
        db.execute(sql`
          SELECT
            COALESCE(SUM(CAST(base_salary AS numeric)), 0) AS "totalWorkerBaseSalary",
            COALESCE(SUM(CAST(transport_allowance AS numeric)), 0) AS "totalWorkerTransport"
          FROM factory_workers
          WHERE company_id = ${companyId}
            AND active = true
            AND salary_type = 'Monthly'
        `),
        // Use overlap logic: any PAID payroll whose period overlaps the current month counts.
        db.execute(sql`
          SELECT COALESCE(SUM(net_salary), 0) AS "totalWorkerPaid"
          FROM factory_payrolls
          WHERE company_id = ${companyId}
            AND status = 'PAID'
            AND period_start <= ${monthEnd}::date
            AND period_end   >= ${monthStart}::date
        `),
        db.execute(sql`
          SELECT
            COALESCE(SUM(CAST(monthly_salary AS numeric)), 0) AS "totalEmployeeMonthlySalary",
            COALESCE(SUM(CAST(current_balance AS numeric)), 0) AS "totalEmployeeBalance"
          FROM employees
          WHERE company_id = ${companyId}
            AND employee_type = 'Employee'
            AND deleted_at IS NULL
        `),
      ]);

      const totalWorkerBaseSalary = parseFloat(String(workerAgg.rows[0]?.totalWorkerBaseSalary ?? "0"));
      const totalWorkerTransport = parseFloat(String(workerAgg.rows[0]?.totalWorkerTransport ?? "0"));
      const totalWorkerPaid = parseFloat(String(payrollAgg.rows[0]?.totalWorkerPaid ?? "0"));
      const totalEmployeeMonthlySalary = parseFloat(String(employeeAgg.rows[0]?.totalEmployeeMonthlySalary ?? "0"));
      const totalEmployeeBalance = parseFloat(String(employeeAgg.rows[0]?.totalEmployeeBalance ?? "0"));

      // When breakdown is not requested, return lightweight summary only (no row-level data).
      if (!includeBreakdown) {
        return res.json({
          currentDay,
          daysInMonth,
          totalWorkerBaseSalary,
          totalWorkerTransport,
          totalWorkerPaid,
          totalEmployeeMonthlySalary,
          totalEmployeeBalance,
          workerBreakdown: [],
          employeeBreakdown: [],
        });
      }

      // includeBreakdown=true: fetch individual worker and employee rows concurrently.
      const [workers, empRows] = await Promise.all([
        db
          .select({
            id: factoryWorkers.id,
            fullName: factoryWorkers.fullName,
            baseSalary: factoryWorkers.baseSalary,
            transportAllowance: factoryWorkers.transportAllowance,
            salaryType: factoryWorkers.salaryType,
          })
          .from(factoryWorkers)
          .where(
            and(
              eq(factoryWorkers.companyId, companyId),
              eq(factoryWorkers.active, true),
              eq(factoryWorkers.salaryType, "Monthly")
            )
          ),
        db
          .select({
            id: employees.id,
            firstName: employees.firstName,
            lastName: employees.lastName,
            monthlySalary: employees.monthlySalary,
            currentBalance: employees.currentBalance,
          })
          .from(employees)
          .where(
            and(
              eq(employees.companyId, companyId),
              eq(employees.employeeType, "Employee"),
              sql`${employees.deletedAt} IS NULL`
            )
          ),
      ]);

      res.json({
        currentDay,
        daysInMonth,
        totalWorkerBaseSalary,
        totalWorkerTransport,
        totalWorkerPaid,
        totalEmployeeMonthlySalary,
        totalEmployeeBalance,
        workerBreakdown: workers.map((w) => {
          const base = parseFloat(w.baseSalary ?? "0");
          const transport = parseFloat(w.transportAllowance ?? "0");
          return {
            id: w.id,
            name: w.fullName,
            baseSalary: base,
            transport,
            expected: base * ratio,
            transportProrated: transport * ratio,
            total: (base + transport) * ratio,
          };
        }),
        employeeBreakdown: empRows.map((e) => {
          const monthly = parseFloat(e.monthlySalary ?? "0");
          return {
            id: e.id,
            name: `${e.firstName} ${e.lastName}`.trim(),
            monthlySalary: monthly,
            expected: monthly * ratio,
            balance: parseFloat(e.currentBalance ?? "0"),
          };
        }),
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
