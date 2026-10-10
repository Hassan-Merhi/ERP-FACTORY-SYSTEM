/**
 * payrollRoutes: PayrollSummary endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { eq, and, isNull } from "drizzle-orm";
import { db } from "../../db";
import { storage } from "../../storage";
import { requireAuth, requireNonPOS } from "../../auth";
import { voucherEntries, vouchers } from "@shared/schema";
import { MoneyDecimal, sumMoney } from "../../lib/money";

export function registerPayrollSummaryRoutes(app: Express) {
  // Get employees with calculated balances from transactions
  app.get("/api/payroll/employees-with-balances", requireAuth, async (req, res) => {
    // Disable HTTP caching - employee balances are dynamically calculated
    res.set("Cache-Control", "no-store");
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const employeesWithBalances = await storage.getEmployeesWithBalances(req.session.currentCompanyId);
      res.json(employeesWithBalances);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Get worker payment summary (total paid to each worker)
  app.get("/api/payroll/worker-payments-summary", requireAuth, requireNonPOS, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      // Get all employees of type Worker for current company
      const allEmployees = await storage.getAllEmployees(req.session.currentCompanyId);
      const workers = allEmployees.filter((emp) => emp.employeeType === "Worker");

      // Get all ledger accounts for current company
      const allAccounts = await storage.getAllLedgerAccounts(req.session.currentCompanyId);

      // Calculate total paid per worker by checking their employee liability account
      const workerPayments = await Promise.all(
        workers.map(async (worker) => {
          // Find employee's liability account (code: EMP-{worker.code})
          const employeeAccountCode = `EMP-${worker.code}`;
          const employeeAccount = allAccounts.find((a) => a.code === employeeAccountCode);

          let totalPaid = new MoneyDecimal(0);

          if (employeeAccount) {
            // Get all voucher entries that credit this employee account (withdrawals/payments)
            const entries = await db
              .select({
                creditAmount: voucherEntries.creditAmount,
              })
              .from(voucherEntries)
              .innerJoin(vouchers, eq(voucherEntries.voucherId, vouchers.id))
              .where(
                and(
                  eq(vouchers.companyId, req.session.currentCompanyId!),
                  eq(voucherEntries.ledgerAccountId, employeeAccount.id),
                  isNull(vouchers.deletedAt),
                  eq(vouchers.optional, false)
                )
              );

            // Sum all credits (payments to worker)
            totalPaid = sumMoney(entries.map((entry) => entry.creditAmount));
          }

          return {
            workerId: worker.id,
            workerCode: worker.code,
            workerName: `${worker.firstName} ${worker.lastName}`,
            totalPaid: totalPaid.toFixed(2),
          };
        })
      );

      // Calculate grand total
      const grandTotal = sumMoney(workerPayments.map((wp) => wp.totalPaid));

      res.json({
        workerPayments,
        grandTotal: grandTotal.toFixed(2),
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
