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
import { deleteInfrastructurePostingIdentityForVoucherTx } from "../../../services/accounting/infrastructureVoucherIdentity";
import {
  allocatePayrollAccountingAmounts,
  moneyFromCents,
} from "../../../services/accounting/payrollAccountingAmounts";
import { eq, and, sql, gte, lte, inArray } from "drizzle-orm";
import {
  factoryWorkers,
  factoryPayrolls,
  factoryWorkerAdvances,
  factoryWorkerDeductions,
  factoryAttendance,
  vouchers,
  voucherEntries,
} from "@shared/schema";
import {
  computeMonthlyPay,
  computeMonthlyPayFromAttendance,
  findOrCreateLedger,
  getFactoryCompanyId,
  normUsd,
  settleAdvancesForPayroll,
  writeDaybookEntry,
} from "./_helpers";

export function registerPayrollGenerateRoutes(app: Express) {
  // POST /api/factory/payrolls/generate-bulk - Generate draft payrolls for multiple workers
  app.post("/api/factory/payrolls/generate-bulk", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.body.companyId || getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
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
      const bonus = parseFloat(bonusPerWorker || "0");

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

      const daysInMonth = (d: string) => {
        const dt = new Date(d);
        return new Date(dt.getFullYear(), dt.getMonth() + 1, 0).getDate();
      };

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
      const advanceByWorker: Record<number, number> = {};
      for (const adv of allOutstandingAdvances) {
        advanceByWorker[adv.workerId] = (advanceByWorker[adv.workerId] || 0) + parseFloat(adv.remainingBalance || "0");
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
      const deductionAmtByWorker: Record<number, number> = {};
      for (const ded of allPendingDeductions) {
        deductionAmtByWorker[ded.workerId] = (deductionAmtByWorker[ded.workerId] || 0) + parseFloat(ded.amount || "0");
      }

      // Pre-resolve per-worker ledger accounts OUTSIDE the transaction
      // Sequential calls to avoid simultaneous MAX(code) reads returning the same nextCode
      const payableAccGen = await findOrCreateLedger(companyId, "Payroll Payable", "Liability");
      const advancesAccGen = await findOrCreateLedger(companyId, "Factory Worker Advances", "Asset");
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
          const baseSal = parseFloat(worker.baseSalary || "0");
          const freq = worker.payFrequency || worker.salaryType || "Monthly";
          let base: number;
          if (freq === "Weekly") base = (days / 7) * parseFloat(worker.weeklySalary || baseSal.toString());
          else if (freq === "Bi-Weekly") base = (days / 14) * parseFloat(worker.biWeeklySalary || baseSal.toString());
          else if (freq === "Daily" || worker.salaryType === "Daily") base = days * baseSal;
          else {
            // Monthly: use attendance-based calculation if records exist
            const workerAttRecords = attendanceByWorker.get(worker.id) || [];
            if (workerAttRecords.length === 0) {
              base = computeMonthlyPay(baseSal, periodStart, periodEnd);
            } else {
              base = computeMonthlyPayFromAttendance(baseSal, periodStart, workerAttRecords);
            }
          }
          // Transport allowance — prorated by: (presentDays / daysInMonth) * monthlyRate
          // Using the full month days (not period days) as denominator so two
          // half-month runs add up to exactly the monthly allowance.
          const workerAttRecs2 = attendanceByWorker.get(worker.id) || [];
          let presentDays2 = 0;
          for (const att of workerAttRecs2) {
            if (att.status === "Present" || att.status === "Late" || att.status === "Leave") presentDays2 += 1;
            else if (att.status === "Half Day") presentDays2 += 0.5;
          }

          const monthDaysForTransport = daysInMonth(periodStart);
          const workerTransportDefault2 = parseFloat(worker.transportAllowance || "0");
          const transportOverrideAmt2 = transportOverrides
            ? parseFloat(transportOverrides[String(worker.id)] ?? "-1")
            : -1;
          const transportMonthly2 = transportOverrideAmt2 >= 0 ? transportOverrideAmt2 : workerTransportDefault2;
          let transport = 0;
          if (transportMonthly2 > 0) {
            if (workerAttRecs2.length > 0 && monthDaysForTransport > 0) {
              transport = (presentDays2 / monthDaysForTransport) * transportMonthly2;
            } else {
              transport = transportMonthly2;
            }
          }

          const workerAdvanceBalance = advanceByWorker[worker.id] || 0;
          // Use user-approved override if provided, otherwise auto-deduct full balance
          const overrideAmt = advanceOverrides ? parseFloat(advanceOverrides[String(worker.id)] ?? "-1") : -1;
          const advanceDeduction =
            overrideAmt >= 0
              ? Math.min(overrideAmt, base + bonus + transport, workerAdvanceBalance)
              : Math.min(workerAdvanceBalance, base + bonus + transport);
          // Include pending worker deductions
          const workerPendingDeductions = deductionAmtByWorker[worker.id] || 0;
          const net = base + bonus + transport - advanceDeduction - workerPendingDeductions;
          const accounting = allocatePayrollAccountingAmounts({
            netSalary: net,
            advances: advanceDeduction,
            bonus,
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
        // Accounting: Dr per-worker Salary/Bonus Expense / Cr Payroll Payable (net) / Cr Factory Worker Advances
        const totalGrossCents = totalNetCents + totalAdvanceDeductionsCents;
        if (totalGrossCents > 0) {
          // ── Dedup guard: remove any existing PAYROLL-GEN vouchers for this period ──
          // Prevents duplicate expense vouchers when payroll is regenerated (e.g. after a data pull).
          const staleGenVouchers = await tx
            .select({ id: vouchers.id })
            .from(vouchers)
            .where(
              and(
                eq(vouchers.companyId, companyId),
                sql`${vouchers.voucherNumber} LIKE 'PAYROLL-GEN-%'`,
                eq(vouchers.voucherDate, periodStart),
                sql`${vouchers.description} LIKE ${"%" + periodEnd + "%"}`
              )
            );
          if (staleGenVouchers.length > 0) {
            const vIds = staleGenVouchers.map((v) => v.id);
            // Rebuilt PAYROLL-GEN vouchers can have a durable accounting posting
            // identity that references the voucher with ON DELETE RESTRICT. Remove
            // that marker first so regeneration can safely replace old vouchers.
            for (const voucherId of vIds) {
              await deleteInfrastructurePostingIdentityForVoucherTx(tx, voucherId);
            }
            await tx.delete(voucherEntries).where(inArray(voucherEntries.voucherId, vIds));
            await tx.delete(vouchers).where(inArray(vouchers.id, vIds));
          }

          const desc = `Payroll expense: ${count} worker${count !== 1 ? "s" : ""} (${periodStart} – ${periodEnd})`;
          const [genVoucher] = await tx
            .insert(vouchers)
            .values({
              companyId,
              voucherNumber: `PAYROLL-GEN-${Date.now()}`,
              voucherType: "Journal",
              voucherDate: periodStart,
              description: desc,
              totalAmount: moneyFromCents(totalGrossCents),
              currency: "USD",
              sourceModule: "FACTORY",
            })
            .returning();
          const journalEntries = [];
          // DR entries per worker (one salary line + one bonus line each)
          for (const { workerId, workerName, salAmt, bonAmt } of workerExpenses) {
            const accs = workerAccCache.get(workerId)!;
            if (Number(salAmt) > 0) {
              journalEntries.push({
                voucherId: genVoucher.id,
                ledgerAccountId: accs.salaryId,
                ...normUsd(salAmt, "0"),
                narration: `Salary - ${workerName} (${periodStart} – ${periodEnd})`,
              });
            }
            if (Number(bonAmt) > 0) {
              journalEntries.push({
                voucherId: genVoucher.id,
                ledgerAccountId: accs.bonusId,
                ...normUsd(bonAmt, "0"),
                narration: `Bonus - ${workerName} (${periodStart} – ${periodEnd})`,
              });
            }
          }
          if (totalNetCents > 0) {
            journalEntries.push({
              voucherId: genVoucher.id,
              ledgerAccountId: payableAccGen.id,
              ...normUsd("0", moneyFromCents(totalNetCents)),
              narration: desc,
            });
          }
          // Credit Factory Worker Advances to reduce the asset as deductions are settled
          if (totalAdvanceDeductionsCents > 0) {
            journalEntries.push({
              voucherId: genVoucher.id,
              ledgerAccountId: advancesAccGen.id,
              ...normUsd("0", moneyFromCents(totalAdvanceDeductionsCents)),
              narration: `Advance deductions settled - ${count} worker${count !== 1 ? "s" : ""} (${periodStart} – ${periodEnd})`,
            });
          }
          await tx.insert(voucherEntries).values(journalEntries);
        }
        const totalNet = Number(moneyFromCents(totalNetCents));
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
