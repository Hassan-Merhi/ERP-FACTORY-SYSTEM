import type { Express } from "express";
import { and, eq, inArray, sql } from "drizzle-orm";

import { requireAuth, requireNonPOS } from "../../auth";
import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { storage } from "../../storage";
import {
  employees,
  erpPayrollRunItems,
  erpPayrollRuns,
  insertSalaryAdvanceDeductionSchema,
  insertSalaryAdvanceSchema,
  salaryAdvanceDeductions,
  salaryAdvances,
  voucherEntries,
  vouchers,
} from "@shared/schema";

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

  app.get(
    "/api/salary-advances/employee/:employeeId",
    requireAuth,
    requireNonPOS,
    async (req, res) => {
      try {
        const employeeId = parseInt(req.params.employeeId);
        if (isNaN(employeeId)) return res.status(400).json({ message: "Invalid employee ID" });
        res.json(await storage.getSalaryAdvancesByEmployee(employeeId));
      } catch (error: unknown) {
        res.status(500).json({ message: getErrorMessage(error) });
      }
    },
  );

  app.post("/api/salary-advances", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const parsed = insertSalaryAdvanceSchema.parse({
        ...req.body,
        companyId,
        remainingBalance: req.body.amount,
        isOpeningBalance: req.body.isOpeningBalance || false,
      });
      const [employee] = await db.select().from(employees).where(eq(employees.id, parsed.employeeId)).limit(1);
      if (!employee) return res.status(404).json({ message: "Employee not found" });
      if (employee.companyId !== companyId) {
        return res.status(403).json({ message: "Employee belongs to a different company" });
      }

      let voucherId: number | null = null;
      if (!parsed.isOpeningBalance) {
        const cashAccountId = req.body.cashAccountId || req.session.cashAccountId;
        if (!cashAccountId) return res.status(400).json({ message: "Cash account is required" });
        const voucherNumber = `SA-${Date.now()}`;
        const [voucher] = await db
          .insert(vouchers)
          .values({
            companyId,
            voucherNumber,
            voucherType: "Payment",
            voucherDate: parsed.advanceDate,
            description: parsed.notes || `Salary advance for ${employee.firstName} ${employee.lastName}`,
            totalAmount: parsed.amount,
          })
          .returning();
        voucherId = voucher.id;
        await db.insert(voucherEntries).values([
          {
            voucherId: voucher.id,
            ledgerAccountId: null,
            employeeId: employee.id,
            debitAmount: parsed.amount,
            creditAmount: "0",
            narration: `Salary advance - ${voucherNumber}`,
          },
          {
            voucherId: voucher.id,
            ledgerAccountId: cashAccountId,
            debitAmount: "0",
            creditAmount: parsed.amount,
            narration: `Salary advance - ${voucherNumber}`,
          },
        ]);
      }

      const advance = await storage.createSalaryAdvance({ ...parsed, voucherId });
      res.status(201).json(advance);
    } catch (error: unknown) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/salary-advances/:id/deduction", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const advanceId = parseInt(req.params.id);
      if (isNaN(advanceId)) return res.status(400).json({ message: "Invalid salary advance ID" });
      const parsed = insertSalaryAdvanceDeductionSchema.omit({ salaryAdvanceId: true }).parse(req.body);
      const advance = await storage.getSalaryAdvanceById(advanceId);
      if (!advance) return res.status(404).json({ message: "Salary advance not found" });
      if (advance.companyId !== companyId) {
        return res.status(403).json({ message: "Salary advance belongs to a different company" });
      }
      if (advance.fullyPaid) return res.status(400).json({ message: "Salary advance is already fully paid" });

      const deductionAmount = parseFloat(parsed.deductionAmount);
      const remainingBalance = parseFloat(advance.remainingBalance);
      if (deductionAmount > remainingBalance) {
        return res.status(400).json({
          message: `Deduction amount cannot exceed remaining balance of ${remainingBalance}`,
        });
      }

      await db.insert(salaryAdvanceDeductions).values({
        salaryAdvanceId: advanceId,
        payrollMonth: parsed.payrollMonth,
        deductionAmount: parsed.deductionAmount,
      });
      const newRemainingBalance = remainingBalance - deductionAmount;
      const fullyPaid = newRemainingBalance <= 0.01;
      await db
        .update(salaryAdvances)
        .set({ remainingBalance: newRemainingBalance.toFixed(2), fullyPaid })
        .where(eq(salaryAdvances.id, advanceId));
      res.json({
        message: "Deduction recorded successfully",
        newRemainingBalance: newRemainingBalance.toFixed(2),
        fullyPaid,
      });
    } catch (error: unknown) {
      res.status(400).json({ message: getErrorMessage(error) });
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
            ? inArray(salaryAdvanceDeductions.salaryAdvanceId, allAdvances.map((advance) => advance.id))
            : sql`false`,
        );
      const manualByAdvance = new Map<number, number>();
      for (const deduction of allManualDeductions) {
        manualByAdvance.set(
          deduction.salaryAdvanceId,
          (manualByAdvance.get(deduction.salaryAdvanceId) || 0) + parseFloat(deduction.deductionAmount || "0"),
        );
      }
      const paidRuns = await db
        .select({ id: erpPayrollRuns.id })
        .from(erpPayrollRuns)
        .where(and(eq(erpPayrollRuns.companyId, companyId), eq(erpPayrollRuns.status, "PAID")));
      const payrollByEmployee = new Map<number, number>();
      if (paidRuns.length) {
        const items = await db
          .select({ employeeId: erpPayrollRunItems.employeeId, deduction: erpPayrollRunItems.deduction })
          .from(erpPayrollRunItems)
          .where(inArray(erpPayrollRunItems.runId, paidRuns.map((run) => run.id)));
        for (const item of items) {
          const amount = parseFloat(item.deduction || "0");
          if (amount > 0 && item.employeeId) {
            payrollByEmployee.set(item.employeeId, (payrollByEmployee.get(item.employeeId) || 0) + amount);
          }
        }
      }
      const grouped = new Map<number, typeof allAdvances>();
      for (const advance of allAdvances) grouped.set(advance.employeeId, [...(grouped.get(advance.employeeId) || []), advance]);

      let fixed = 0;
      await db.transaction(async (tx) => {
        for (const [employeeId, advances] of grouped) {
          const balances = advances.map((advance) => ({
            id: advance.id,
            balance: Math.max(0, parseFloat(advance.amount || "0") - (manualByAdvance.get(advance.id) || 0)),
          }));
          let payrollRemaining = payrollByEmployee.get(employeeId) || 0;
          for (const entry of balances) {
            if (payrollRemaining <= 0) break;
            const deduction = Math.min(entry.balance, payrollRemaining);
            entry.balance -= deduction;
            payrollRemaining -= deduction;
          }
          for (let index = 0; index < advances.length; index++) {
            const advance = advances[index];
            const newBalance = parseFloat(Math.max(0, balances[index].balance).toFixed(2));
            const fullyPaid = newBalance <= 0.01;
            if (Math.abs(parseFloat(advance.remainingBalance || "0") - newBalance) > 0.01 || advance.fullyPaid !== fullyPaid) {
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
