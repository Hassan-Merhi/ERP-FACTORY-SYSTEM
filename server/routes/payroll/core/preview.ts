/**
 * payrollCoreRoutes: PayrollPreview endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { eq, and, gte, lte, inArray } from "drizzle-orm";
import { factoryWorkers, factoryWorkerAdvances, factoryWorkerDeductions, factoryAttendance } from "@shared/schema";
import type Decimal from "decimal.js";
import { MoneyDecimal, parseMoneyInput, toMoney } from "../../../lib/money";
import { getFactoryCompanyId } from "./_helpers";
import { computeWorkerPayAmounts, daysInMonthOf } from "./workerPayAmounts";
import { registerPayrollPreviewRoutesPart1 } from "./registerPayrollPreviewRoutesPart1";

export function registerPayrollPreviewRoutes(app: Express) {
  // POST /api/factory/payrolls/preview - Preview payroll calculation with attendance breakdown (no DB writes)
  app.post("/api/factory/payrolls/preview", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.body.companyId || getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const { workerIds, periodStart, periodEnd, daysCount, bonusPerWorker, transportOverrides } = req.body;
      if (!periodStart || !periodEnd) return res.status(400).json({ message: "Period dates required" });

      const days = daysCount
        ? parseInt(daysCount)
        : Math.floor((new Date(periodEnd).getTime() - new Date(periodStart).getTime()) / (1000 * 60 * 60 * 24)) + 1;
      const parsedBonus = parseMoneyInput(bonusPerWorker || "0");
      if (!parsedBonus) return res.status(400).json({ message: "Invalid amount" });
      // Same cents as generate-bulk, so the preview shows what will be stored.
      const bonus = parsedBonus.toDecimalPlaces(2);
      const transportOverrideFor = (workerId: number) => {
        const value = transportOverrides?.[String(workerId)];
        if (value === undefined || value === null) return null;
        const parsed = parseMoneyInput(value);
        return parsed && parsed.gte(0) ? parsed : null;
      };

      let targetWorkers;
      if (workerIds && workerIds.length > 0) {
        targetWorkers = await db
          .select()
          .from(factoryWorkers)
          .where(and(eq(factoryWorkers.companyId, companyId), inArray(factoryWorkers.id, workerIds)));
      } else {
        targetWorkers = await db
          .select()
          .from(factoryWorkers)
          .where(and(eq(factoryWorkers.companyId, companyId), eq(factoryWorkers.active, true)));
      }

      // Fetch all attendance records for the period in one query
      const workerIdList = targetWorkers.map((w) => w.id);
      const attendanceRecords = workerIdList.length
        ? await db
            .select()
            .from(factoryAttendance)
            .where(
              and(
                eq(factoryAttendance.companyId, companyId),
                gte(factoryAttendance.attendanceDate, periodStart),
                lte(factoryAttendance.attendanceDate, periodEnd),
                inArray(factoryAttendance.workerId, workerIdList)
              )
            )
        : [];

      const attendanceByWorker = new Map();
      for (const att of attendanceRecords) {
        const list = attendanceByWorker.get(att.workerId) || [];
        list.push(att);
        attendanceByWorker.set(att.workerId, list);
      }

      // Outstanding advances — all unpaid (both salary_deduction and manual_repayment/loan)
      const allAdvances = await db
        .select()
        .from(factoryWorkerAdvances)
        .where(and(eq(factoryWorkerAdvances.companyId, companyId), eq(factoryWorkerAdvances.fullyPaid, false)))
        .orderBy(factoryWorkerAdvances.advanceDate);
      // Separate salary-deduction advances (auto-deducted from pay) from loans (informational only)
      const advanceByWorker: Record<number, Decimal> = {};
      const advanceListByWorker: Record<number, typeof allAdvances> = {};
      const loanListByWorker: Record<number, typeof allAdvances> = {};
      const loanBalByWorker: Record<number, Decimal> = {};
      for (const adv of allAdvances) {
        if (adv.repaymentType === "salary_deduction") {
          advanceByWorker[adv.workerId] = (advanceByWorker[adv.workerId] ?? new MoneyDecimal(0)).plus(
            toMoney(adv.remainingBalance)
          );
          if (!advanceListByWorker[adv.workerId]) advanceListByWorker[adv.workerId] = [];
          advanceListByWorker[adv.workerId].push(adv);
        } else {
          loanBalByWorker[adv.workerId] = (loanBalByWorker[adv.workerId] ?? new MoneyDecimal(0)).plus(
            toMoney(adv.remainingBalance)
          );
          if (!loanListByWorker[adv.workerId]) loanListByWorker[adv.workerId] = [];
          loanListByWorker[adv.workerId].push(adv);
        }
      }

      // Pending one-time salary deductions (factoryWorkerDeductions table)
      const allPendingDeductions = await db
        .select()
        .from(factoryWorkerDeductions)
        .where(and(eq(factoryWorkerDeductions.companyId, companyId), eq(factoryWorkerDeductions.applied, false)));
      const pendingDeductionByWorker: Record<number, Decimal> = {};
      const pendingDeductionRecordsByWorker: Record<
        number,
        { id: number; amount: string; reason: string | null; deductionDate: string }[]
      > = {};
      for (const ded of allPendingDeductions) {
        pendingDeductionByWorker[ded.workerId] = (pendingDeductionByWorker[ded.workerId] ?? new MoneyDecimal(0)).plus(
          toMoney(ded.amount)
        );
        if (!pendingDeductionRecordsByWorker[ded.workerId]) pendingDeductionRecordsByWorker[ded.workerId] = [];
        pendingDeductionRecordsByWorker[ded.workerId].push({
          id: ded.id,
          amount: ded.amount,
          reason: ded.reason,
          deductionDate: ded.deductionDate,
        });
      }

      // Transport denominator = total days in the MONTH of periodStart.
      // This ensures two half-month runs (e.g. Apr 1-15 + Apr 16-30) add up to
      // exactly the full monthly transport allowance for a fully-present worker.
      // e.g. for April (30 days): daily rate = $80/30 = $2.67 → 15d = $40
      const transportMonthDays = daysInMonthOf(periodStart);

      const result = targetWorkers.map((worker) => {
        // Attendance breakdown shown next to the amounts
        const workerAttRecs = attendanceByWorker.get(worker.id) || [];
        let presentDays = 0;
        let absentDays = 0;
        const presentDates: { date: string; status: string }[] = [];
        const absentDates: { date: string; status: string }[] = [];
        const halfDayDates: { date: string; status: string }[] = [];

        for (const att of workerAttRecs) {
          const entry = { date: att.attendanceDate, status: att.status };
          if (att.status === "Present" || att.status === "Late" || att.status === "Leave") {
            presentDays += 1;
            presentDates.push(entry);
          } else if (att.status === "Half Day") {
            presentDays += 0.5;
            absentDays += 0.5;
            halfDayDates.push(entry);
          } else if (att.status === "Absent") {
            absentDays += 1;
            absentDates.push(entry);
          }
        }

        presentDates.sort((a, b) => a.date.localeCompare(b.date));
        absentDates.sort((a, b) => a.date.localeCompare(b.date));
        halfDayDates.sort((a, b) => a.date.localeCompare(b.date));

        const totalAdvanceBalance = advanceByWorker[worker.id] ?? new MoneyDecimal(0);
        const pendingDeductionRecords = pendingDeductionRecordsByWorker[worker.id] || [];
        const pay = computeWorkerPayAmounts({
          worker,
          days,
          periodStart,
          periodEnd,
          attendance: workerAttRecs,
          bonus,
          transportOverride: transportOverrideFor(worker.id),
          advanceBalance: totalAdvanceBalance,
          advanceOverride: null,
          pendingDeductions: pendingDeductionByWorker[worker.id] ?? new MoneyDecimal(0),
        });
        const pendingAdvances = (advanceListByWorker[worker.id] || []).map((a) => ({
          id: a.id,
          advanceDate: a.advanceDate,
          amount: a.amount,
          remainingBalance: a.remainingBalance,
          notes: a.notes,
          repaymentType: a.repaymentType,
        }));
        const outstandingLoans = (loanListByWorker[worker.id] || []).map((a) => ({
          id: a.id,
          advanceDate: a.advanceDate,
          amount: a.amount,
          remainingBalance: a.remainingBalance,
          notes: a.notes,
          repaymentType: a.repaymentType,
        }));
        const totalLoanBalance = loanBalByWorker[worker.id] ?? new MoneyDecimal(0);

        return {
          id: worker.id,
          employeeCode: worker.employeeCode || null,
          name: worker.fullName,
          position: worker.position || null,
          base: pay.base.toNumber(),
          bonus: bonus.toNumber(),
          transport: pay.transport.toNumber(),
          transportMonthly: pay.transportMonthly.toNumber(),
          advanceDeduction: pay.advanceDeduction.toNumber(),
          totalAdvanceBalance: totalAdvanceBalance.toNumber(),
          pendingAdvances,
          pendingDeductions: pay.pendingDeductions.toNumber(),
          pendingDeductionRecords,
          outstandingLoans,
          totalLoanBalance: totalLoanBalance.toNumber(),
          net: pay.net.toNumber(),
          totalWorkingDays: transportMonthDays, // full month days — denominator used for proration
          presentDays,
          absentDays,
          presentDates,
          absentDates,
          halfDayDates,
        };
      });

      res.json(result);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
  registerPayrollPreviewRoutesPart1(app);
}
