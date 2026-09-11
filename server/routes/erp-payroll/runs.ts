/**
 * payrollRoutes: PayrollRun endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { eq, and, desc } from "drizzle-orm";
import { db } from "../../db";
import { storage } from "../../storage";
import { getAccessibleCompanyIds } from "../../security/companyAccessBoundary";
import { requireAuth, requireNonPOS } from "../../auth";
import { triggerAccountWhatsAppStatement } from "../factoryWhatsappRoutes";
import {
  erpPayrollRunItems,
  erpPayrollRuns,
  salaryAdvanceDeductions,
  salaryAdvances,
  voucherEntries,
  vouchers,
} from "@shared/schema";

export function registerPayrollRunRoutes(app: Express) {
  // ── ERP Payroll Runs (draft → paid workflow) ──────────────────────────────

  // Create a new payroll run (saves as DRAFT, no ledger entries yet)
  app.post("/api/payroll/runs", requireAuth, requireNonPOS, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const { date, notes, items } = req.body;
      if (!date || !Array.isArray(items) || items.length === 0)
        return res.status(400).json({ message: "date and items are required" });
      const createdAt = new Date().toISOString();
      const [run] = await db
        .insert(erpPayrollRuns)
        .values({ companyId, status: "DRAFT", date, notes: notes || null, createdAt })
        .returning();
      await db.insert(erpPayrollRunItems).values(
        items.map((it) => ({
          runId: run.id,
          employeeId: it.employeeId,
          employeeName: it.employeeName,
          groupName: it.groupName || null,
          baseSalary: parseFloat(it.baseSalary).toFixed(2),
          deduction: parseFloat(it.deduction || 0).toFixed(2),
          netPay: parseFloat(it.netPay).toFixed(2),
        }))
      );
      res.json({ ...run, items });
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  // List payroll runs for current company
  app.get("/api/payroll/runs", requireAuth, requireNonPOS, async (req: Request, res: Response) => {
    try {
      // Accept companyId from query param (explicit) or fall back to session
      const paramCompanyId = req.query.companyId ? parseInt(req.query.companyId as string) : null;
      const sessionCompanyId = req.session.currentCompanyId;
      const companyId = paramCompanyId || sessionCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      // Validate that the requesting user has access to this company
      if (paramCompanyId && paramCompanyId !== sessionCompanyId) {
        const accessibleCompanyIds = await getAccessibleCompanyIds(req.session.userId!);
        if (!accessibleCompanyIds.has(paramCompanyId)) {
          return res.status(403).json({ message: "Access denied to this company" });
        }
      }

      const runs = await db
        .select()
        .from(erpPayrollRuns)
        .where(eq(erpPayrollRuns.companyId, companyId))
        .orderBy(desc(erpPayrollRuns.createdAt));
      // Attach item counts + totals
      const result = await Promise.all(
        runs.map(async (run) => {
          const items = await db.select().from(erpPayrollRunItems).where(eq(erpPayrollRunItems.runId, run.id));
          const totalNet = items.reduce((s, i) => s + parseFloat(i.netPay), 0);
          const totalBase = items.reduce((s, i) => s + parseFloat(i.baseSalary), 0);
          return {
            ...run,
            itemCount: items.length,
            totalNet: totalNet.toFixed(2),
            totalBase: totalBase.toFixed(2),
            items,
          };
        })
      );
      res.json(result);
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  // Update a DRAFT run's items / mark as PAID
  app.patch("/api/payroll/runs/:id", requireAuth, requireNonPOS, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const runId = parseInt(req.params.id);
      const [run] = await db
        .select()
        .from(erpPayrollRuns)
        .where(and(eq(erpPayrollRuns.id, runId), eq(erpPayrollRuns.companyId, companyId)));
      if (!run) return res.status(404).json({ message: "Payroll run not found" });

      const { action, items, paymentAccountId, date, notes } = req.body;

      if (action === "pay") {
        // Mark as PAID + create ledger entries
        if (run.status === "PAID") return res.status(400).json({ message: "Already paid" });
        if (!paymentAccountId) return res.status(400).json({ message: "Payment account required" });

        const runItems = await db.select().from(erpPayrollRunItems).where(eq(erpPayrollRunItems.runId, runId));
        const totalAmount = runItems.reduce((s, i) => s + parseFloat(i.netPay), 0);
        if (totalAmount <= 0) return res.status(400).json({ message: "Total net pay must be > 0" });

        const allAccounts = await storage.getAllLedgerAccounts(companyId);

        // Group run items by worker group name so each group gets its own expense account
        const itemsByGroup = new Map<string, number>();
        for (const item of runItems) {
          const grp = (item.groupName || "").trim() || "__default__";
          itemsByGroup.set(grp, (itemsByGroup.get(grp) || 0) + parseFloat(item.netPay));
        }

        const payDate = run.date;
        const voucherNumber = `SAL-${runId}-${Date.now()}`;
        const [voucher] = await db
          .insert(vouchers)
          .values({
            companyId,
            voucherNumber,
            voucherType: "Payment",
            voucherDate: payDate,
            description: run.notes || `Payroll run #${runId} — ${runItems.length} workers`,
            totalAmount: totalAmount.toFixed(2),
          })
          .returning();

        // Create one debit entry per worker group
        for (const [grp, grpTotal] of itemsByGroup) {
          const isDefault = grp === "__default__";
          const expCode = isDefault
            ? "SALARY_EXPENSE"
            : `SAL_EXP_${grp
                .toUpperCase()
                .replace(/[^A-Z0-9]/g, "_")
                .substring(0, 25)}`;
          const expName = isDefault ? "Salary Expense" : `Salary Expense - ${grp}`;

          let expAccount = allAccounts.find((a) => a.code === expCode);
          if (!expAccount) {
            expAccount = await storage.createLedgerAccount({
              companyId,
              code: expCode,
              name: expName,
              accountType: "Expense",
              openingBalance: "0",
              active: true,
            });
          }
          await db.insert(voucherEntries).values({
            voucherId: voucher.id,
            ledgerAccountId: expAccount.id,
            debitAmount: grpTotal.toFixed(2),
            creditAmount: "0",
            narration: isDefault ? `Salary expense — payroll run #${runId}` : `Salary expense - ${grp} — run #${runId}`,
          });
        }

        // Single credit entry for the total payment out
        await db.insert(voucherEntries).values({
          voucherId: voucher.id,
          ledgerAccountId: parseInt(paymentAccountId),
          debitAmount: "0",
          creditAmount: totalAmount.toFixed(2),
          narration: `Cash paid — payroll run #${runId}`,
        });
        const [updated] = await db
          .update(erpPayrollRuns)
          .set({ status: "PAID", paymentAccountId: parseInt(paymentAccountId), paidAt: new Date().toISOString() })
          .where(eq(erpPayrollRuns.id, runId))
          .returning();

        // Deduct advance balances FIFO for each employee who has a deduction in this payroll
        const payMonth = payDate.substring(0, 7);
        for (const item of runItems) {
          const deductAmt = parseFloat(item.deduction || "0");
          if (deductAmt <= 0 || !item.employeeId) continue;

          const outstanding = await db
            .select()
            .from(salaryAdvances)
            .where(
              and(
                eq(salaryAdvances.employeeId, item.employeeId),
                eq(salaryAdvances.companyId, companyId),
                eq(salaryAdvances.fullyPaid, false)
              )
            )
            .orderBy(salaryAdvances.advanceDate);

          let remaining = deductAmt;
          for (const adv of outstanding) {
            if (remaining <= 0.001) break;
            const bal = parseFloat(adv.remainingBalance || "0");
            if (bal <= 0) continue;
            const toDeduct = Math.min(remaining, bal);
            const newBal = Math.max(0, bal - toDeduct);
            const fullyPaid = newBal <= 0.01;

            await db.insert(salaryAdvanceDeductions).values({
              salaryAdvanceId: adv.id,
              payrollMonth: payMonth,
              deductionAmount: toDeduct.toFixed(2),
            });
            await db
              .update(salaryAdvances)
              .set({ remainingBalance: newBal.toFixed(2), fullyPaid })
              .where(eq(salaryAdvances.id, adv.id));
            remaining -= toDeduct;
          }
        }

        // WhatsApp auto-statement trigger (non-fatal) — uses the same per-account
        // rule configured in Accounts → WhatsApp settings
        let waResult: { sent: boolean; error?: string } = { sent: false };
        try {
          waResult = await triggerAccountWhatsAppStatement({
            companyId,
            accountId: parseInt(paymentAccountId),
            accountType: "ledger",
            voucherType: "Payment",
            voucherDate: payDate,
          });
        } catch (waErr: unknown) {
          logger.error("[payroll-wa] WhatsApp trigger error (non-fatal):", { error: waErr });
        }

        return res.json({ ...updated, voucher, whatsapp: waResult });
      }

      if (action === "update" || !action) {
        // Update items/notes while still DRAFT
        if (run.status === "PAID") return res.status(400).json({ message: "Cannot edit a paid run" });
        const updates: Partial<typeof erpPayrollRuns.$inferInsert> = {};
        if (notes !== undefined) updates.notes = notes;
        if (date) updates.date = date;
        if (Object.keys(updates).length)
          await db.update(erpPayrollRuns).set(updates).where(eq(erpPayrollRuns.id, runId));
        if (Array.isArray(items) && items.length > 0) {
          await db.delete(erpPayrollRunItems).where(eq(erpPayrollRunItems.runId, runId));
          await db.insert(erpPayrollRunItems).values(
            items.map((it) => ({
              runId,
              employeeId: it.employeeId,
              employeeName: it.employeeName,
              groupName: it.groupName || null,
              baseSalary: parseFloat(it.baseSalary).toFixed(2),
              deduction: parseFloat(it.deduction || 0).toFixed(2),
              netPay: parseFloat(it.netPay).toFixed(2),
            }))
          );
        }
        const [updated] = await db.select().from(erpPayrollRuns).where(eq(erpPayrollRuns.id, runId));
        const updatedItems = await db.select().from(erpPayrollRunItems).where(eq(erpPayrollRunItems.runId, runId));
        return res.json({ ...updated, items: updatedItems });
      }

      res.status(400).json({ message: "Unknown action" });
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });
}
