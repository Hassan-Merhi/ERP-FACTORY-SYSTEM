/**
 * employeeCrudRoutes: FactoryEmployeeBulkPayroll endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../../lib/httpHandlers";
import { db, type RawQueryRow } from "../../../../db";
import { requireAuth } from "../../../../auth";
import { ledgerAccounts, voucherEntries, employees, vouchers } from "@shared/schema";
import { eq, and, sql, inArray } from "drizzle-orm";
import { MoneyDecimal, parseMoneyInput, sumMoney, toMoney } from "../../../../lib/money";

/** A request amount at cents, read as parseFloat reads it; unparsable input is zero, as it always was here. */
const requestCents = (value: unknown) => (parseMoneyInput(value) ?? new MoneyDecimal(0)).toDecimalPlaces(2);

/**
 * One unpaid employee advance, read under the payroll transaction for FIFO
 * deduction. `remaining_balance` is a numeric column, so it arrives as a
 * decimal string and is parsed rather than coerced.
 */
interface OutstandingAdvanceRow {
  id: number;
  remaining_balance: string | null;
}

export function registerFactoryEmployeeBulkPayrollRoutes(app: Express) {
  // POST /api/factory/employees/bulk-payroll - bulk payroll deposit for multiple employees
  app.post("/api/factory/employees/bulk-payroll", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { deposits, date, notes, effectiveDate } = req.body;
      if (!deposits || !Array.isArray(deposits) || deposits.length === 0) {
        return res.status(400).json({ message: "No deposits provided" });
      }
      if (!date) return res.status(400).json({ message: "Date is required" });

      // Validate: at least amount or deduction must be > 0. Amounts are taken at
      // cents, and only employees of this company post: the totals and the
      // expense/recovery legs are built from exactly the rows that get employee
      // legs, so the voucher balances.
      const candidates = deposits.flatMap((d) => {
        const amount = requestCents(d.amount);
        const deduction = requestCents(d.deduction);
        return d.employeeId && (amount.gt(0) || deduction.gt(0))
          ? [{ empId: parseInt(d.employeeId), amount, deduction }]
          : [];
      });
      const candidateIds = Array.from(new Set(candidates.map((d) => d.empId).filter(Number.isInteger)));
      const companyEmployees =
        candidateIds.length > 0
          ? await db
              .select({ id: employees.id })
              .from(employees)
              .where(and(inArray(employees.id, candidateIds), eq(employees.companyId, companyId)))
          : [];
      const companyEmployeeIds = new Set(companyEmployees.map((e) => e.id));
      const validDeposits = candidates.filter((d) => companyEmployeeIds.has(d.empId));
      if (validDeposits.length === 0) {
        return res.status(400).json({ message: "No valid deposit amounts provided" });
      }

      const totalSalaryExact = sumMoney(validDeposits.map((d) => d.amount));
      const totalDeductionExact = sumMoney(validDeposits.map((d) => d.deduction));
      const totalSalary = totalSalaryExact.toNumber();
      const totalDeduction = totalDeductionExact.toNumber();
      const totalNet = totalSalaryExact.minus(totalDeductionExact).toNumber();
      const voucherNumber = `EMP-PAY-${Date.now()}`;

      const txResult = await db.transaction(async (tx) => {
        // Get or create PAYROLL_DEPOSIT_EXPENSE ledger account
        let [payrollExpenseAccount] = await tx
          .select()
          .from(ledgerAccounts)
          .where(and(eq(ledgerAccounts.companyId, companyId), eq(ledgerAccounts.code, "PAYROLL_DEPOSIT_EXPENSE")));
        if (!payrollExpenseAccount) {
          [payrollExpenseAccount] = await tx
            .insert(ledgerAccounts)
            .values({
              companyId,
              code: "PAYROLL_DEPOSIT_EXPENSE",
              name: "Payroll Deposit Expense",
              accountType: "Indirect Expense",
              openingBalance: "0",
              active: true,
            })
            .returning();
        }

        // Get or create PAYROLL_DEDUCTION_RECOVERY account for deductions
        let [deductionAccount] = await tx
          .select()
          .from(ledgerAccounts)
          .where(and(eq(ledgerAccounts.companyId, companyId), eq(ledgerAccounts.code, "PAYROLL_DEDUCTION_RECOVERY")));
        if (!deductionAccount) {
          [deductionAccount] = await tx
            .insert(ledgerAccounts)
            .values({
              companyId,
              code: "PAYROLL_DEDUCTION_RECOVERY",
              name: "Payroll Deduction Recovery",
              accountType: "Indirect Income",
              openingBalance: "0",
              active: true,
            })
            .returning();
        }

        // Single bulk voucher (totalAmount = gross salary for accounting)
        const [bulkVoucher] = await tx
          .insert(vouchers)
          .values({
            companyId,
            voucherNumber,
            voucherType: "Journal",
            voucherDate: date,
            effectiveDate: (effectiveDate as string) || null,
            description: notes || `Bulk payroll - ${validDeposits.length} employees`,
            totalAmount: totalSalaryExact.minus(totalDeductionExact).abs().toFixed(2),
          })
          .returning();

        // DR: Payroll Expense (gross salary)
        if (totalSalary > 0) {
          await tx.insert(voucherEntries).values({
            voucherId: bulkVoucher.id,
            ledgerAccountId: payrollExpenseAccount.id,
            debitAmount: totalSalaryExact.toFixed(2),
            creditAmount: "0",
            narration: notes || `Bulk payroll gross - ${validDeposits.length} employees - ${voucherNumber}`,
          });
        }

        // CR: Deduction Recovery (total deductions)
        if (totalDeduction > 0) {
          await tx.insert(voucherEntries).values({
            voucherId: bulkVoucher.id,
            ledgerAccountId: deductionAccount.id,
            debitAmount: "0",
            creditAmount: totalDeductionExact.toFixed(2),
            narration: `Payroll deductions - ${voucherNumber}`,
          });
        }

        // Per-employee: credit salary, debit deduction → net balance change
        const results = [];
        for (const dep of validDeposits) {
          const { empId } = dep;
          const amount = dep.amount.toNumber();
          const deduction = dep.deduction.toNumber();
          const net = dep.amount.minus(dep.deduction).toNumber();

          const [emp] = await tx
            .select()
            .from(employees)
            .where(and(eq(employees.id, empId), eq(employees.companyId, companyId)));
          if (!emp) continue;

          // CR employee: salary earned
          if (amount > 0) {
            await tx.insert(voucherEntries).values({
              voucherId: bulkVoucher.id,
              ledgerAccountId: null,
              employeeId: empId,
              debitAmount: "0",
              creditAmount: amount.toFixed(2),
              narration: `Salary for ${emp.firstName} ${emp.lastName} - ${voucherNumber}`,
            });
          }

          // DR employee: deduction applied
          if (deduction > 0) {
            await tx.insert(voucherEntries).values({
              voucherId: bulkVoucher.id,
              ledgerAccountId: null,
              employeeId: empId,
              debitAmount: deduction.toFixed(2),
              creditAmount: "0",
              narration: `Deduction for ${emp.firstName} ${emp.lastName} - ${voucherNumber}`,
            });
          }

          // Deduct outstanding advance balances FIFO (same as ERP payroll)
          if (deduction > 0) {
            const outstanding = await tx.execute<RawQueryRow<OutstandingAdvanceRow>>(sql`
              SELECT id, remaining_balance FROM employee_advances
              WHERE company_id = ${companyId} AND employee_id = ${empId} AND fully_paid = false
              ORDER BY advance_date ASC, id ASC
            `);
            let remaining = dep.deduction;
            for (const adv of outstanding.rows) {
              if (remaining.lte(0.001)) break;
              const bal = toMoney(adv.remaining_balance);
              if (bal.lte(0)) continue;
              const toDeduct = MoneyDecimal.min(remaining, bal);
              const newBal = MoneyDecimal.max(0, bal.minus(toDeduct));
              const fullyPaid = newBal.lte(0.01);

              await tx.execute(sql`
                INSERT INTO employee_advance_repayments (company_id, advance_id, employee_id, repayment_date, amount, cash_account_id, notes)
                VALUES (${companyId}, ${adv.id}, ${empId}, ${date}, ${toDeduct.toFixed(2)}, NULL, ${`Payroll deduction — ${voucherNumber}`})
              `);
              await tx.execute(sql`
                UPDATE employee_advances
                SET remaining_balance = ${newBal.toFixed(2)}, fully_paid = ${fullyPaid}
                WHERE id = ${adv.id}
              `);
              remaining = remaining.minus(toDeduct);
            }
          }

          // Update employee balance: net = salary - deduction (can go negative)
          const newBalance = toMoney(emp.currentBalance).plus(dep.amount).minus(dep.deduction);
          const newDeposits = toMoney(emp.totalDeposits).plus(dep.amount);
          const newWithdrawals = toMoney(emp.totalWithdrawals).plus(dep.deduction);
          await tx
            .update(employees)
            .set({
              currentBalance: newBalance.toFixed(2),
              totalDeposits: newDeposits.toFixed(2),
              ...(deduction > 0 ? { totalWithdrawals: newWithdrawals.toFixed(2) } : {}),
            })
            .where(eq(employees.id, empId));

          results.push({ employeeId: empId, amount, deduction, net, name: `${emp.firstName} ${emp.lastName}` });
        }

        return { bulkVoucher, results };
      });

      res.json({ voucher: txResult.bulkVoucher, results: txResult.results, totalSalary, totalDeduction, totalNet });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
