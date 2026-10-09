/**
 * payrollRoutes: PayrollEmployeeDeposit endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { eq, and } from "drizzle-orm";
import { db } from "../../db";
import { parseMoneyInput, sumMoney, toMoney } from "../../lib/money";
import { postableAdjustments } from "./postableAdjustments";
import { storage } from "../../storage";
import { requireAuth, requireNonPOS } from "../../auth";
import { syncEmployeeBalancesFromEntries } from "../_helpers";
import { employeeGroupMembers, employeeGroups, employees, voucherEntries, vouchers } from "@shared/schema";

export function registerPayrollEmployeeDepositRoutes(app: Express) {
  // Payroll - Employee Balance Deposit
  app.post("/api/payroll/deposit-employee", requireAuth, requireNonPOS, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const { employeeId, amount, date, notes } = req.body;

      if (!employeeId || !amount || !date) {
        return res.status(400).json({ message: "Employee, amount, and date are required" });
      }

      const depositAmount = parseMoneyInput(amount)?.toDecimalPlaces(2) ?? null;
      if (!depositAmount || depositAmount.lte(0)) {
        return res.status(400).json({ message: "Amount must be a positive number" });
      }

      // Get employee
      const [employee] = await db
        .select()
        .from(employees)
        .where(and(eq(employees.id, employeeId), eq(employees.companyId, req.session.currentCompanyId)));
      if (!employee) {
        return res.status(404).json({ message: "Employee not found" });
      }

      // Look up the employee's group for per-group salary expense splitting
      const depGroupRows = await db
        .select({ groupName: employeeGroups.name })
        .from(employeeGroupMembers)
        .innerJoin(employeeGroups, eq(employeeGroupMembers.employeeGroupId, employeeGroups.id))
        .where(
          and(
            eq(employeeGroupMembers.employeeId, employee.id),
            eq(employeeGroups.companyId, req.session.currentCompanyId!),
            eq(employeeGroups.active, true)
          )
        )
        .limit(1);
      const depGrp = depGroupRows[0]?.groupName?.trim() || "__default__";
      const depIsDefault = depGrp === "__default__";
      const depExpCode = depIsDefault
        ? "SALARY_EXPENSE"
        : `SAL_EXP_${depGrp
            .toUpperCase()
            .replace(/[^A-Z0-9]/g, "_")
            .substring(0, 25)}`;
      const depExpName = depIsDefault ? "Salary Expense" : `Salary Expense - ${depGrp}`;

      const allDepAccounts = await storage.getAllLedgerAccounts(req.session.currentCompanyId);
      let depSalaryAccount = allDepAccounts.find((a) => a.code === depExpCode);
      if (!depSalaryAccount) {
        depSalaryAccount = await storage.createLedgerAccount({
          companyId: req.session.currentCompanyId!,
          code: depExpCode,
          name: depExpName,
          accountType: "Expense",
          openingBalance: "0",
          active: true,
        });
      }

      // Create voucher
      const voucherNumber = `SAL-DEP-${Date.now()}`;
      const voucher = await db.transaction(async (tx) => {
        const [voucher] = await tx
          .insert(vouchers)
          .values({
            companyId: req.session.currentCompanyId!,
            voucherNumber,
            voucherType: "Journal",
            voucherDate: date,
            description: notes || `Salary deposit for ${employee.firstName} ${employee.lastName}`,
            totalAmount: depositAmount.toFixed(2),
          })
          .returning();

        // Create voucher entries (double-entry)
        // Debit: Salary Expense - {Group} (or Salary Expense for ungrouped)
        await tx.insert(voucherEntries).values({
          voucherId: voucher.id,
          ledgerAccountId: depSalaryAccount.id,
          debitAmount: depositAmount.toFixed(2),
          creditAmount: "0",
          narration: `Salary deposit - ${voucherNumber}`,
        });

        // Credit: Employee (using employeeId field directly instead of separate ledger account)
        await tx.insert(voucherEntries).values({
          voucherId: voucher.id,
          ledgerAccountId: null,
          employeeId: employee.id,
          debitAmount: "0",
          creditAmount: depositAmount.toFixed(2),
          narration: `Salary deposit - ${voucherNumber}`,
        });
        // Wave 12: the balance moves in the voucher's transaction.
        await syncEmployeeBalancesFromEntries(
          [
            {
              ledgerAccountId: null,
              employeeId: employee.id,
              debitAmount: "0",
              creditAmount: depositAmount.toFixed(2),
            },
          ],
          req.session.currentCompanyId!,
          false,
          tx
        );
        return voucher;
      });

      // Get updated employee balance after sync
      const [updatedDepositEmployee] = await db.select().from(employees).where(eq(employees.id, employee.id));

      res.json({
        voucher,
        employee: updatedDepositEmployee || employee,
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Payroll - Bulk Employee Salary Deposit
  app.post("/api/payroll/bulk-deposit-employees", requireAuth, requireNonPOS, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const { deposits, date, notes } = req.body;

      if (!deposits || !Array.isArray(deposits) || deposits.length === 0) {
        return res.status(400).json({ message: "No deposits provided" });
      }

      if (!date) {
        return res.status(400).json({ message: "Date is required" });
      }

      // Validate all deposit amounts
      for (const deposit of deposits) {
        const amount = parseMoneyInput(deposit.amount);
        if (!amount || amount.lte(0)) {
          return res.status(400).json({
            message: "All deposit amounts must be positive numbers",
          });
        }
      }
      // Only employees of this company post, each amount at cents.
      const postable = await postableAdjustments(deposits, req.session.currentCompanyId);
      if (postable.length === 0) {
        return res.status(400).json({ message: "No deposits provided" });
      }

      // Build group-membership lookup: employeeId → groupName
      const bulkDepGroupMemberships = await db
        .select({ employeeId: employeeGroupMembers.employeeId, groupName: employeeGroups.name })
        .from(employeeGroupMembers)
        .innerJoin(employeeGroups, eq(employeeGroupMembers.employeeGroupId, employeeGroups.id))
        .where(and(eq(employeeGroups.companyId, req.session.currentCompanyId!), eq(employeeGroups.active, true)));
      const bulkDepEmpGroupMap = new Map<number, string>();
      for (const row of bulkDepGroupMemberships) {
        if (!bulkDepEmpGroupMap.has(row.employeeId)) bulkDepEmpGroupMap.set(row.employeeId, row.groupName);
      }

      // Calculate total amount
      const totalAmount = sumMoney(postable.map((d) => d.amount)).toNumber();

      // Create single voucher for all deposits
      const voucherNumber = `SAL-DEP-BULK-${Date.now()}`;

      // Group deposits by employee group and create one debit per group
      const bulkDepByGroup = new Map<string, ReturnType<typeof toMoney>>();
      for (const d of postable) {
        const grp = (bulkDepEmpGroupMap.get(d.employee.id) || "").trim() || "__default__";
        bulkDepByGroup.set(grp, (bulkDepByGroup.get(grp) ?? toMoney(0)).plus(d.amount));
      }
      const bulkDepFreshAccounts = await storage.getAllLedgerAccounts(req.session.currentCompanyId);
      const bulkDepGroupDebits: { ledgerAccountId: number; debitAmount: string; narration: string }[] = [];
      for (const [grp, grpTotal] of bulkDepByGroup) {
        const isDefault = grp === "__default__";
        const expCode = isDefault
          ? "SALARY_EXPENSE"
          : `SAL_EXP_${grp
              .toUpperCase()
              .replace(/[^A-Z0-9]/g, "_")
              .substring(0, 25)}`;
        const expName = isDefault ? "Salary Expense" : `Salary Expense - ${grp}`;
        let expAccount = bulkDepFreshAccounts.find((a) => a.code === expCode);
        if (!expAccount) {
          expAccount = await storage.createLedgerAccount({
            companyId: req.session.currentCompanyId!,
            code: expCode,
            name: expName,
            accountType: "Expense",
            openingBalance: "0",
            active: true,
          });
        }
        bulkDepGroupDebits.push({
          ledgerAccountId: expAccount.id,
          debitAmount: grpTotal.toFixed(2),
          narration: isDefault
            ? `Bulk salary deposit - ${postable.length} employees - ${voucherNumber}`
            : `Salary expense - ${grp} - ${voucherNumber}`,
        });
      }

      // Voucher header and every entry commit together (balanced-voucher trigger).
      const { voucher, results } = await db.transaction(async (tx) => {
        const [voucher] = await tx
          .insert(vouchers)
          .values({
            companyId: req.session.currentCompanyId!,
            voucherNumber,
            voucherType: "Journal",
            voucherDate: date,
            description: notes || `Bulk salary deposit for ${postable.length} employees`,
            totalAmount: totalAmount.toFixed(2),
          })
          .returning();

        for (const debit of bulkDepGroupDebits) {
          await tx.insert(voucherEntries).values({
            voucherId: voucher.id,
            ledgerAccountId: debit.ledgerAccountId,
            debitAmount: debit.debitAmount,
            creditAmount: "0",
            narration: debit.narration,
          });
        }

        // Process each employee deposit
        const results = [];
        for (const deposit of postable) {
          const { employee } = deposit;
          const depositAmount = deposit.amount.toNumber();

          // Credit employee (using employeeId field directly instead of separate ledger account)
          await tx.insert(voucherEntries).values({
            voucherId: voucher.id,
            ledgerAccountId: null,
            employeeId: employee.id,
            debitAmount: "0",
            creditAmount: depositAmount.toFixed(2),
            narration: `Salary deposit for ${employee.firstName} ${employee.lastName} - ${voucherNumber}`,
          });

          results.push({
            employeeId: employee.id,
            name: `${employee.firstName} ${employee.lastName}`,
            amount: depositAmount,
          });
        }
        // Sync all employee balances from voucher entries, in the voucher's transaction (wave 12).
        const allDepositEntries = await tx
          .select()
          .from(voucherEntries)
          .where(eq(voucherEntries.voucherId, voucher.id));
        await syncEmployeeBalancesFromEntries(
          allDepositEntries.map((e) => ({
            ledgerAccountId: e.ledgerAccountId,
            employeeId: e.employeeId,
            debitAmount: e.debitAmount,
            creditAmount: e.creditAmount,
          })),
          req.session.currentCompanyId!,
          false,
          tx
        );
        return { voucher, results };
      });

      // Get updated balances for all employees
      const updatedResults = [];
      for (const result of results) {
        const [updatedEmp] = await db.select().from(employees).where(eq(employees.id, result.employeeId));
        updatedResults.push({
          ...result,
          newBalance: updatedEmp ? toMoney(updatedEmp.currentBalance).toNumber() : 0,
        });
      }

      res.json({
        voucher,
        deposits: updatedResults,
        totalAmount,
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
