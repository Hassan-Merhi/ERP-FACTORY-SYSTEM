/**
 * payrollCoreRoutes: PayrollGenerate endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import {
  allocatePayrollAccountingAmounts,
  moneyFromCents,
} from "../../../services/accounting/payrollAccountingAmounts";
import { eq, and, gte, lte, inArray } from "drizzle-orm";
import type Decimal from "decimal.js";
import { MoneyDecimal, parseMoneyInput, toMoney } from "../../../lib/money";
import {
  factoryWorkers,
  factoryPayrolls,
  factoryWorkerAdvances,
  factoryWorkerDeductions,
  factoryAttendance,
} from "@shared/schema";
import { findOrCreateLedger, getFactoryCompanyId, settleAdvancesForPayroll, writeDaybookEntry } from "./_helpers";
import { computeWorkerPayAmounts } from "./workerPayAmounts";
import { rebuildPayrollGenVoucher } from "../_payrollAccountingHelper";
import { PAYROLL_COMPANY_MISMATCH_MESSAGE } from "./mark-paid";

export function registerPayrollGenerateRoutes(app: Express) {
  // POST /api/factory/payrolls/generate-bulk - Generate draft payrolls for multiple workers
  app.post("/api/factory/payrolls/generate-bulk", requireAuth, async (req: Request, res: Response) => {
    try {
      // Phase 28 (F12): the session's company; a body naming another company is refused.
      const companyId = getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      if (
        req.body.companyId !== undefined &&
        req.body.companyId !== null &&
        Number(req.body.companyId) !== Number(companyId)
      ) {
        return res.status(403).json({ code: "PAYROLL_COMPANY_MISMATCH", message: PAYROLL_COMPANY_MISMATCH_MESSAGE });
      }
      const {
        workerIds,
        periodStart,
        periodEnd,
        daysCount,
        bonusPerWorker,
        cashAccountId,
        notes,
        advanceOverrides,
        transportOverrides,
      } = req.body;
      if (!periodStart || !periodEnd) return res.status(400).json({ message: "Period dates required" });
      // advanceOverrides: { [workerId: string]: number } — user-approved deduction per worker

      const days = daysCount
        ? parseInt(daysCount)
        : Math.floor((new Date(periodEnd).getTime() - new Date(periodStart).getTime()) / (1000 * 60 * 60 * 24)) + 1;
      const parsedBonus = parseMoneyInput(bonusPerWorker || "0");
      if (!parsedBonus) return res.status(400).json({ message: "Invalid amount" });
      // Every payroll component is taken at cents so the stored parts add up to the stored net.
      const bonus = parsedBonus.toDecimalPlaces(2);
      /** A per-worker override from the request, or null when absent or unparsable (the default applies). */
      const overrideFor = (overrides: Record<string, unknown> | undefined, workerId: number) => {
        const value = overrides?.[String(workerId)];
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

      // Fetch all attendance records for the period (for monthly attendance-based calculation)
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

      const allOutstandingAdvances = await db
        .select()
        .from(factoryWorkerAdvances)
        .where(
          and(
            eq(factoryWorkerAdvances.companyId, companyId),
            eq(factoryWorkerAdvances.fullyPaid, false),
            eq(factoryWorkerAdvances.repaymentType, "salary_deduction")
          )
        );
      const advanceByWorker: Record<number, Decimal> = {};
      for (const adv of allOutstandingAdvances) {
        advanceByWorker[adv.workerId] = (advanceByWorker[adv.workerId] ?? new MoneyDecimal(0)).plus(
          toMoney(adv.remainingBalance)
        );
      }

      // Fetch pending (unapplied) deductions per worker
      const allPendingDeductions = await db
        .select()
        .from(factoryWorkerDeductions)
        .where(and(eq(factoryWorkerDeductions.companyId, companyId), eq(factoryWorkerDeductions.applied, false)));
      const deductionByWorker: Record<number, number[]> = {};
      for (const ded of allPendingDeductions) {
        if (!deductionByWorker[ded.workerId]) deductionByWorker[ded.workerId] = [];
        deductionByWorker[ded.workerId].push(ded.id);
      }
      const deductionAmtByWorker: Record<number, Decimal> = {};
      for (const ded of allPendingDeductions) {
        deductionAmtByWorker[ded.workerId] = (deductionAmtByWorker[ded.workerId] ?? new MoneyDecimal(0)).plus(
          toMoney(ded.amount)
        );
      }

      // Pre-resolve per-worker ledger accounts OUTSIDE the transaction
      // Sequential calls to avoid simultaneous MAX(code) reads returning the same nextCode
      await findOrCreateLedger(companyId, "Payroll Payable", "Liability");
      await findOrCreateLedger(companyId, "Factory Worker Advances", "Asset");
      // Ensure group header accounts exist — worker accounts nest under them in the chart of accounts
      const salaryGroupAcc = await findOrCreateLedger(companyId, "Salary Expense - Workers", "Expense", {
        subType: "Group",
      });
      const bonusGroupAcc = await findOrCreateLedger(companyId, "Bonus Expense - Workers", "Expense", {
        subType: "Group",
      });
      // Map: workerId → { salaryId, bonusId } — each worker gets their own named expense account
      const workerAccCache = new Map<number, { salaryId: number; bonusId: number }>();
      for (const worker of targetWorkers) {
        const workerName = (worker.fullName as string) || `Worker #${worker.id}`;
        const sa = await findOrCreateLedger(companyId, `Salary Expense - ${workerName}`, "Expense", {
          parentId: salaryGroupAcc.id,
        });
        const ba = await findOrCreateLedger(companyId, `Bonus Expense - ${workerName}`, "Expense", {
          parentId: bonusGroupAcc.id,
        });
        workerAccCache.set(worker.id, { salaryId: sa.id, bonusId: ba.id });
      }

      const created = await db.transaction(async (tx) => {
        let count = 0;
        let totalNetCents = 0;
        let totalAdvanceDeductionsCents = 0;
        // Track the exact persisted two-decimal worker values used by accounting.
        const workerExpenses: { workerId: number; workerName: string; salAmt: string; bonAmt: string }[] = [];
        for (const worker of targetWorkers) {
          const {
            base,
            transport,
            advanceDeduction,
            pendingDeductions: workerPendingDeductions,
            net,
          } = computeWorkerPayAmounts({
            worker,
            days,
            periodStart,
            periodEnd,
            attendance: attendanceByWorker.get(worker.id) || [],
            bonus,
            transportOverride: overrideFor(transportOverrides, worker.id),
            advanceBalance: advanceByWorker[worker.id] ?? new MoneyDecimal(0),
            advanceOverride: overrideFor(advanceOverrides, worker.id),
            pendingDeductions: deductionAmtByWorker[worker.id] ?? new MoneyDecimal(0),
          });
          const accounting = allocatePayrollAccountingAmounts({
            netSalary: net.toFixed(2),
            advances: advanceDeduction.toFixed(2),
            bonus: bonus.toFixed(2),
          });
          const workerName = (worker.fullName as string) || `Worker #${worker.id}`;
          workerExpenses.push({
            workerId: worker.id,
            workerName,
            salAmt: accounting.salaryExpense,
            bonAmt: accounting.bonusExpense,
          });
          const [newPayroll] = await tx
            .insert(factoryPayrolls)
            .values({
              companyId,
              workerId: worker.id,
              periodStart,
              periodEnd,
              baseSalary: base.toFixed(2),
              bonuses: bonus.toFixed(2),
              transport: transport.toFixed(2),
              baleEarnings: "0",
              kgEarnings: "0",
              overtimePay: "0",
              deductions: workerPendingDeductions.toFixed(2),
              advances: accounting.advances,
              netSalary: accounting.netSalary,
              balesCount: 0,
              kgProcessed: "0",
              overtimeHours: "0",
              status: "DRAFT",
              notes: notes || null,
              cashAccountId: cashAccountId ? parseInt(cashAccountId) : null,
            })
            .returning({ id: factoryPayrolls.id });
          // Mark pending deductions as applied
          if (deductionByWorker[worker.id]?.length) {
            await tx
              .update(factoryWorkerDeductions)
              .set({ applied: true, payrollId: newPayroll.id })
              .where(inArray(factoryWorkerDeductions.id, deductionByWorker[worker.id]));
          }
          // Settle the same cent-exact advance amount persisted on the payroll.
          await settleAdvancesForPayroll(tx, companyId, worker.id, Number(accounting.advances));
          totalNetCents += accounting.netCents;
          totalAdvanceDeductionsCents += accounting.advanceCents;
          count++;
        }
        // Phase 28 (F12): the period's accrual is rebuilt from EVERY payroll of
        // the period (rebuildPayrollGenVoucher, the reviewed rebuild the payroll
        // edit, delete and bonus paths use): the old journal is retired and one
        // PAYROLL-GEN journal posted for all of them. Before, this route retired
        // the period's journal and re-posted it from this batch only, so a second
        // batch for the same period dropped the first batch's expense and payable.
        if (totalNetCents + totalAdvanceDeductionsCents > 0) {
          await rebuildPayrollGenVoucher(tx, companyId, periodStart, periodEnd);
        }
        const totalNet = toMoney(moneyFromCents(totalNetCents)).toNumber();
        await writeDaybookEntry(tx, {
          companyId,
          txDate: periodStart,
          txType: "PAYROLL_GENERATED",
          description: `Payroll generated: ${count} worker${count !== 1 ? "s" : ""} for period ${periodStart} – ${periodEnd}`,
          amountCurrency: totalNet,
          amountUsd: totalNet,
        });
        return count;
      });
      res.json({ created });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
