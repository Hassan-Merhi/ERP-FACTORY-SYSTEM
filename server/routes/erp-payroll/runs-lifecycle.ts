/**
 * payrollRoutes: PayrollRunLifecycle endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { eq, and, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../../db";
import { storage } from "../../storage";
import { requireAuth, requireNonPOS } from "../../auth";
import { erpPayrollRunItems, erpPayrollRuns, factoryWorkerDeductions, salaryAdvanceDeductions, salaryAdvances, vouchers } from "@shared/schema";

export function registerPayrollRunLifecycleRoutes(app: Express) {
  // Delete a DRAFT payroll run
  app.delete("/api/payroll/runs/:id", requireAuth, requireNonPOS, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const runId = parseInt(req.params.id);
      const [run] = await db
        .select()
        .from(erpPayrollRuns)
        .where(and(eq(erpPayrollRuns.id, runId), eq(erpPayrollRuns.companyId, companyId)));
      if (!run) return res.status(404).json({ message: "Payroll run not found" });
      if (run.status === "PAID") return res.status(400).json({ message: "Cannot delete a paid run" });
      await db.delete(erpPayrollRunItems).where(eq(erpPayrollRunItems.runId, runId));
      await db.delete(erpPayrollRuns).where(eq(erpPayrollRuns.id, runId));
      res.json({ message: "Deleted" });
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  // ── Undo a PAID payroll run ───────────────────────────────────────────────
  app.post("/api/payroll/runs/:id/undo", requireAuth, requireNonPOS, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const runId = parseInt(req.params.id);
      const [run] = await db
        .select()
        .from(erpPayrollRuns)
        .where(and(eq(erpPayrollRuns.id, runId), eq(erpPayrollRuns.companyId, companyId)));
      if (!run) return res.status(404).json({ message: "Payroll run not found" });
      if (run.status !== "PAID") return res.status(400).json({ message: "Only PAID runs can be undone" });

      await db.transaction(async (tx) => {
        // 1. Find and soft-delete the SAL- voucher tied to this run
        const salVouchers = await tx
          .select()
          .from(vouchers)
          .where(
            and(
              eq(vouchers.companyId, companyId),
              sql`${vouchers.voucherNumber} LIKE ${"SAL-" + runId + "-%"}`,
              isNull(vouchers.deletedAt)
            )
          );
        for (const v of salVouchers) {
          await tx.update(vouchers).set({ deletedAt: new Date() }).where(eq(vouchers.id, v.id));
        }

        // 2. Reverse advance deductions for each run item
        const runItems = await tx.select().from(erpPayrollRunItems).where(eq(erpPayrollRunItems.runId, runId));
        const payMonth = run.date.substring(0, 7);

        for (const item of runItems) {
          const deductAmt = parseFloat(item.deduction || "0");
          if (deductAmt <= 0 || !item.employeeId) continue;

          // Find advance deductions recorded for this payroll month for this employee's advances
          const empAdvances = await tx
            .select({ id: salaryAdvances.id })
            .from(salaryAdvances)
            .where(and(eq(salaryAdvances.employeeId, item.employeeId), eq(salaryAdvances.companyId, companyId)));
          const advanceIds = empAdvances.map((a) => a.id);
          if (advanceIds.length === 0) continue;

          const deductions = await tx
            .select()
            .from(salaryAdvanceDeductions)
            .where(
              and(
                inArray(salaryAdvanceDeductions.salaryAdvanceId, advanceIds),
                eq(salaryAdvanceDeductions.payrollMonth, payMonth)
              )
            );

          for (const ded of deductions) {
            const dedAmt = parseFloat(ded.deductionAmount || "0");
            const [adv] = await tx.select().from(salaryAdvances).where(eq(salaryAdvances.id, ded.salaryAdvanceId));
            if (!adv) continue;
            const restoredBal = parseFloat(adv.remainingBalance || "0") + dedAmt;
            const originalAmt = parseFloat(adv.amount || "0");
            const newBal = Math.min(restoredBal, originalAmt);
            await tx
              .update(salaryAdvances)
              .set({ remainingBalance: newBal.toFixed(2), fullyPaid: false })
              .where(eq(salaryAdvances.id, adv.id));
            await tx.delete(salaryAdvanceDeductions).where(eq(salaryAdvanceDeductions.id, ded.id));
          }
        }

        // 3. Restore one-time worker deductions applied by this ERP payroll run.
        await tx
          .update(factoryWorkerDeductions)
          .set({ applied: false, erpPayrollRunId: null })
          .where(
            and(
              eq(factoryWorkerDeductions.companyId, companyId),
              eq(factoryWorkerDeductions.erpPayrollRunId, runId)
            )
          );

        // 4. Reset run to DRAFT
        await tx
          .update(erpPayrollRuns)
          .set({ status: "DRAFT", paymentAccountId: null, paidAt: null })
          .where(eq(erpPayrollRuns.id, runId));
      });

      res.json({ message: "Payroll run reversed to draft" });
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  // ── Diagnostic: what does the server see for paid payroll runs? ──
  app.get("/api/payroll/runs/diagnostic", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const allRuns = await db.select().from(erpPayrollRuns).where(eq(erpPayrollRuns.companyId, companyId));
      const paidRuns = allRuns.filter((r) => r.status === "PAID");

      const allAccounts = await storage.getAllLedgerAccounts(companyId);
      const salaryExpenseAccount = allAccounts.find((a) => a.code === "SALARY_EXPENSE");

      const runDetails = await Promise.all(
        paidRuns.map(async (run) => {
          const items = await db.select().from(erpPayrollRunItems).where(eq(erpPayrollRunItems.runId, run.id));
          const salVouchers = await db
            .select()
            .from(vouchers)
            .where(
              and(
                eq(vouchers.companyId, companyId),
                sql`${vouchers.voucherNumber} LIKE ${"SAL-" + run.id + "-%"}`,
                isNull(vouchers.deletedAt)
              )
            );
          const allVouchersForRun = await db
            .select()
            .from(vouchers)
            .where(
              and(eq(vouchers.companyId, companyId), sql`${vouchers.voucherNumber} LIKE ${"SAL-" + run.id + "-%"}`)
            );
          return {
            runId: run.id,
            status: run.status,
            date: run.date,
            itemCount: items.length,
            itemGroupNames: [...new Set(items.map((i) => i.groupName || "(none)"))],
            salVouchersActive: salVouchers.map((v) => ({ id: v.id, number: v.voucherNumber })),
            allVouchersIncDeleted: allVouchersForRun.map((v) => ({
              id: v.id,
              number: v.voucherNumber,
              deleted: !!v.deletedAt,
            })),
          };
        })
      );

      res.json({
        companyId,
        totalRuns: allRuns.length,
        paidRuns: paidRuns.length,
        salaryExpenseAccount: salaryExpenseAccount
          ? { id: salaryExpenseAccount.id, code: salaryExpenseAccount.code }
          : null,
        runs: runDetails,
      });
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });
}
