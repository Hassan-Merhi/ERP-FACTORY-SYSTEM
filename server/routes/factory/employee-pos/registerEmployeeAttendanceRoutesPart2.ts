// Extracted from ./employeeAttendanceRoutes.ts to keep that module under the source-size cap.
import { getErrorMessage } from "../../../lib/httpHandlers";
import { getClientDate } from "../../../lib/dateUtils";
import { logger } from "../../../lib/logger";
import type { Express, Request, Response } from "express";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { factoryWorkers } from "@shared/schema";
import { and, eq, or, sql } from "drizzle-orm";
import { sqlArray } from "../../../lib/sqlArray";
import { validateAttendanceReportDateRange } from "@shared/attendanceReportDateRange";
import { resultRows } from "../../../lib/queryResult";
import {
  type AttendanceReportPayrollRecord,
  reconcileAttendanceReportSalary,
} from "../../../services/payroll/attendanceReportSalary";
import {
  type PayrollReconciliationRecord,
  reconcilePeriodPayrolls,
} from "../../../services/payroll/periodPayrollReconciliation";

export function registerEmployeeAttendanceRoutesPart2(app: Express) {
  // ─── Monthly Attendance Report ───────────────────────────────────────────────
  // GET /api/factory/workers/attendance-report?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
  // Also supports legacy ?year=YYYY&month=M params.
  // Returns active workers plus inactive workers with payroll records for the selected period.
  app.get("/api/factory/workers/attendance-report", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const DAY_ABBR = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

      let startDate: string;
      let endDate: string;

      if (req.query.startDate !== undefined || req.query.endDate !== undefined) {
        const requestedStart = req.query.startDate;
        const requestedEnd = req.query.endDate;
        if (
          typeof requestedStart !== "string" ||
          typeof requestedEnd !== "string" ||
          !/^\d{4}-\d{2}-\d{2}$/.test(requestedStart) ||
          !/^\d{4}-\d{2}-\d{2}$/.test(requestedEnd)
        ) {
          return res.status(400).json({ message: "Invalid date format, use YYYY-MM-DD" });
        }
        startDate = requestedStart;
        endDate = requestedEnd;
      } else {
        const requestedYear = req.query.year;
        const requestedMonth = req.query.month;
        if (
          (requestedYear !== undefined && (typeof requestedYear !== "string" || !/^\d{4}$/.test(requestedYear))) ||
          (requestedMonth !== undefined && (typeof requestedMonth !== "string" || !/^\d{1,2}$/.test(requestedMonth)))
        ) {
          return res.status(400).json({ message: "Invalid year or month" });
        }
        const year = requestedYear === undefined ? new Date().getFullYear() : Number(requestedYear);
        const month = requestedMonth === undefined ? new Date().getMonth() + 1 : Number(requestedMonth);
        if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
          return res.status(400).json({ message: "Invalid year or month" });
        }
        const daysInMonth = new Date(year, month, 0).getDate();
        startDate = `${year}-${String(month).padStart(2, "0")}-01`;
        endDate = `${year}-${String(month).padStart(2, "0")}-${String(daysInMonth).padStart(2, "0")}`;
      }

      // Validate before allocating date columns or running any report queries.
      // Editing a native date input can temporarily emit years like 0002,
      // which used to produce multi-decade/century reports over 70 MB.
      const dateRangeError = validateAttendanceReportDateRange(startDate, endDate);
      if (dateRangeError) {
        return res.status(400).json({
          code: "ATTENDANCE_REPORT_INVALID_RANGE",
          message: dateRangeError,
        });
      }

      // Use UTC days consistently even across daylight-saving transitions.
      const dates: { date: string; label: string; abbr: string; isWeekend: boolean }[] = [];
      const startMs = Date.parse(`${startDate}T00:00:00Z`);
      const endMs = Date.parse(`${endDate}T00:00:00Z`);
      const multiMonth = startDate.substring(0, 7) !== endDate.substring(0, 7);
      const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      for (let ms = startMs; ms <= endMs; ms += 86400000) {
        const d = new Date(ms);
        const iso = d.toISOString().substring(0, 10);
        const dow = d.getUTCDay();
        const dayNum = d.getUTCDate();
        const label = multiMonth ? `${MONTH_ABBR[d.getUTCMonth()]} ${dayNum}` : String(dayNum);
        dates.push({ date: iso, label, abbr: DAY_ABBR[dow], isWeekend: dow === 0 || dow === 6 });
      }

      // Include currently inactive workers ONLY when they have a payroll for
      // the requested period. This retains genuine former-worker wages while
      // avoiding phantom salary estimates for terminated workers with no pay.
      const workers = await db
        .select({
          id: factoryWorkers.id,
          employeeCode: factoryWorkers.employeeCode,
          fullName: factoryWorkers.fullName,
          active: factoryWorkers.active,
          contractEndDate: factoryWorkers.contractEndDate,
          baseSalary: factoryWorkers.baseSalary,
          salaryType: factoryWorkers.salaryType,
          transportAllowance: factoryWorkers.transportAllowance,
        })
        .from(factoryWorkers)
        .where(
          and(
            eq(factoryWorkers.companyId, companyId),
            or(
              eq(factoryWorkers.active, true),
              sql`EXISTS (
                SELECT 1 FROM factory_payrolls historical_payroll
                WHERE historical_payroll.company_id = ${companyId}
                  AND historical_payroll.worker_id = ${factoryWorkers.id}
                  AND historical_payroll.period_start >= ${startDate}::date
                  AND historical_payroll.period_end <= ${endDate}::date
              )`
            )
          )
        )
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
      const reportWorkerIds = new Set(workerIds);

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

      // An inactive worker remains absent from their deactivation date through
      // today, including while the worker has not yet been reactivated.
      // Reactivation persists these days as real attendance records.
      const today = getClientDate(req);
      for (const worker of workers) {
        if (worker.active || !worker.contractEndDate) continue;
        const inactiveFrom = String(worker.contractEndDate).slice(0, 10);
        const dayMap = workerAttMap.get(worker.id) ?? new Map<string, string>();
        for (const { date } of dates) {
          if (date >= inactiveFrom && date <= today) dayMap.set(date, "Absent");
        }
        workerAttMap.set(worker.id, dayMap);
      }
      // Build the daily totals from the same effective records shown in cells.
      const effectiveAttendance = [...workerAttMap.entries()].flatMap(([workerId, days]) =>
        [...days.entries()].map(([date, status]) => ({ workerId, date, status }))
      );

      // Build daily summary: { isoDate → { present, absent } }
      const dailySummary: Record<string, { present: number; absent: number }> = {};
      for (const { date } of dates) dailySummary[date] = { present: 0, absent: 0 };
      for (const r of effectiveAttendance) {
        if (!dailySummary[r.date]) dailySummary[r.date] = { present: 0, absent: 0 };
        if (r.status === "Present") dailySummary[r.date].present++;
        else if (r.status === "Absent") dailySummary[r.date].absent++;
      }

      // Reconcile against stored payroll entitlements and settlements instead of
      // comparing today's attendance estimate to only cash net_salary. Only
      // payroll periods wholly within the selected range are eligible; the
      // reconciliation helper removes overlapping partial payrolls per worker.
      const payrollRows = await db.execute(
        sql`SELECT p.id, p.worker_id AS "workerId",
                   p.period_start::text AS "periodStart",
                   p.period_end::text AS "periodEnd",
                   p.status, p.net_salary AS "netSalary", p.advances,
                   COALESCE(w.active, false) AS "workerActive",
                   EXISTS (
                     SELECT 1
                     FROM factory_daybook_entries d
                     WHERE d.company_id = p.company_id
                       AND d.reference_id = p.id
                       AND d.reference_table = 'factory_payrolls'
                       AND d.tx_type = 'PAYROLL_PAYMENT'
                   ) AS "hasDaybookPayment"
            FROM factory_payrolls p
            LEFT JOIN factory_workers w
              ON w.id = p.worker_id AND w.company_id = p.company_id
            WHERE p.company_id = ${companyId}
              AND p.period_start >= ${startDate}::date
              AND p.period_end <= ${endDate}::date`
      );
      const payrollByWorker = new Map<number, AttendanceReportPayrollRecord[]>();
      const reconciliationRecords: PayrollReconciliationRecord[] = [];
      for (const row of resultRows<{
        id: number;
        workerId: number;
        periodStart: string;
        periodEnd: string;
        status: string;
        netSalary: string | null;
        advances: string | null;
        workerActive: boolean;
        hasDaybookPayment: boolean;
      }>(payrollRows)) {
        const workerId = Number(row.workerId);
        reconciliationRecords.push({
          id: Number(row.id),
          workerId,
          workerActive: row.workerActive,
          status: row.status,
          periodStart: row.periodStart,
          periodEnd: row.periodEnd,
          netSalary: row.netSalary ?? "0",
          advances: row.advances ?? "0",
          hasDaybookPayment: row.hasDaybookPayment,
        });
        // The report includes inactive workers with payroll activity in this
        // period, but never workers outside the selected company/pay window.
        if (!reportWorkerIds.has(workerId)) continue;
        const matching = payrollByWorker.get(workerId) ?? [];
        matching.push({
          id: Number(row.id),
          workerId,
          periodStart: row.periodStart,
          periodEnd: row.periodEnd,
          status: row.status,
          netSalary: row.netSalary ?? "0",
          advances: row.advances ?? "0",
        });
        payrollByWorker.set(workerId, matching);
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
        const salary = reconcileAttendanceReportSalary({
          startDate,
          endDate,
          salaryType: w.salaryType ?? "Monthly",
          baseSalary: w.baseSalary ?? "0",
          transportAllowance: w.transportAllowance ?? "0",
          attendance,
          payrolls: payrollByWorker.get(w.id) ?? [],
        });

        return {
          id: w.id,
          employeeCode: w.employeeCode,
          fullName: w.fullName,
          active: w.active,
          attendance,
          presentCount,
          absentCount,
          recordedCount,
          attendancePct,
          baseSalary: w.baseSalary ?? "0",
          salaryType: w.salaryType ?? "Monthly",
          transportAllowance: w.transportAllowance ?? "0",
          ...salary,
        };
      });

      res.json({
        startDate,
        endDate,
        dates,
        workers: workerResults,
        payrollReconciliation: reconcilePeriodPayrolls(reconciliationRecords, startDate, endDate),
        dailySummary,
        totals: {
          workers: workers.length,
          activeWorkers: workers.filter((w) => w.active).length,
          inactiveWorkers: workers.filter((w) => !w.active).length,
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
}
