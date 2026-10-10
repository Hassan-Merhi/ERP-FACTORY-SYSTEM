/**
 * payrollRoutes: PayrollWorkerPayment endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { eq, and, inArray } from "drizzle-orm";
import { db, type DbTransaction } from "../../db";
import { requireAuth, requireNonPOS } from "../../auth";
import type Decimal from "decimal.js";
import { MoneyDecimal, moneyString, parseMoneyInput, sumMoney } from "../../lib/money";
import {
  bankAccounts,
  employeeGroupMembers,
  employeeGroups,
  employees,
  ledgerAccounts,
  voucherEntries,
  vouchers,
} from "@shared/schema";

/**
 * Finds or creates a salary expense account inside the posting transaction, so
 * a failed payment leaves no account behind and two concurrent payments cannot
 * create it twice (unique (company_id, code)).
 */
async function salaryExpenseAccountTx(
  tx: DbTransaction,
  companyId: number,
  code: string,
  name: string
): Promise<number> {
  await tx
    .insert(ledgerAccounts)
    .values({ companyId, code, name, accountType: "Expense", openingBalance: "0", active: true })
    .onConflictDoNothing();
  const [account] = await tx
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(and(eq(ledgerAccounts.companyId, companyId), eq(ledgerAccounts.code, code)))
    .limit(1);
  return account.id;
}

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

      // At cents first (main #2113): an amount that rounds to 0.00 is refused rather than posted as zero.
      const parsedAmount = parseMoneyInput(amount)?.toDecimalPlaces(2) ?? null;
      if (!parsedAmount || parsedAmount.lte(0)) {
        return res.status(400).json({ message: "Amount must be a positive number" });
      }
      const paymentAmount = moneyString(parsedAmount);
      const companyId = req.session.currentCompanyId;

      // Get employee/worker (of this company only)
      const [employee] = await db
        .select()
        .from(employees)
        .where(and(eq(employees.id, employeeId), eq(employees.companyId, companyId)));
      if (!employee) {
        return res.status(404).json({ message: "Worker not found" });
      }

      // The credited bank account must belong to this company.
      const [bank] = await db
        .select({ id: bankAccounts.id })
        .from(bankAccounts)
        .where(and(eq(bankAccounts.id, Number(bankAccountId)), eq(bankAccounts.companyId, companyId)));
      if (!bank) return res.status(404).json({ message: "Payment account not found" });

      // Dr Salary Expense / Cr bank, posted together or not at all.
      const voucherNumber = `SAL-PAY-${Date.now()}`;
      const voucher = await db.transaction(async (tx) => {
        const salaryExpenseAccountId = await salaryExpenseAccountTx(tx, companyId, "SALARY_EXPENSE", "Salary Expense");
        const [created] = await tx
          .insert(vouchers)
          .values({
            companyId,
            voucherNumber,
            voucherType: "Payment",
            voucherDate: date,
            description: notes || `Salary payment for ${employee.firstName} ${employee.lastName}`,
            totalAmount: paymentAmount,
          })
          .returning();
        await tx.insert(voucherEntries).values([
          {
            voucherId: created.id,
            ledgerAccountId: salaryExpenseAccountId,
            debitAmount: paymentAmount,
            creditAmount: "0",
            narration: `Salary payment - ${voucherNumber}`,
          },
          {
            voucherId: created.id,
            bankAccountId,
            debitAmount: "0",
            creditAmount: paymentAmount,
            narration: `Salary payment - ${voucherNumber}`,
          },
        ]);
        return created;
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

      // Validate all payment amounts (exact cents, as the voucher stores them)
      const parsedPayments: { employeeId: number; amount: Decimal }[] = [];
      for (const payment of payments) {
        const parsed = parseMoneyInput(payment.amount);
        if (!parsed || parsed.lte(0)) {
          return res.status(400).json({
            message: "All payment amounts must be positive numbers",
          });
        }
        parsedPayments.push({
          employeeId: Number(payment.employeeId),
          amount: new MoneyDecimal(moneyString(parsed)),
        });
      }
      const companyId = req.session.currentCompanyId;

      // Every worker paid must belong to this company.
      const employeeIds = [...new Set(parsedPayments.map((payment) => payment.employeeId))];
      const ownEmployees = await db
        .select({ id: employees.id })
        .from(employees)
        .where(and(eq(employees.companyId, companyId), inArray(employees.id, employeeIds)));
      if (ownEmployees.length !== employeeIds.length) {
        return res.status(404).json({ message: "Worker not found" });
      }

      // The credited cash or bank account must belong to this company.
      const creditAccountId = parseInt(accountId);
      if (accountType === "cash") {
        const [cash] = await db
          .select({ id: ledgerAccounts.id })
          .from(ledgerAccounts)
          .where(and(eq(ledgerAccounts.id, creditAccountId), eq(ledgerAccounts.companyId, companyId)));
        if (!cash) return res.status(404).json({ message: "Cash account not found" });
      } else {
        const [bank] = await db
          .select({ id: bankAccounts.id })
          .from(bankAccounts)
          .where(and(eq(bankAccounts.id, creditAccountId), eq(bankAccounts.companyId, companyId)));
        if (!bank) return res.status(404).json({ message: "Payment account not found" });
      }

      // Build group-membership lookup: employeeId → groupName
      const bulkPayGroupMemberships = await db
        .select({ employeeId: employeeGroupMembers.employeeId, groupName: employeeGroups.name })
        .from(employeeGroupMembers)
        .innerJoin(employeeGroups, eq(employeeGroupMembers.employeeGroupId, employeeGroups.id))
        .where(and(eq(employeeGroups.companyId, companyId), eq(employeeGroups.active, true)));
      const bulkPayEmpGroupMap = new Map<number, string>();
      for (const row of bulkPayGroupMemberships) {
        if (!bulkPayEmpGroupMap.has(row.employeeId)) bulkPayEmpGroupMap.set(row.employeeId, row.groupName);
      }

      // One debit per employee group; the credit is their exact sum, so the
      // voucher balances to the cent (float sums rounded separately could not).
      const bulkPayByGroup = new Map<string, Decimal>();
      for (const p of parsedPayments) {
        const grp = (bulkPayEmpGroupMap.get(p.employeeId) || "").trim() || "__default__";
        bulkPayByGroup.set(grp, (bulkPayByGroup.get(grp) ?? new MoneyDecimal(0)).plus(p.amount));
      }
      const totalAmount = sumMoney([...bulkPayByGroup.values()]);

      const voucherNumber = `SAL-BULK-${Date.now()}`;
      const voucher = await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(vouchers)
          .values({
            companyId,
            voucherNumber,
            voucherType: "Payment",
            voucherDate: date,
            description: notes || `Bulk salary payment for ${payments.length} workers`,
            totalAmount: moneyString(totalAmount),
          })
          .returning();

        for (const [grp, grpTotal] of bulkPayByGroup) {
          const isDefault = grp === "__default__";
          const expCode = isDefault
            ? "SALARY_EXPENSE"
            : `SAL_EXP_${grp
                .toUpperCase()
                .replace(/[^A-Z0-9]/g, "_")
                .substring(0, 25)}`;
          const expName = isDefault ? "Salary Expense" : `Salary Expense - ${grp}`;
          const expAccountId = await salaryExpenseAccountTx(tx, companyId, expCode, expName);
          await tx.insert(voucherEntries).values({
            voucherId: created.id,
            ledgerAccountId: expAccountId,
            debitAmount: moneyString(grpTotal),
            creditAmount: "0",
            narration: isDefault
              ? `Bulk salary payment - ${payments.length} workers - ${voucherNumber}`
              : `Salary expense - ${grp} - ${voucherNumber}`,
          });
        }

        // Credit entry for the bank/cash account
        await tx.insert(voucherEntries).values({
          voucherId: created.id,
          debitAmount: "0",
          creditAmount: moneyString(totalAmount),
          narration: `Bulk salary payment - ${payments.length} workers - ${voucherNumber}`,
          ...(accountType === "cash" ? { ledgerAccountId: creditAccountId } : { bankAccountId: creditAccountId }),
        });
        return created;
      });

      res.json({
        voucher,
        paymentsProcessed: payments.length,
        totalAmount: moneyString(totalAmount),
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
