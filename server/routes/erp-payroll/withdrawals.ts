/**
 * payrollRoutes: PayrollWithdrawal endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { requireAuth, requireNonPOS } from "../../auth";
import { syncEmployeeBalancesFromEntries } from "../_helpers";
import { employees, voucherEntries, vouchers } from "@shared/schema";

export function registerPayrollWithdrawalRoutes(app: Express) {
  // Payroll - Employee Withdrawal
  app.post("/api/payroll/withdraw-employee", requireAuth, requireNonPOS, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const { employeeId, amount, paymentAccountType, paymentAccountId, bankAccountId, date, notes } = req.body;

      // Support both old (bankAccountId) and new (paymentAccountType/paymentAccountId) parameters
      const accountType = paymentAccountType || "bank";
      const accountId = paymentAccountId || bankAccountId;

      if (!employeeId || !amount || !accountId || !date) {
        return res.status(400).json({
          message: "Employee, amount, payment account, and date are required",
        });
      }

      const withdrawalAmount = parseFloat(amount);
      if (isNaN(withdrawalAmount) || withdrawalAmount <= 0) {
        return res.status(400).json({ message: "Amount must be a positive number" });
      }

      // Get employee
      const [employee] = await db.select().from(employees).where(eq(employees.id, employeeId));
      if (!employee) {
        return res.status(404).json({ message: "Employee not found" });
      }

      const _currentBalance = parseFloat(employee.currentBalance);

      // Create voucher
      const voucherNumber = `SAL-WD-${Date.now()}`;
      const [voucher] = await db
        .insert(vouchers)
        .values({
          companyId: req.session.currentCompanyId,
          voucherNumber,
          voucherType: "Payment",
          voucherDate: date,
          description: notes || `Salary withdrawal for ${employee.firstName} ${employee.lastName}`,
          totalAmount: withdrawalAmount.toFixed(2),
        })
        .returning();

      // Create voucher entries (double-entry)
      // Debit: Employee (using employeeId field directly instead of separate ledger account)
      await db.insert(voucherEntries).values({
        voucherId: voucher.id,
        ledgerAccountId: null,
        employeeId: employee.id,
        debitAmount: withdrawalAmount.toFixed(2),
        creditAmount: "0",
        narration: `Salary withdrawal - ${voucherNumber}`,
      });

      // Credit: Bank/Cash Account
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
        creditAmount: withdrawalAmount.toFixed(2),
        narration: `Salary withdrawal - ${voucherNumber}`,
      };

      if (accountType === "cash") {
        creditEntry.ledgerAccountId = accountId;
      } else {
        creditEntry.bankAccountId = accountId;
      }

      await db.insert(voucherEntries).values(creditEntry);

      // Sync employee balance from voucher entries (instead of direct update)
      await syncEmployeeBalancesFromEntries(
        [
          {
            ledgerAccountId: null,
            employeeId: employee.id,
            debitAmount: withdrawalAmount.toFixed(2),
            creditAmount: "0",
          },
        ],
        req.session.currentCompanyId!
      );

      // Get updated employee balance
      const [updatedEmployee] = await db.select().from(employees).where(eq(employees.id, employeeId));

      res.json({
        voucher,
        employee: updatedEmployee || employee,
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
