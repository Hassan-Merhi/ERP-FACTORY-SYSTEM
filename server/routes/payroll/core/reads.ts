/**
 * payrollCoreRoutes: PayrollCoreRead endpoints.
 */
import type { Express, Request, Response } from "express";
import { parseId, parseOptionalId } from "../../../lib/parseId";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { getClientDate } from "../../../lib/dateUtils";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { eq, and, desc, gte, lte, inArray } from "drizzle-orm";
import {
  factoryWorkers,
  factoryPayrolls,
  factoryWorkerAdvances,
  factoryAttendance,
  ledgerAccounts,
} from "@shared/schema";
import { computeMonthlyPay, getFactoryCompanyId } from "./_helpers";
import {
  attachProductionBonusesToPayroll,
  getProductionBonusTotalsForPayrollIds,
  syncProductionBonusProposalsForPeriod,
} from "../../../services/payroll/productionBonusPayrollService";

const emptyBonusTotals = () => ({
  approved: 0,
  pending: 0,
  rejected: 0,
  totalSuggested: 0,
  pendingCount: 0,
  approvedCount: 0,
  rejectedCount: 0,
});

export function registerPayrollCoreReadRoutes(app: Express) {
  app.get("/api/factory/cash-accounts", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.query.companyId ? parseOptionalId(req.query.companyId) : getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const accounts = await db
        .select({ id: ledgerAccounts.id, name: ledgerAccounts.name, code: ledgerAccounts.code })
        .from(ledgerAccounts)
        .where(eq(ledgerAccounts.companyId, companyId))
        .orderBy(ledgerAccounts.name);
      res.json(accounts);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // GET /api/factory/payrolls - live Workers Hub payroll records with production-bonus state.
  app.get("/api/factory/payrolls", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.query.companyId ? parseOptionalId(req.query.companyId) : getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const payrolls = await db
        .select()
        .from(factoryPayrolls)
        .where(eq(factoryPayrolls.companyId, companyId))
        .orderBy(desc(factoryPayrolls.periodEnd));

      // Only DRAFT periods may generate/attach new proposals. Locked payrolls
      // remain historical and side-effect free.
      const draftPeriods = new Set<string>();
      for (const payroll of payrolls) {
        if (payroll.status !== "DRAFT") continue;
        const key = `${payroll.periodStart}:${payroll.periodEnd}`;
        if (draftPeriods.has(key)) continue;
        draftPeriods.add(key);
        await syncProductionBonusProposalsForPeriod(db, companyId, payroll.periodStart, payroll.periodEnd);
      }
      for (const payroll of payrolls) {
        if (payroll.status === "DRAFT") await attachProductionBonusesToPayroll(db, payroll.id);
      }

      const workerIds = [...new Set(payrolls.map((payroll) => payroll.workerId))];
      const workers = workerIds.length
        ? await db
            .select({
              id: factoryWorkers.id,
              fullName: factoryWorkers.fullName,
              employeeCode: factoryWorkers.employeeCode,
              position: factoryWorkers.position,
            })
            .from(factoryWorkers)
            .where(inArray(factoryWorkers.id, workerIds))
        : [];
      const workerMap = new Map(workers.map((worker) => [worker.id, worker]));
      const productionTotals = await getProductionBonusTotalsForPayrollIds(
        db,
        payrolls.map((payroll) => payroll.id)
      );
      const result = payrolls.map((payroll) => {
        const production = productionTotals.get(payroll.id) ?? emptyBonusTotals();
        return {
          ...payroll,
          worker: workerMap.get(payroll.workerId) || null,
          productionBonus: production.approved.toFixed(2),
          pendingProductionBonus: production.pending.toFixed(2),
          rejectedProductionBonus: production.rejected.toFixed(2),
          suggestedProductionBonus: production.totalSuggested.toFixed(2),
          productionBonusPendingCount: production.pendingCount,
          productionBonusApprovedCount: production.approvedCount,
          productionBonusRejectedCount: production.rejectedCount,
          otherBonuses: Math.max(0, Number(payroll.bonuses ?? 0) - production.approved).toFixed(2),
        };
      });
      res.json(result);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // GET /api/factory/workers/amount-due
  app.get("/api/factory/workers/amount-due", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.query.companyId ? parseOptionalId(req.query.companyId) : getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const todayStr = getClientDate(req);
      const today = new Date(todayStr + "T00:00:00");
      const pad = (n: number) => String(n).padStart(2, "0");
      const getDIM = (dateStr: string) => {
        const date = new Date(dateStr + "T00:00:00");
        return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
      };

      const workers = await db
        .select({
          id: factoryWorkers.id,
          baseSalary: factoryWorkers.baseSalary,
          transportAllowance: factoryWorkers.transportAllowance,
          salaryType: factoryWorkers.salaryType,
        })
        .from(factoryWorkers)
        .where(and(eq(factoryWorkers.companyId, companyId), eq(factoryWorkers.active, true)));
      if (workers.length === 0) return res.json({});

      const workerIds = workers.map((worker) => worker.id);
      const paidPayrolls = await db
        .select({ workerId: factoryPayrolls.workerId, periodEnd: factoryPayrolls.periodEnd })
        .from(factoryPayrolls)
        .where(
          and(
            eq(factoryPayrolls.companyId, companyId),
            inArray(factoryPayrolls.workerId, workerIds),
            eq(factoryPayrolls.status, "PAID")
          )
        )
        .orderBy(desc(factoryPayrolls.periodEnd));

      const lastPaidEnd: Record<number, string> = {};
      for (const payroll of paidPayrolls)
        if (!lastPaidEnd[payroll.workerId]) lastPaidEnd[payroll.workerId] = payroll.periodEnd;

      const periodStarts: Record<number, string> = {};
      for (const worker of workers) {
        if (lastPaidEnd[worker.id]) {
          const date = new Date(lastPaidEnd[worker.id] + "T00:00:00");
          date.setDate(date.getDate() + 1);
          periodStarts[worker.id] = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
        } else {
          periodStarts[worker.id] = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-01`;
        }
      }

      const allStarts = Object.values(periodStarts);
      const minPeriodStart = allStarts.length > 0 ? allStarts.reduce((a, b) => (a < b ? a : b)) : todayStr;
      const advanceRows = await db
        .select({ workerId: factoryWorkerAdvances.workerId, remaining: factoryWorkerAdvances.remainingBalance })
        .from(factoryWorkerAdvances)
        .where(
          and(
            eq(factoryWorkerAdvances.companyId, companyId),
            inArray(factoryWorkerAdvances.workerId, workerIds),
            eq(factoryWorkerAdvances.fullyPaid, false),
            eq(factoryWorkerAdvances.repaymentType, "salary_deduction")
          )
        );
      const advanceMap: Record<number, number> = {};
      for (const advance of advanceRows) {
        advanceMap[advance.workerId] = (advanceMap[advance.workerId] || 0) + parseFloat(advance.remaining || "0");
      }

      const attendanceRows = await db
        .select({
          workerId: factoryAttendance.workerId,
          attendanceDate: factoryAttendance.attendanceDate,
          status: factoryAttendance.status,
        })
        .from(factoryAttendance)
        .where(
          and(
            eq(factoryAttendance.companyId, companyId),
            inArray(factoryAttendance.workerId, workerIds),
            gte(factoryAttendance.attendanceDate, minPeriodStart),
            lte(factoryAttendance.attendanceDate, todayStr)
          )
        );
      const attendanceByWorker: Record<number, Array<{ date: string; status: string }>> = {};
      for (const attendance of attendanceRows) {
        if (!attendanceByWorker[attendance.workerId]) attendanceByWorker[attendance.workerId] = [];
        attendanceByWorker[attendance.workerId].push({
          date: attendance.attendanceDate,
          status: attendance.status ?? "Present",
        });
      }

      const round2 = (n: number) => Math.round(n * 100) / 100;
      const result: Record<
        number,
        {
          periodStart: string;
          periodEnd: string;
          base: number;
          transport: number;
          absenceDays: number;
          absenceDeducted: number;
          advanceDeducted: number;
          net: number;
          lastPaidThrough: string | null;
        }
      > = {};

      for (const worker of workers) {
        const baseSal = parseFloat(worker.baseSalary || "0");
        const transport = parseFloat(worker.transportAllowance || "0");
        const periodStart = periodStarts[worker.id];
        if (periodStart > todayStr) {
          result[worker.id] = {
            periodStart,
            periodEnd: todayStr,
            base: 0,
            transport: 0,
            absenceDays: 0,
            absenceDeducted: 0,
            advanceDeducted: 0,
            net: 0,
            lastPaidThrough: lastPaidEnd[worker.id] || null,
          };
          continue;
        }

        const grossBase = computeMonthlyPay(baseSal, periodStart, todayStr);
        const grossTransport = computeMonthlyPay(transport, periodStart, todayStr);
        let absenceDays = 0;
        let absDeductBase = 0;
        let absDeductTransport = 0;
        for (const attendance of attendanceByWorker[worker.id] ?? []) {
          if (attendance.date < periodStart || attendance.date > todayStr) continue;
          const dim = getDIM(attendance.date);
          if (attendance.status === "Absent") {
            absenceDays += 1;
            absDeductBase += baseSal / dim;
            absDeductTransport += transport / dim;
          } else if (attendance.status === "Half Day") {
            absenceDays += 0.5;
            absDeductBase += (baseSal / dim) * 0.5;
            absDeductTransport += (transport / dim) * 0.5;
          }
        }

        const base = Math.max(0, grossBase - absDeductBase);
        const transportDue = Math.max(0, grossTransport - absDeductTransport);
        const absenceDeducted = absDeductBase + absDeductTransport;
        const advanceBalance = advanceMap[worker.id] || 0;
        const advanceDeducted = Math.min(advanceBalance, base + transportDue);
        const net = Math.max(0, base + transportDue - advanceDeducted);
        result[worker.id] = {
          periodStart,
          periodEnd: todayStr,
          base: round2(base),
          transport: round2(transportDue),
          absenceDays,
          absenceDeducted: round2(absenceDeducted),
          advanceDeducted: round2(advanceDeducted),
          net: round2(net),
          lastPaidThrough: lastPaidEnd[worker.id] || null,
        };
      }

      res.json(result);
    } catch (err: unknown) {
      logger.error("GET /api/factory/workers/amount-due error", { error: err });
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  app.get("/api/factory/workers/:id/payrolls", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.query.companyId ? parseOptionalId(req.query.companyId) : getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Invalid id" });
      const payrolls = await db
        .select()
        .from(factoryPayrolls)
        .where(and(eq(factoryPayrolls.workerId, id), eq(factoryPayrolls.companyId, companyId)))
        .orderBy(desc(factoryPayrolls.periodEnd));
      const productionTotals = await getProductionBonusTotalsForPayrollIds(
        db,
        payrolls.map((payroll) => payroll.id)
      );
      res.json(
        payrolls.map((payroll) => {
          const production = productionTotals.get(payroll.id) ?? emptyBonusTotals();
          return {
            ...payroll,
            productionBonus: production.approved.toFixed(2),
            pendingProductionBonus: production.pending.toFixed(2),
            rejectedProductionBonus: production.rejected.toFixed(2),
            otherBonuses: Math.max(0, Number(payroll.bonuses ?? 0) - production.approved).toFixed(2),
          };
        })
      );
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
