/**
 * payrollRoutes: PayrollWithdrawal endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { eq, and } from "drizzle-orm";
import { db } from "../../db";
import { requireAuth, requireNonPOS } from "../../auth";
import { syncEmployeeBalancesFromEntries } from "../_helpers";
import { bankAccounts, employees, ledgerAccounts } from "@shared/schema";
import {
  erpRequestSourceId,
  pairLines,
  postErpVoucherTx,
  sessionPostingActor,
} from "../../services/accounting/erpVoucherPosting";
import { parseMoneyInput } from "../../lib/money";

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

      const withdrawalAmount = parseMoneyInput(amount)?.toDecimalPlaces(2) ?? null;
      if (!withdrawalAmount || withdrawalAmount.lte(0)) {
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

      // The credited cash or bank account must belong to this company.
      if (accountType === "cash") {
        const [cash] = await db
          .select({ id: ledgerAccounts.id })
          .from(ledgerAccounts)
          .where(
            and(eq(ledgerAccounts.id, Number(accountId)), eq(ledgerAccounts.companyId, req.session.currentCompanyId))
          );
        if (!cash) return res.status(404).json({ message: "Cash account not found" });
      } else {
        const [bank] = await db
          .select({ id: bankAccounts.id })
          .from(bankAccounts)
          .where(and(eq(bankAccounts.id, Number(accountId)), eq(bankAccounts.companyId, req.session.currentCompanyId)));
        if (!bank) return res.status(404).json({ message: "Payment account not found" });
      }

      // Phase 22 (B): Dr employee / Cr cash or bank through the central engine
      // (number allocated there; a resent request returns the same voucher).
      const requestSourceId = erpRequestSourceId(req);
      const voucher = await db.transaction(async (tx) => {
        const narration = "Salary withdrawal";
        const posted = await postErpVoucherTx(tx, {
          companyId: req.session.currentCompanyId!,
          voucherType: "Payment",
          voucherDate: date,
          description: notes || `Salary withdrawal for ${employee.firstName} ${employee.lastName}`,
          lines: pairLines(
            { employeeId: employee.id },
            accountType === "cash" ? { ledgerAccountId: Number(accountId) } : { bankAccountId: Number(accountId) },
            withdrawalAmount,
            narration
          ),
          source: { type: "employee-salary-withdrawal", id: `${employee.id}:${requestSourceId}` },
          actor: sessionPostingActor(req, "Salary withdrawal"),
        });
        const { voucher } = posted;
        if (posted.replayed) return voucher;
        // Wave 12: the balance moves in the voucher's transaction.
        await syncEmployeeBalancesFromEntries(
          [
            {
              ledgerAccountId: null,
              employeeId: employee.id,
              debitAmount: withdrawalAmount.toFixed(2),
              creditAmount: "0",
            },
          ],
          req.session.currentCompanyId!,
          false,
          tx
        );
        return voucher;
      });

      // Get updated employee balance
      const [updatedEmployee] = await db.select().from(employees).where(eq(employees.id, employee.id));

      res.json({
        voucher,
        employee: updatedEmployee || employee,
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
