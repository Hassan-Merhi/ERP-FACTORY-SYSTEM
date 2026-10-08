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
import { eq, and, inArray } from "drizzle-orm";
import type Decimal from "decimal.js";
import { parseMoneyInput, sumMoney, toMoney } from "../../../../lib/money";

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

      // Each amount at cents; the cash credit below is the sum of these exact lines.
      const amountsAtCents = withdrawals.map((w) => parseMoneyInput(w.amount)?.toDecimalPlaces(2) ?? null);
      const requested = withdrawals
        .map((w, index) => ({ ...w, exactAmount: amountsAtCents[index] }))
        .filter(
          (w): w is typeof w & { exactAmount: Decimal } => !!w.exactAmount && w.exactAmount.gt(0) && !!w.employeeId
        );
      // Only this company's employees are debited, and only they count toward the
      // cash credit, so a skipped employee no longer leaves the voucher unbalanced.
      const companyEmployees = requested.length
        ? await db
            .select()
            .from(employees)
            .where(
              and(
                eq(employees.companyId, companyId),
                inArray(
                  employees.id,
                  requested.map((w) => parseInt(w.employeeId))
                )
              )
            )
        : [];
      const employeeById = new Map(companyEmployees.map((emp) => [emp.id, emp]));
      const validWithdrawals = requested.filter((w) => employeeById.has(parseInt(w.employeeId)));
      if (validWithdrawals.length === 0)
        return res.status(400).json({ message: "No valid withdrawal amounts provided" });

      const [cashAccount] = await db
        .select()
        .from(ledgerAccounts)
        .where(and(eq(ledgerAccounts.id, parseInt(cashAccountId)), eq(ledgerAccounts.companyId, companyId)));
      if (!cashAccount) return res.status(404).json({ message: "Cash account not found" });

      const totalAmount = sumMoney(validWithdrawals.map((w) => w.exactAmount));
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
          const amount = wd.exactAmount;
          // Re-read inside the transaction: the balance is current, and a repeated
          // employee starts from the balance the previous line left.
          // The cash credit already counts this line, so it is always debited
          // (validWithdrawals holds only this company's employees).
          const [fresh] = await tx
            .select()
            .from(employees)
            .where(and(eq(employees.id, empId), eq(employees.companyId, companyId)));
          const emp = fresh ?? employeeById.get(empId)!;

          // DR: Employee
          await tx.insert(voucherEntries).values({
            voucherId: bulkVoucher.id,
            ledgerAccountId: null,
            employeeId: empId,
            debitAmount: amount.toFixed(2),
            creditAmount: "0",
            narration: wd.notes || `Withdrawal for ${emp.firstName} ${emp.lastName} - ${voucherNumber}`,
          });

          const newBalance = toMoney(emp.currentBalance).minus(amount);
          const newWithdrawals = toMoney(emp.totalWithdrawals).plus(amount);
          await tx
            .update(employees)
            .set({
              currentBalance: newBalance.toFixed(2),
              totalWithdrawals: newWithdrawals.toFixed(2),
            })
            .where(eq(employees.id, empId));

          results.push({ employeeId: empId, amount: amount.toNumber(), name: `${emp.firstName} ${emp.lastName}` });
        }
        return { bulkVoucher, results };
      });

      res.json({ voucher: bulkVoucher, results, totalAmount: totalAmount.toNumber() });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ─── Employee Advances ────────────────────────────────────────────────────────
}
