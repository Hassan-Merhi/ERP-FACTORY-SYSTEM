/**
 * payrollRoutes: PayrollWorkerPayment endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { eq, and } from "drizzle-orm";
import { db } from "../../db";
import { storage } from "../../storage";
import { requireAuth, requireNonPOS } from "../../auth";
import { employeeGroupMembers, employeeGroups, employees, voucherEntries, vouchers } from "@shared/schema";

export function registerPayrollWorkerPaymentRoutes(app: Express) {
  // Payroll - Worker Direct Payment
  app.post("/api/payroll/pay-worker", requireAuth, requireNonPOS, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const { employeeId, amount, bankAccountId, date, notes } = req.body;

      if (!employeeId || !amount || !bankAccountId || !date) {
        return res.status(400).json({
          message: "Employee, amount, bank account, and date are required",
        });
      }

      const paymentAmount = parseFloat(amount);
      if (isNaN(paymentAmount) || paymentAmount <= 0) {
        return res.status(400).json({ message: "Amount must be a positive number" });
      }

      // Get employee/worker
      const [employee] = await db.select().from(employees).where(eq(employees.id, employeeId));
      if (!employee) {
        return res.status(404).json({ message: "Worker not found" });
      }

      // Get or create SALARY_EXPENSE ledger account
      const allAccounts = await storage.getAllLedgerAccounts(req.session.currentCompanyId);
      let salaryExpenseAccount = allAccounts.find((a) => a.code === "SALARY_EXPENSE");

      if (!salaryExpenseAccount) {
        salaryExpenseAccount = await storage.createLedgerAccount({
          companyId: req.session.currentCompanyId,
          code: "SALARY_EXPENSE",
          name: "Salary Expense",
          accountType: "Expense",
          openingBalance: "0",
          active: true,
        });
      }

      // Create voucher
      const voucherNumber = `SAL-PAY-${Date.now()}`;
      const [voucher] = await db
        .insert(vouchers)
        .values({
          companyId: req.session.currentCompanyId,
          voucherNumber,
          voucherType: "Payment",
          voucherDate: date,
          description: notes || `Salary payment for ${employee.firstName} ${employee.lastName}`,
          totalAmount: paymentAmount.toFixed(2),
        })
        .returning();

      // Create voucher entries (double-entry)
      // Debit: Salary Expense
      await db.insert(voucherEntries).values({
        voucherId: voucher.id,
        ledgerAccountId: salaryExpenseAccount.id,
        debitAmount: paymentAmount.toFixed(2),
        creditAmount: "0",
        narration: `Salary payment - ${voucherNumber}`,
      });

      // Credit: Bank/Cash Account
      await db.insert(voucherEntries).values({
        voucherId: voucher.id,
        bankAccountId,
        debitAmount: "0",
        creditAmount: paymentAmount.toFixed(2),
        narration: `Salary payment - ${voucherNumber}`,
      });

      res.json({
        voucher,
        employee,
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Payroll - Bulk Worker Payment
  app.post("/api/payroll/bulk-pay-workers", requireAuth, requireNonPOS, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const { payments, paymentAccountType, paymentAccountId, bankAccountId, date, notes } = req.body;

      // Support both old (bankAccountId) and new (paymentAccountType/paymentAccountId) parameters
      const accountType = paymentAccountType || "bank";
      const accountId = paymentAccountId || bankAccountId;

      if (!payments || !Array.isArray(payments) || payments.length === 0) {
        return res.status(400).json({ message: "No payments provided" });
      }

      if (!accountId || !date) {
        return res.status(400).json({ message: "Payment account and date are required" });
      }

      // Validate all payment amounts
      for (const payment of payments) {
        const amount = parseFloat(payment.amount);
        if (isNaN(amount) || amount <= 0) {
          return res.status(400).json({
            message: "All payment amounts must be positive numbers",
          });
        }
      }

      // Build group-membership lookup: employeeId → groupName
      const bulkPayGroupMemberships = await db
        .select({ employeeId: employeeGroupMembers.employeeId, groupName: employeeGroups.name })
        .from(employeeGroupMembers)
        .innerJoin(employeeGroups, eq(employeeGroupMembers.employeeGroupId, employeeGroups.id))
        .where(and(eq(employeeGroups.companyId, req.session.currentCompanyId!), eq(employeeGroups.active, true)));
      const bulkPayEmpGroupMap = new Map<number, string>();
      for (const row of bulkPayGroupMemberships) {
        if (!bulkPayEmpGroupMap.has(row.employeeId)) bulkPayEmpGroupMap.set(row.employeeId, row.groupName);
      }

      // Calculate total amount
      const totalAmount = payments.reduce((sum: number, p) => sum + parseFloat(p.amount), 0);

      // Create single voucher for all payments
      const voucherNumber = `SAL-BULK-${Date.now()}`;
      const [voucher] = await db
        .insert(vouchers)
        .values({
          companyId: req.session.currentCompanyId,
          voucherNumber,
          voucherType: "Payment",
          voucherDate: date,
          description: notes || `Bulk salary payment for ${payments.length} workers`,
          totalAmount: totalAmount.toFixed(2),
        })
        .returning();

      // Group payments by employee group and create one debit per group
      const bulkPayByGroup = new Map<string, number>();
      for (const p of payments) {
        const grp = (bulkPayEmpGroupMap.get(p.employeeId) || "").trim() || "__default__";
        bulkPayByGroup.set(grp, (bulkPayByGroup.get(grp) || 0) + parseFloat(p.amount));
      }
      const bulkPayFreshAccounts = await storage.getAllLedgerAccounts(req.session.currentCompanyId);
      for (const [grp, grpTotal] of bulkPayByGroup) {
        const isDefault = grp === "__default__";
        const expCode = isDefault
          ? "SALARY_EXPENSE"
          : `SAL_EXP_${grp
              .toUpperCase()
              .replace(/[^A-Z0-9]/g, "_")
              .substring(0, 25)}`;
        const expName = isDefault ? "Salary Expense" : `Salary Expense - ${grp}`;
        let expAccount = bulkPayFreshAccounts.find((a) => a.code === expCode);
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
        await db.insert(voucherEntries).values({
          voucherId: voucher.id,
          ledgerAccountId: expAccount.id,
          debitAmount: grpTotal.toFixed(2),
          creditAmount: "0",
          narration: isDefault
            ? `Bulk salary payment - ${payments.length} workers - ${voucherNumber}`
            : `Salary expense - ${grp} - ${voucherNumber}`,
        });
      }

      // Create credit entry for bank/cash account
      const creditEntry: {
        voucherId: number;
        debitAmount: string;
        creditAmount: string;
        narration: string;
        ledgerAccountId?: number;
        bankAccountId?: number;
      } = {
        voucherId: voucher.id,
        debitAmount: "0",
        creditAmount: totalAmount.toFixed(2),
        narration: `Bulk salary payment - ${payments.length} workers - ${voucherNumber}`,
      };

      if (accountType === "cash") {
        creditEntry.ledgerAccountId = parseInt(accountId);
      } else {
        creditEntry.bankAccountId = parseInt(accountId);
      }

      await db.insert(voucherEntries).values(creditEntry);

      res.json({
        voucher,
        paymentsProcessed: payments.length,
        totalAmount: totalAmount.toFixed(2),
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
