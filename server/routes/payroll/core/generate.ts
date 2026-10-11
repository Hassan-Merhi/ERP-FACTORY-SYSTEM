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
import { eq, and, sql, gte, lte, inArray } from "drizzle-orm";
import type Decimal from "decimal.js";
import { MoneyDecimal, parseMoneyInput, toMoney } from "../../../lib/money";
import {
  factoryWorkers,
  factoryPayrolls,
  factoryWorkerAdvances,
  factoryWorkerDeductions,
  factoryAttendance,
  vouchers,
} from "@shared/schema";
import { findOrCreateLedger, getFactoryCompanyId, settleAdvancesForPayroll, writeDaybookEntry } from "./_helpers";
import { computeWorkerPayAmounts } from "./workerPayAmounts";
import { retireVouchersTx, sessionRetirementActor } from "../../../services/accounting/voucherRetirement";
import {
  postErpVoucherTx,
  sessionPostingActor,
  type ErpVoucherLine,
} from "../../../services/accounting/erpVoucherPosting";

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
            // Wave 16 (A): retired (soft delete with lines, audited here), not hard-deleted.
            await retireVouchersTx(tx, {
              companyId,
              voucherIds: vIds,
              reason: "payroll-generation-rebuild",
              actor: sessionRetirementActor(req),
            });
          }

          const desc = `Payroll expense: ${count} worker${count !== 1 ? "s" : ""} (${periodStart} – ${periodEnd})`;
          // Phase 22 (B): through the central engine. The PAYROLL-GEN- prefix is
          // kept (the dedup guard above, the integrity diagnostic and the
          // worker-statement repair find the journal by it), with the company
          // and period as a deterministic suffix instead of Date.now() (voucher
          // numbers are unique across companies). A rebuild retires the
          // old journal first, which releases its number and posting identity.
          const journalLines: ErpVoucherLine[] = [];
          // DR entries per worker (one salary line + one bonus line each)
          for (const { workerName, workerId, salAmt, bonAmt } of workerExpenses) {
            const accs = workerAccCache.get(workerId)!;
            journalLines.push({
              ledgerAccountId: accs.salaryId,
              debit: salAmt,
              narration: `Salary - ${workerName} (${periodStart} – ${periodEnd})`,
            });
            journalLines.push({
              ledgerAccountId: accs.bonusId,
              debit: bonAmt,
              narration: `Bonus - ${workerName} (${periodStart} – ${periodEnd})`,
            });
          }
          journalLines.push({
            ledgerAccountId: payableAccGen.id,
            credit: moneyFromCents(totalNetCents),
            narration: desc,
          });
          // Credit Factory Worker Advances to reduce the asset as deductions are settled
          journalLines.push({
            ledgerAccountId: advancesAccGen.id,
            credit: moneyFromCents(totalAdvanceDeductionsCents),
            narration: `Advance deductions settled - ${count} worker${count !== 1 ? "s" : ""} (${periodStart} – ${periodEnd})`,
          });
          await postErpVoucherTx(tx, {
            companyId,
            voucherNumber: `PAYROLL-GEN-${companyId}-${periodStart}-${periodEnd}`,
            voucherType: "Journal",
            voucherDate: periodStart,
            description: desc,
            sourceModule: "FACTORY",
            lines: journalLines,
            source: { type: "payroll-generation", id: `${companyId}:${periodStart}:${periodEnd}` },
            actor: sessionPostingActor(req, "Payroll generation"),
          });
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
