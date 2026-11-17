import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import type { Express, Request, Response } from "express";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { FactoryNetPositionDateError } from "@shared/factoryNetPositionAsOf";
import { resolveFactoryNetPositionAsOf } from "../../../services/factory/netPositionAsOf";
import { loadFactoryNetPositionEmployees } from "../../../services/factory/netPositionEmployees";

import { factoryWorkers, employees } from "@shared/schema";
import { eq, and, sql } from "drizzle-orm";
import { MoneyDecimal, toMoney } from "../../../lib/money";
import { registerEmployeeAttendanceRoutesPart2 } from "./registerEmployeeAttendanceRoutesPart2";

export function registerEmployeeAttendanceRoutes(app: Express) {
  registerEmployeeAttendanceRoutesPart1(app);
  registerEmployeeAttendanceRoutesPart2(app);
  registerEmployeeAttendanceRoutesPart3(app);
}

function registerEmployeeAttendanceRoutesPart1(app: Express) {
  app.get("/api/factory/net-position/payroll-breakdown", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const scope = await resolveFactoryNetPositionAsOf(Number(companyId), req.query.asOf);
      const rows = await loadFactoryNetPositionEmployees(Number(companyId), scope);
      const result = rows
        .filter((employee) => employee.balance > 0)
        .map((employee) => ({
          id: employee.id,
          name: employee.name,
          code: employee.code ?? "",
          balance: employee.balance,
        }));
      res.json({
        employees: result,
        companyId: Number(companyId),
        asOf: scope.asOf,
        historyCompleteness: scope.isHistorical ? "partial" : "current",
      });
    } catch (error: unknown) {
      if (error instanceof FactoryNetPositionDateError) {
        return res.status(error.status).json({ code: error.code, message: error.message });
      }
      logger.error("Payroll breakdown error:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}

function registerEmployeeAttendanceRoutesPart3(app: Express) {
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
      const ratio = new MoneyDecimal(currentDay).div(daysInMonth);
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

      const totalWorkerBaseSalary = toMoney(String(workerAgg.rows[0]?.totalWorkerBaseSalary ?? "0")).toNumber();
      const totalWorkerTransport = toMoney(String(workerAgg.rows[0]?.totalWorkerTransport ?? "0")).toNumber();
      const totalWorkerPaid = toMoney(String(payrollAgg.rows[0]?.totalWorkerPaid ?? "0")).toNumber();
      const totalEmployeeMonthlySalary = toMoney(
        String(employeeAgg.rows[0]?.totalEmployeeMonthlySalary ?? "0")
      ).toNumber();
      const totalEmployeeBalance = toMoney(String(employeeAgg.rows[0]?.totalEmployeeBalance ?? "0")).toNumber();

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
          const base = toMoney(w.baseSalary);
          const transport = toMoney(w.transportAllowance);
          return {
            id: w.id,
            name: w.fullName,
            baseSalary: base.toNumber(),
            transport: transport.toNumber(),
            expected: base.times(ratio).toNumber(),
            transportProrated: transport.times(ratio).toNumber(),
            total: base.plus(transport).times(ratio).toNumber(),
          };
        }),
        employeeBreakdown: empRows.map((e) => {
          const monthly = toMoney(e.monthlySalary);
          return {
            id: e.id,
            name: `${e.firstName} ${e.lastName}`.trim(),
            monthlySalary: monthly.toNumber(),
            expected: monthly.times(ratio).toNumber(),
            balance: toMoney(e.currentBalance).toNumber(),
          };
        }),
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
