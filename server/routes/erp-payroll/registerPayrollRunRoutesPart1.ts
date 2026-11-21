// Extracted from ./runs.ts
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { eq, and, inArray, isNotNull, like, or } from "drizzle-orm";
import { db } from "../../db";
import { storage } from "../../storage";
import { requireAuth, requireNonPOS } from "../../auth";
import { triggerAccountWhatsAppStatement } from "../factoryWhatsappRoutes";
import {
  erpPayrollRunItems,
  erpPayrollRuns,
  factoryWorkerDeductions,
  salaryAdvanceDeductions,
  salaryAdvances,
  vouchers,
} from "@shared/schema";
import type Decimal from "decimal.js";
import { MoneyDecimal, moneyString, sumMoney, toMoney } from "../../lib/money";
import { allLedgerAccountsOwned } from "../helpers/companyOwnership";
import {
  postErpVoucherTx,
  sessionPostingActor,
  type ErpVoucherLine,
} from "../../services/accounting/erpVoucherPosting";
import { payrollItemRows, payrollDeductionOf } from "./runsHelpers";

export function registerPayrollRunRoutesPart1(app: Express) {
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
        // The account is a body id the path-based company scope never sees.
        if (!(await allLedgerAccountsOwned(companyId, [paymentAccountId]))) {
          return res.status(404).json({ message: "Payment account not found" });
        }

        const runItems = await db.select().from(erpPayrollRunItems).where(eq(erpPayrollRunItems.runId, runId));
        const totalAmount = sumMoney(runItems.map((i) => i.netPay));
        if (totalAmount.lte(0)) return res.status(400).json({ message: "Total net pay must be > 0" });

        // Resolve the exact pending worker-deduction records represented by this draft.
        // We validate before creating the payment voucher so stale/deleted deductions
        // cannot silently make the paid payroll disagree with the saved preview.
        const payrollDeductionIdsByEmployee = new Map<number, number[]>();
        for (const item of runItems) {
          const target = payrollDeductionOf(item);
          if (target.lte(0) || !item.employeeId) continue;

          const pending = await db
            .select()
            .from(factoryWorkerDeductions)
            .where(
              and(
                eq(factoryWorkerDeductions.companyId, companyId),
                eq(factoryWorkerDeductions.workerId, item.employeeId),
                eq(factoryWorkerDeductions.applied, false)
              )
            )
            .orderBy(factoryWorkerDeductions.createdAt, factoryWorkerDeductions.id);

          let accumulated: Decimal = new MoneyDecimal(0);
          const ids: number[] = [];
          for (const ded of pending) {
            if (accumulated.gte(target.minus("0.005"))) break;
            accumulated = accumulated.plus(toMoney(ded.amount));
            ids.push(ded.id);
          }
          if (accumulated.minus(target).abs().gt("0.005")) {
            return res.status(409).json({
              message: `Pending payroll deductions changed for ${item.employeeName}. Refresh the payroll preview and try again.`,
            });
          }
          payrollDeductionIdsByEmployee.set(item.employeeId, ids);
        }

        const allAccounts = await storage.getAllLedgerAccounts(companyId);

        // Group run items by worker group name so each group gets its own expense account
        const itemsByGroup = new Map<string, Decimal>();
        for (const item of runItems) {
          const grp = (item.groupName || "").trim() || "__default__";
          itemsByGroup.set(grp, (itemsByGroup.get(grp) ?? new MoneyDecimal(0)).plus(toMoney(item.netPay)));
        }

        const payDate = run.date;

        // Resolve one expense account per worker group before posting
        const runGroupDebits: ErpVoucherLine[] = [];
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
          runGroupDebits.push({
            ledgerAccountId: expAccount.id,
            debit: grpTotal,
            narration: isDefault ? `Salary expense — payroll run #${runId}` : `Salary expense - ${grp} — run #${runId}`,
          });
        }

        // Voucher header and every entry commit together (balanced-voucher trigger).
        // Phase 22 (B): through the central engine (one payment per run; a
        // repeated pay request returns it), the run marked PAID in the same
        // transaction.
        const { voucher, updated } = await db.transaction(async (tx) => {
          // The run's payment keeps its SAL-{run}- family number: the run undo
          // (runs-lifecycle.ts), the voucher bulk delete and the central
          // payment deletion policy find it by that prefix to reverse the run.
          // The suffix is the payment's generation (1 + the run's earlier
          // payment vouchers, deleted by an undo or a voucher delete, which
          // keep their numbers), and a later generation is its own posting
          // identity, so a re-pay after an undo posts a new voucher instead of
          // replaying the deleted one; a repeated request of one generation
          // still replays.
          const earlierPayments = await tx
            .select({ id: vouchers.id })
            .from(vouchers)
            .where(
              and(
                eq(vouchers.companyId, companyId),
                isNotNull(vouchers.deletedAt),
                or(
                  like(vouchers.voucherNumber, `SAL-${runId}-%`),
                  like(vouchers.originalVoucherNumber, `SAL-${runId}-%`)
                )
              )
            );
          const generation = earlierPayments.length + 1;
          const { voucher } = await postErpVoucherTx(tx, {
            companyId,
            voucherType: "Payment",
            voucherNumber: `SAL-${runId}-${generation}`,
            voucherDate: payDate,
            description: run.notes || `Payroll run #${runId} — ${runItems.length} workers`,
            lines: [
              ...runGroupDebits,
              {
                ledgerAccountId: parseInt(paymentAccountId),
                credit: totalAmount,
                narration: `Cash paid — payroll run #${runId}`,
              },
            ],
            source: { type: "erp-payroll-run", id: runId, revision: generation > 1 ? `g${generation}` : null },
            actor: sessionPostingActor(req, "Payroll run payment"),
          });
          const [updated] = await tx
            .update(erpPayrollRuns)
            .set({ status: "PAID", paymentAccountId: parseInt(paymentAccountId), paidAt: new Date().toISOString() })
            .where(eq(erpPayrollRuns.id, runId))
            .returning();
          return { voucher, updated };
        });

        // Deduct advance balances FIFO for each employee who has a deduction in this payroll
        const payMonth = payDate.substring(0, 7);
        for (const item of runItems) {
          const deductAmt = toMoney(item.deduction);
          if (deductAmt.lte(0) || !item.employeeId) continue;

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
            if (remaining.lte("0.001")) break;
            const bal = toMoney(adv.remainingBalance);
            if (bal.lte(0)) continue;
            const toDeduct = MoneyDecimal.min(remaining, bal);
            const newBal = MoneyDecimal.max(0, bal.minus(toDeduct));
            const fullyPaid = newBal.lte("0.01");

            await db.insert(salaryAdvanceDeductions).values({
              salaryAdvanceId: adv.id,
              payrollMonth: payMonth,
              deductionAmount: moneyString(toDeduct),
            });
            await db
              .update(salaryAdvances)
              .set({ remainingBalance: moneyString(newBal), fullyPaid })
              .where(eq(salaryAdvances.id, adv.id));
            remaining = remaining.minus(toDeduct);
          }
        }

        // Mark one-time worker deductions as paid/applied by this ERP payroll run.
        for (const [employeeId, deductionIds] of payrollDeductionIdsByEmployee) {
          if (deductionIds.length === 0) continue;
          await db
            .update(factoryWorkerDeductions)
            .set({ applied: true, erpPayrollRunId: runId })
            .where(
              and(
                eq(factoryWorkerDeductions.companyId, companyId),
                eq(factoryWorkerDeductions.workerId, employeeId),
                inArray(factoryWorkerDeductions.id, deductionIds)
              )
            );
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
        const checked = Array.isArray(items) && items.length > 0 ? payrollItemRows(items, runId) : null;
        if (checked && "invalidEmployee" in checked)
          return res.status(400).json({ message: "Invalid payroll salary amounts", employee: checked.invalidEmployee });
        if (Object.keys(updates).length)
          await db.update(erpPayrollRuns).set(updates).where(eq(erpPayrollRuns.id, runId));
        if (checked) {
          await db.delete(erpPayrollRunItems).where(eq(erpPayrollRunItems.runId, runId));
          await db.insert(erpPayrollRunItems).values(checked.rows);
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
