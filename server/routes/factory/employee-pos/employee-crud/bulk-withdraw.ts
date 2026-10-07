/**
 * employeeCrudRoutes: FactoryEmployeeBulkWithdraw endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../../lib/httpHandlers";
import { db } from "../../../../db";
import { requireAuth } from "../../../../auth";
import { ledgerAccounts, voucherEntries, employees, vouchers } from "@shared/schema";
import { eq, and } from "drizzle-orm";

export function registerFactoryEmployeeBulkWithdrawRoutes(app: Express) {
  // POST /api/factory/employees/bulk-withdraw — withdraw from multiple employees at once
  app.post("/api/factory/employees/bulk-withdraw", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const { withdrawals, date, notes, cashAccountId } = req.body;
      if (!withdrawals || !Array.isArray(withdrawals) || withdrawals.length === 0)
        return res.status(400).json({ message: "No withdrawals provided" });
      if (!date) return res.status(400).json({ message: "Date is required" });
      if (!cashAccountId) return res.status(400).json({ message: "Cash account is required" });

      const validWithdrawals = withdrawals.filter((w) => {
        const a = parseFloat(w.amount);
        return !isNaN(a) && a > 0 && w.employeeId;
      });
      if (validWithdrawals.length === 0)
        return res.status(400).json({ message: "No valid withdrawal amounts provided" });

      const [cashAccount] = await db
        .select()
        .from(ledgerAccounts)
        .where(and(eq(ledgerAccounts.id, parseInt(cashAccountId)), eq(ledgerAccounts.companyId, companyId)));
      if (!cashAccount) return res.status(404).json({ message: "Cash account not found" });

      const totalAmount = validWithdrawals.reduce((s: number, w) => s + parseFloat(w.amount), 0);
      const voucherNumber = `EMP-WD-BULK-${Date.now()}`;

      const { bulkVoucher, results } = await db.transaction(async (tx) => {
        const [bulkVoucher] = await tx
          .insert(vouchers)
          .values({
            companyId,
            voucherNumber,
            voucherType: "Journal",
            voucherDate: date,
            description: notes || `Bulk withdrawal - ${validWithdrawals.length} employees`,
            totalAmount: totalAmount.toFixed(2),
          })
          .returning();

        // CR: Cash (total)
        await tx.insert(voucherEntries).values({
          voucherId: bulkVoucher.id,
          ledgerAccountId: cashAccount.id,
          debitAmount: "0",
          creditAmount: totalAmount.toFixed(2),
          narration: notes || `Bulk withdrawal - ${validWithdrawals.length} employees - ${voucherNumber}`,
        });

        const results = [];
        for (const wd of validWithdrawals) {
          const empId = parseInt(wd.employeeId);
          const amount = parseFloat(wd.amount);
          const [emp] = await tx
            .select()
            .from(employees)
            .where(and(eq(employees.id, empId), eq(employees.companyId, companyId)));
          if (!emp) continue;

          // DR: Employee
          await tx.insert(voucherEntries).values({
            voucherId: bulkVoucher.id,
            ledgerAccountId: null,
            employeeId: empId,
            debitAmount: amount.toFixed(2),
            creditAmount: "0",
            narration: wd.notes || `Withdrawal for ${emp.firstName} ${emp.lastName} - ${voucherNumber}`,
          });

          const newBalance = parseFloat(emp.currentBalance || "0") - amount;
          const newWithdrawals = parseFloat(emp.totalWithdrawals || "0") + amount;
          await tx
            .update(employees)
            .set({
              currentBalance: newBalance.toFixed(2),
              totalWithdrawals: newWithdrawals.toFixed(2),
            })
            .where(eq(employees.id, empId));

          results.push({ employeeId: empId, amount, name: `${emp.firstName} ${emp.lastName}` });
        }
        return { bulkVoucher, results };
      });

      res.json({ voucher: bulkVoucher, results, totalAmount });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ─── Employee Advances ────────────────────────────────────────────────────────
}
