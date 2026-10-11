/**
 * employeeCrudRoutes: FactoryEmployeeCash endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../../lib/httpHandlers";
import { db } from "../../../../db";
import { requireAuth } from "../../../../auth";
import { ledgerAccounts, employees } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import { parseMoneyInput, toMoney } from "../../../../lib/money";
import {
  factoryRequestSourceId,
  factorySessionActor,
  postFactoryVoucherTx,
} from "../../../../services/factory/factoryVoucherPosting";

export function registerFactoryEmployeeCashRoutes(app: Express) {
  // POST /api/factory/employees/:id/deposit - single deposit
  // DR: PAYROLL_DEPOSIT_EXPENSE, CR: Employee (via employeeId)
  app.post("/api/factory/employees/:id/deposit", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid employee ID" });

      const { amount, date, notes, effectiveDate } = req.body;
      // At cents, so the voucher and the running balance move by the same amount.
      const depositAmount = parseMoneyInput(amount)?.toDecimalPlaces(2) ?? null;
      if (!depositAmount || depositAmount.lte(0)) {
        return res.status(400).json({ message: "Amount must be a positive number" });
      }
      if (!date) return res.status(400).json({ message: "Date is required" });

      const result = await db.transaction(async (tx) => {
        const [emp] = await tx
          .select()
          .from(employees)
          .where(and(eq(employees.id, id), eq(employees.companyId, companyId), eq(employees.employeeType, "Employee")));
        if (!emp) throw new Error("EMPLOYEE_NOT_FOUND");

        // Get or create PAYROLL_DEPOSIT_EXPENSE ledger account
        let [payrollExpenseAccount] = await tx
          .select()
          .from(ledgerAccounts)
          .where(and(eq(ledgerAccounts.companyId, companyId), eq(ledgerAccounts.code, "PAYROLL_DEPOSIT_EXPENSE")));
        if (!payrollExpenseAccount) {
          [payrollExpenseAccount] = await tx
            .insert(ledgerAccounts)
            .values({
              companyId,
              code: "PAYROLL_DEPOSIT_EXPENSE",
              name: "Payroll Deposit Expense",
              accountType: "Indirect Expense",
              openingBalance: "0",
              active: true,
            })
            .returning();
        }

        // Phase 22 (C): through the engine, engine-numbered (was EMP-DEP-{Date.now()}),
        // with the request's identity (clientRequestId / X-Idempotency-Key: a resend
        // returns the voucher already posted). DR: Payroll Expense / CR: Employee.
        const narration = notes || `Salary deposit - ${emp.firstName} ${emp.lastName}`;
        const { voucher, replayed } = await postFactoryVoucherTx(tx, {
          companyId,
          voucherDate: date,
          effectiveDate: (effectiveDate as string) || null,
          description: notes || `Salary deposit for ${emp.firstName} ${emp.lastName}`,
          sourceModule: "ERP",
          source: {
            sourceType: "factory-employee-deposit",
            sourceId: `${id}:${factoryRequestSourceId(req)}`,
            phase: "voucher",
          },
          actor: factorySessionActor(req),
          lines: [
            { ledgerAccountId: payrollExpenseAccount.id, debit: depositAmount, narration },
            { employeeId: id, credit: depositAmount, narration },
          ],
        });
        if (replayed) {
          const [unchanged] = await tx.select().from(employees).where(eq(employees.id, id));
          return { voucher, employee: unchanged };
        }

        // Update employee balance
        const newBalance = toMoney(emp.currentBalance).plus(depositAmount);
        const newDeposits = toMoney(emp.totalDeposits).plus(depositAmount);
        await tx
          .update(employees)
          .set({
            currentBalance: newBalance.toFixed(2),
            totalDeposits: newDeposits.toFixed(2),
          })
          .where(eq(employees.id, id));

        const [updated] = await tx.select().from(employees).where(eq(employees.id, id));
        return { voucher, employee: updated };
      });

      res.json(result);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // POST /api/factory/employees/:id/withdraw - single withdrawal
  // DR: Employee (via employeeId), CR: Cash ledger account
  app.post("/api/factory/employees/:id/withdraw", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid employee ID" });

      const { amount, date, notes, cashAccountId } = req.body;
      const withdrawAmount = parseMoneyInput(amount)?.toDecimalPlaces(2) ?? null;
      if (!withdrawAmount || withdrawAmount.lte(0)) {
        return res.status(400).json({ message: "Amount must be a positive number" });
      }
      if (!date) return res.status(400).json({ message: "Date is required" });
      if (!cashAccountId) return res.status(400).json({ message: "Cash account is required" });

      const result = await db.transaction(async (tx) => {
        const [emp] = await tx
          .select()
          .from(employees)
          .where(and(eq(employees.id, id), eq(employees.companyId, companyId), eq(employees.employeeType, "Employee")));
        if (!emp) throw new Error("EMPLOYEE_NOT_FOUND");

        // Verify cash account belongs to this company
        const [cashAccount] = await tx
          .select()
          .from(ledgerAccounts)
          .where(and(eq(ledgerAccounts.id, parseInt(cashAccountId)), eq(ledgerAccounts.companyId, companyId)));
        if (!cashAccount) throw new Error("CASH_ACCOUNT_NOT_FOUND");

        // Phase 22 (C): through the engine, engine-numbered (was EMP-WD-{Date.now()}),
        // with the request's identity. DR: Employee / CR: Cash.
        const narration = notes || `Withdrawal - ${emp.firstName} ${emp.lastName}`;
        const { voucher, replayed } = await postFactoryVoucherTx(tx, {
          companyId,
          voucherDate: date,
          description: notes || `Withdrawal for ${emp.firstName} ${emp.lastName}`,
          sourceModule: "ERP",
          source: {
            sourceType: "factory-employee-withdrawal",
            sourceId: `${id}:${factoryRequestSourceId(req)}`,
            phase: "voucher",
          },
          actor: factorySessionActor(req),
          lines: [
            { employeeId: id, debit: withdrawAmount, narration },
            { ledgerAccountId: cashAccount.id, credit: withdrawAmount, narration },
          ],
        });
        if (replayed) {
          const [unchanged] = await tx.select().from(employees).where(eq(employees.id, id));
          return { voucher, employee: unchanged };
        }

        // Update employee balance (can go negative)
        const newBalance = toMoney(emp.currentBalance).minus(withdrawAmount);
        const newWithdrawals = toMoney(emp.totalWithdrawals).plus(withdrawAmount);
        await tx
          .update(employees)
          .set({
            currentBalance: newBalance.toFixed(2),
            totalWithdrawals: newWithdrawals.toFixed(2),
          })
          .where(eq(employees.id, id));

        const [updated] = await tx.select().from(employees).where(eq(employees.id, id));
        return { voucher, employee: updated };
      });

      res.json(result);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
