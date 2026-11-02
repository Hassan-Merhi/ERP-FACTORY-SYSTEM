/**
 * employeeCrudRoutes: FactoryEmployeeRecalculate endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../../lib/httpHandlers";
import { logger } from "../../../../lib/logger";
import { db } from "../../../../db";
import { requireAuth } from "../../../../auth";
import { employees } from "@shared/schema";
import { eq, and, sql } from "drizzle-orm";
import { loadEmployeeLedgerAmounts } from "../../../../services/accounting/employeeLedgerAmounts";
import { toMoney } from "../../../../lib/money";

export function registerFactoryEmployeeRecalculateRoutes(app: Express) {
  // POST /api/factory/employees/recalculate-balances
  // Rebuilds currentBalance, totalDeposits, totalWithdrawals for every employee from surviving voucher entries.
  // Useful after deletions that didn't reverse balances (legacy bug).
  app.post("/api/factory/employees/recalculate-balances", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const role = (req.session.currentRole || req.session.role || "").toLowerCase();
      if (role !== "admin" && role !== "owner" && role !== "developer") {
        return res.status(403).json({ message: "Only Admin or Owner can recalculate balances" });
      }

      // Get all employees for this company
      const allEmployees = await db
        .select()
        .from(employees)
        .where(
          and(
            eq(employees.companyId, companyId),
            eq(employees.employeeType, "Employee"),
            sql`${employees.deletedAt} IS NULL`
          )
        );

      if (allEmployees.length === 0) return res.json({ updated: 0, employees: [] });

      // Rebuild from the same posted, company-scoped ledger and opening side
      // used by Accounts, employee statements, Payroll, and Excel exports.
      const ledgerAmounts = await loadEmployeeLedgerAmounts(companyId);

      const results = [];
      for (const emp of allEmployees) {
        const rebuilt = ledgerAmounts.get(emp.id) ?? {
          currentBalance: "0.00",
          totalDeposits: "0.00",
          totalWithdrawals: "0.00",
        };

        await db.update(employees).set(rebuilt).where(eq(employees.id, emp.id));

        results.push({
          id: emp.id,
          name: `${emp.firstName} ${emp.lastName}`,
          oldBalance: toMoney(emp.currentBalance).toNumber(),
          newBalance: Number(rebuilt.currentBalance),
          newDeposits: Number(rebuilt.totalDeposits),
          newWithdrawals: Number(rebuilt.totalWithdrawals),
        });
      }

      res.json({ updated: results.length, employees: results });
    } catch (error: unknown) {
      logger.error("Error recalculating employee balances:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // POST /api/factory/employees/:id/recalculate-balance
  // Rebuilds currentBalance, totalDeposits, totalWithdrawals for a single employee from surviving voucher entries.
  app.post("/api/factory/employees/:id/recalculate-balance", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const empId = parseInt(req.params.id);

      const [emp] = await db
        .select()
        .from(employees)
        .where(and(eq(employees.id, empId), eq(employees.companyId, companyId), sql`${employees.deletedAt} IS NULL`));
      if (!emp) return res.status(404).json({ message: "Employee not found" });

      const ledgerAmounts = await loadEmployeeLedgerAmounts(companyId);
      const rebuilt = ledgerAmounts.get(emp.id) ?? {
        currentBalance: "0.00",
        totalDeposits: "0.00",
        totalWithdrawals: "0.00",
      };

      await db.update(employees).set(rebuilt).where(eq(employees.id, empId));

      res.json({
        id: emp.id,
        name: `${emp.firstName} ${emp.lastName}`,
        oldBalance: toMoney(emp.currentBalance).toNumber(),
        newBalance: Number(rebuilt.currentBalance),
        newDeposits: Number(rebuilt.totalDeposits),
        newWithdrawals: Number(rebuilt.totalWithdrawals),
      });
    } catch (error: unknown) {
      logger.error("Error recalculating employee balance:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
