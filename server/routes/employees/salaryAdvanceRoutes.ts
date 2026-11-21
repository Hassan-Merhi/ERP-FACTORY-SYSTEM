import type { Express } from "express";
import { and, eq, inArray, sql } from "drizzle-orm";

import { requireAuth, requireNonPOS } from "../../auth";
import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { HttpError } from "../../lib/httpError";
import { storage } from "../../storage";
import {
  employees,
  erpPayrollRunItems,
  erpPayrollRuns,
  insertSalaryAdvanceDeductionSchema,
  salaryAdvanceDeductions,
  salaryAdvances,
} from "@shared/schema";
import type Decimal from "decimal.js";
import { MoneyDecimal, toMoney } from "../../lib/money";
import { registerSalaryAdvanceRoutesPart1 } from "./registerSalaryAdvanceRoutesPart1";

/** An advance is paid off only when nothing is left at cents. */
function isPaidOff(remaining: Decimal): boolean {
  return !remaining.toDecimalPlaces(2).greaterThan(0);
}

export function registerSalaryAdvanceRoutes(app: Express): void {
  app.get("/api/salary-advances", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      res.json(await storage.getAllSalaryAdvances(companyId));
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/salary-advances/employee/:employeeId", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const employeeId = parseInt(req.params.employeeId);
      if (isNaN(employeeId)) return res.status(400).json({ message: "Invalid employee ID" });
      // Only the active company's advances: any employee id used to return that
      // employee's advances whatever company they belonged to.
      res.json(await storage.getSalaryAdvancesByEmployee(employeeId, companyId));
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  registerSalaryAdvanceRoutesPart1(app);

  app.post("/api/salary-advances/:id/deduction", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const advanceId = Number(req.params.id);
      if (!Number.isSafeInteger(advanceId) || advanceId <= 0) {
        return res.status(400).json({ message: "Invalid salary advance ID" });
      }
      const parsed = insertSalaryAdvanceDeductionSchema.omit({ salaryAdvanceId: true }).parse(req.body);
      const result = await db.transaction(async (tx) => {
        // Keep deduction and worker corrections serializable on the advance row.
        await tx.execute(sql`SELECT id FROM salary_advances
          WHERE id = ${advanceId} AND company_id = ${companyId} FOR UPDATE`);
        const [advance] = await tx
          .select()
          .from(salaryAdvances)
          .where(and(eq(salaryAdvances.id, advanceId), eq(salaryAdvances.companyId, companyId)));
        if (!advance) throw new HttpError(404, "Salary advance not found");
        if (advance.fullyPaid) throw new HttpError(400, "Salary advance is already fully paid");

        const deductionAmount = toMoney(parsed.deductionAmount);
        const remainingBalance = toMoney(advance.remainingBalance);
        if (deductionAmount.greaterThan(remainingBalance)) {
          throw new HttpError(400, `Deduction amount cannot exceed remaining balance of ${remainingBalance}`);
        }
        await tx.insert(salaryAdvanceDeductions).values({
          salaryAdvanceId: advanceId,
          payrollMonth: parsed.payrollMonth,
          deductionAmount: parsed.deductionAmount,
        });
        const newRemainingBalance = remainingBalance.minus(deductionAmount);
        const fullyPaid = isPaidOff(newRemainingBalance);
        await tx
          .update(salaryAdvances)
          .set({
            remainingBalance: newRemainingBalance.toFixed(2),
            fullyPaid,
          })
          .where(and(eq(salaryAdvances.id, advanceId), eq(salaryAdvances.companyId, companyId)));

        return {
          message: "Deduction recorded successfully",
          newRemainingBalance: newRemainingBalance.toFixed(2),
          fullyPaid,
        };
      });
      res.json(result);
    } catch (error: unknown) {
      res.status(error instanceof HttpError ? error.statusCode : 400).json({ message: getErrorMessage(error) });
    }
  });

  app.delete("/api/salary-advances/:id", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const advanceId = parseInt(req.params.id);
      if (isNaN(advanceId)) return res.status(400).json({ message: "Invalid salary advance ID" });
      const advance = await storage.getSalaryAdvanceById(advanceId);
      if (!advance) return res.status(404).json({ message: "Salary advance not found" });
      if (advance.companyId !== companyId) {
        return res.status(403).json({ message: "Salary advance belongs to a different company" });
      }
      await storage.deleteSalaryAdvance(advanceId);
      res.json({ message: "Salary advance deleted successfully" });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/salary-advances/reconcile", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const allAdvances = await db
        .select()
        .from(salaryAdvances)
        .where(eq(salaryAdvances.companyId, companyId))
        .orderBy(salaryAdvances.employeeId, salaryAdvances.advanceDate);
      const allManualDeductions = await db
        .select()
        .from(salaryAdvanceDeductions)
        .where(
          allAdvances.length
            ? inArray(
                salaryAdvanceDeductions.salaryAdvanceId,
                allAdvances.map((advance) => advance.id)
              )
            : sql`false`
        );
      const manualByAdvance = new Map<number, Decimal>();
      for (const deduction of allManualDeductions) {
        manualByAdvance.set(
          deduction.salaryAdvanceId,
          (manualByAdvance.get(deduction.salaryAdvanceId) ?? new MoneyDecimal(0)).plus(
            toMoney(deduction.deductionAmount)
          )
        );
      }
      const paidRuns = await db
        .select({ id: erpPayrollRuns.id })
        .from(erpPayrollRuns)
        .where(and(eq(erpPayrollRuns.companyId, companyId), eq(erpPayrollRuns.status, "PAID")));
      const payrollByEmployee = new Map<number, Decimal>();
      if (paidRuns.length) {
        const items = await db
          .select({ employeeId: erpPayrollRunItems.employeeId, deduction: erpPayrollRunItems.deduction })
          .from(erpPayrollRunItems)
          .where(
            inArray(
              erpPayrollRunItems.runId,
              paidRuns.map((run) => run.id)
            )
          );
        for (const item of items) {
          const amount = toMoney(item.deduction);
          if (amount.greaterThan(0) && item.employeeId) {
            payrollByEmployee.set(
              item.employeeId,
              (payrollByEmployee.get(item.employeeId) ?? new MoneyDecimal(0)).plus(amount)
            );
          }
        }
      }
      const grouped = new Map<number, typeof allAdvances>();
      for (const advance of allAdvances)
        grouped.set(advance.employeeId, [...(grouped.get(advance.employeeId) || []), advance]);

      let fixed = 0;
      await db.transaction(async (tx) => {
        for (const [employeeId, advances] of grouped) {
          const balances = advances.map((advance) => ({
            id: advance.id,
            balance: MoneyDecimal.max(
              0,
              toMoney(advance.amount).minus(manualByAdvance.get(advance.id) ?? new MoneyDecimal(0))
            ),
          }));
          let payrollRemaining: Decimal = payrollByEmployee.get(employeeId) ?? new MoneyDecimal(0);
          for (const entry of balances) {
            if (!payrollRemaining.greaterThan(0)) break;
            const deduction = MoneyDecimal.min(entry.balance, payrollRemaining);
            entry.balance = entry.balance.minus(deduction);
            payrollRemaining = payrollRemaining.minus(deduction);
          }
          for (let index = 0; index < advances.length; index++) {
            const advance = advances[index];
            const newBalance = MoneyDecimal.max(0, balances[index].balance).toDecimalPlaces(2);
            const fullyPaid = isPaidOff(newBalance);
            // Any difference at cents is corrected (a 0.01 drift used to be left in place).
            if (
              !toMoney(advance.remainingBalance).toDecimalPlaces(2).equals(newBalance) ||
              advance.fullyPaid !== fullyPaid
            ) {
              await tx
                .update(salaryAdvances)
                .set({ remainingBalance: newBalance.toFixed(2), fullyPaid })
                .where(eq(salaryAdvances.id, advance.id));
              fixed++;
            }
          }
        }
      });
      res.json({ message: `Reconciliation complete. ${fixed} advance(s) corrected.`, fixed });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/salary-advance-deductions", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const rows = await db
        .select({
          id: salaryAdvanceDeductions.id,
          salaryAdvanceId: salaryAdvanceDeductions.salaryAdvanceId,
          payrollMonth: salaryAdvanceDeductions.payrollMonth,
          deductionAmount: salaryAdvanceDeductions.deductionAmount,
          createdAt: salaryAdvanceDeductions.createdAt,
          advanceDate: salaryAdvances.advanceDate,
          advanceAmount: salaryAdvances.amount,
          advanceRemaining: salaryAdvances.remainingBalance,
          employeeId: salaryAdvances.employeeId,
          employeeFirstName: employees.firstName,
          employeeLastName: employees.lastName,
        })
        .from(salaryAdvanceDeductions)
        .innerJoin(salaryAdvances, eq(salaryAdvanceDeductions.salaryAdvanceId, salaryAdvances.id))
        .innerJoin(employees, eq(salaryAdvances.employeeId, employees.id))
        .where(eq(salaryAdvances.companyId, companyId))
        .orderBy(sql`${salaryAdvanceDeductions.createdAt} DESC`);
      res.json(rows.map((row) => ({ ...row, workerName: `${row.employeeFirstName} ${row.employeeLastName}`.trim() })));
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
