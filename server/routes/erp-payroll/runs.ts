/**
 * payrollRoutes: PayrollRun endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { eq, and, desc, inArray } from "drizzle-orm";
import { db } from "../../db";
import { storage } from "../../storage";
import { getAccessibleCompanyIds } from "../../security/companyAccessBoundary";
import { requireAuth, requireNonPOS } from "../../auth";
import { triggerAccountWhatsAppStatement } from "../factoryWhatsappRoutes";
import {
  erpPayrollRunItems,
  erpPayrollRuns,
  factoryWorkerDeductions,
  salaryAdvanceDeductions,
  salaryAdvances,
  voucherEntries,
  vouchers,
} from "@shared/schema";
import type Decimal from "decimal.js";
import { MoneyDecimal, moneyString, parseMoneyInput, sumMoney, toMoney } from "../../lib/money";
import { allLedgerAccountsOwned } from "../helpers/companyOwnership";

type PayrollItemInput = {
  employeeId: number;
  employeeName: string;
  groupName?: string | null;
  baseSalary: unknown;
  deduction?: unknown;
  payrollDeduction?: unknown;
  netPay: unknown;
};

/**
 * A run item's amounts as the cents the numeric(…, 2) columns store, or null
 * when one does not parse. Unparsed amounts used to be written as 'NaN', which
 * Postgres numeric accepts and which then reached the payment voucher.
 */
function payrollItemAmounts(item: PayrollItemInput) {
  const baseSalary = parseMoneyInput(item.baseSalary);
  const deduction = parseMoneyInput(item.deduction || 0);
  const payrollDeduction = parseMoneyInput(item.payrollDeduction || 0);
  const netPay = parseMoneyInput(item.netPay);
  if (!baseSalary || !deduction || !payrollDeduction || !netPay) return null;
  return {
    baseSalary: moneyString(baseSalary),
    deduction: moneyString(deduction),
    payrollDeduction: moneyString(payrollDeduction),
    netPay: moneyString(netPay),
  };
}

/** Run items with exact amounts, or the first employee whose amounts do not parse. */
function payrollItemRows(items: PayrollItemInput[], runId: number) {
  const rows = [];
  for (const it of items) {
    const amounts = payrollItemAmounts(it);
    if (!amounts) return { invalidEmployee: it.employeeName || `employee #${it.employeeId}` };
    rows.push({
      runId,
      employeeId: it.employeeId,
      employeeName: it.employeeName,
      groupName: it.groupName || null,
      ...amounts,
    });
  }
  return { rows };
}

/** The deduction a run item represents: the stored one, or for legacy rows base − advance deduction − net. */
function payrollDeductionOf(item: {
  payrollDeduction: string | null;
  baseSalary: string | null;
  deduction: string | null;
  netPay: string | null;
}): Decimal {
  const stored = toMoney(item.payrollDeduction);
  const inferredLegacy = MoneyDecimal.max(
    0,
    toMoney(item.baseSalary).minus(toMoney(item.deduction)).minus(toMoney(item.netPay))
  );
  return stored.gt("0.005") ? stored : inferredLegacy;
}

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
      const checked = payrollItemRows(items, 0);
      if ("invalidEmployee" in checked)
        return res.status(400).json({ message: "Invalid payroll salary amounts", employee: checked.invalidEmployee });
      const createdAt = new Date().toISOString();
      const [run] = await db
        .insert(erpPayrollRuns)
        .values({ companyId, status: "DRAFT", date, notes: notes || null, createdAt })
        .returning();
      await db.insert(erpPayrollRunItems).values(checked.rows.map((row) => ({ ...row, runId: run.id })));
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
          const rawItems = await db.select().from(erpPayrollRunItems).where(eq(erpPayrollRunItems.runId, run.id));
          const items = rawItems.map((i) => ({ ...i, payrollDeduction: moneyString(payrollDeductionOf(i)) }));
          return {
            ...run,
            itemCount: items.length,
            totalNet: moneyString(sumMoney(items.map((i) => i.netPay))),
            totalBase: moneyString(sumMoney(items.map((i) => i.baseSalary))),
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
        const voucherNumber = `SAL-${runId}-${Date.now()}`;

        // Resolve one expense account per worker group before posting
        const runGroupDebits: { ledgerAccountId: number; debitAmount: string; narration: string }[] = [];
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
            debitAmount: moneyString(grpTotal),
            narration: isDefault ? `Salary expense — payroll run #${runId}` : `Salary expense - ${grp} — run #${runId}`,
          });
        }

        // Voucher header and every entry commit together (balanced-voucher trigger).
        const voucher = await db.transaction(async (tx) => {
          const [voucher] = await tx
            .insert(vouchers)
            .values({
              companyId,
              voucherNumber,
              voucherType: "Payment",
              voucherDate: payDate,
              description: run.notes || `Payroll run #${runId} — ${runItems.length} workers`,
              totalAmount: moneyString(totalAmount),
            })
            .returning();

          // Create one debit entry per worker group
          for (const debit of runGroupDebits) {
            await tx.insert(voucherEntries).values({
              voucherId: voucher.id,
              ledgerAccountId: debit.ledgerAccountId,
              debitAmount: debit.debitAmount,
              creditAmount: "0",
              narration: debit.narration,
            });
          }

          // Single credit entry for the total payment out
          await tx.insert(voucherEntries).values({
            voucherId: voucher.id,
            ledgerAccountId: parseInt(paymentAccountId),
            debitAmount: "0",
            creditAmount: moneyString(totalAmount),
            narration: `Cash paid — payroll run #${runId}`,
          });
          return voucher;
        });
        const [updated] = await db
          .update(erpPayrollRuns)
          .set({ status: "PAID", paymentAccountId: parseInt(paymentAccountId), paidAt: new Date().toISOString() })
          .where(eq(erpPayrollRuns.id, runId))
          .returning();

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
