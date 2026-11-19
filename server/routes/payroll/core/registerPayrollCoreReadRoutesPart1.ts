// Extracted from ./reads.ts
import type { Express, Request, Response } from "express";
import { parseOptionalId } from "../../../lib/parseId";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { getClientDate } from "../../../lib/dateUtils";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { eq, and, desc, gte, lte, inArray } from "drizzle-orm";
import { factoryWorkers, factoryPayrolls, factoryWorkerAdvances, factoryAttendance } from "@shared/schema";
import type Decimal from "decimal.js";
import { MoneyDecimal, toMoney, type MoneyInput } from "../../../lib/money";
import { getFactoryCompanyId } from "./_helpers";
import { exactMonthlyPay } from "./workerPayAmounts";

export function registerPayrollCoreReadRoutesPart1(app: Express) {
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
      const advanceTotals = new Map<number, Decimal>();
      for (const advance of advanceRows) {
        advanceTotals.set(
          advance.workerId,
          (advanceTotals.get(advance.workerId) ?? new MoneyDecimal(0)).plus(toMoney(advance.remaining))
        );
      }
      const advanceMap: Record<number, number> = {};
      for (const [workerId, total] of advanceTotals) advanceMap[workerId] = total.toNumber();

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

      const round2 = (n: MoneyInput) => toMoney(n).toDecimalPlaces(2).toNumber();
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
        const baseSal = toMoney(worker.baseSalary);
        const transport = toMoney(worker.transportAllowance);
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

        const grossBase = exactMonthlyPay(baseSal, periodStart, todayStr);
        const grossTransport = exactMonthlyPay(transport, periodStart, todayStr);
        let absenceDays = 0;
        let absDeductBase: Decimal = new MoneyDecimal(0);
        let absDeductTransport: Decimal = new MoneyDecimal(0);
        for (const attendance of attendanceByWorker[worker.id] ?? []) {
          if (attendance.date < periodStart || attendance.date > todayStr) continue;
          const dim = getDIM(attendance.date);
          if (attendance.status === "Absent") {
            absenceDays += 1;
            absDeductBase = absDeductBase.plus(baseSal.div(dim));
            absDeductTransport = absDeductTransport.plus(transport.div(dim));
          } else if (attendance.status === "Half Day") {
            absenceDays += 0.5;
            absDeductBase = absDeductBase.plus(baseSal.div(dim).times(0.5));
            absDeductTransport = absDeductTransport.plus(transport.div(dim).times(0.5));
          }
        }

        const zero = new MoneyDecimal(0);
        const base = MoneyDecimal.max(zero, grossBase.minus(absDeductBase));
        const transportDue = MoneyDecimal.max(zero, grossTransport.minus(absDeductTransport));
        const absenceDeducted = absDeductBase.plus(absDeductTransport);
        const advanceBalance = toMoney(advanceMap[worker.id]);
        const advanceDeducted = MoneyDecimal.min(advanceBalance, base.plus(transportDue));
        const net = MoneyDecimal.max(zero, base.plus(transportDue).minus(advanceDeducted));
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
}
