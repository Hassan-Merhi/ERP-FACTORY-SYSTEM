/**
 * payrollRoutes: PayrollBulkAdjustment endpoints.
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
import { syncEmployeeBalancesFromEntries } from "../_helpers";
import {
  bankAccounts,
  employeeGroupMembers,
  employeeGroups,
  employees,
  voucherEntries,
  vouchers,
  type LedgerAccount,
} from "@shared/schema";

export function registerPayrollBulkAdjustmentRoutes(app: Express) {
  // Payroll - Bulk Employee Bonus Deposit
  app.post("/api/payroll/bulk-bonus-employees", requireAuth, requireNonPOS, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const { bonuses, date, notes } = req.body;

      if (!bonuses || !Array.isArray(bonuses) || bonuses.length === 0) {
        return res.status(400).json({ message: "No bonuses provided" });
      }

      if (!date) {
        return res.status(400).json({ message: "Date is required" });
      }

      // Filter out empty/zero amounts and validate
      const validBonuses = bonuses.filter((b) => {
        const amount = parseFloat(b.amount);
        return !isNaN(amount) && amount > 0;
      });

      if (validBonuses.length === 0) {
        return res.status(400).json({ message: "No valid bonus amounts provided" });
      }

      // Build group-membership lookup: employeeId → groupName
      const bonusGroupMemberships = await db
        .select({ employeeId: employeeGroupMembers.employeeId, groupName: employeeGroups.name })
        .from(employeeGroupMembers)
        .innerJoin(employeeGroups, eq(employeeGroupMembers.employeeGroupId, employeeGroups.id))
        .where(and(eq(employeeGroups.companyId, req.session.currentCompanyId!), eq(employeeGroups.active, true)));
      const bonusEmpGroupMap = new Map<number, string>();
      for (const row of bonusGroupMemberships) {
        if (!bonusEmpGroupMap.has(row.employeeId)) bonusEmpGroupMap.set(row.employeeId, row.groupName);
      }

      const _allAccounts = await storage.getAllLedgerAccounts(req.session.currentCompanyId);

      // Calculate total amount
      const totalAmount = validBonuses.reduce((sum: number, b) => sum + parseFloat(b.amount), 0);

      // Create single voucher for all bonuses
      const voucherNumber = `BONUS-BULK-${Date.now()}`;
      const [voucher] = await db
        .insert(vouchers)
        .values({
          companyId: req.session.currentCompanyId,
          voucherNumber,
          voucherType: "Journal",
          voucherDate: date,
          description: notes || `Bulk bonus deposit for ${validBonuses.length} employees`,
          totalAmount: totalAmount.toFixed(2),
        })
        .returning();

      // Group bonuses by worker group and create one debit entry per group
      const bonusByGroup = new Map<string, number>();
      for (const b of validBonuses) {
        const grp = (bonusEmpGroupMap.get(b.employeeId) || "").trim() || "__default__";
        bonusByGroup.set(grp, (bonusByGroup.get(grp) || 0) + parseFloat(b.amount));
      }
      const freshAccounts = await storage.getAllLedgerAccounts(req.session.currentCompanyId);
      for (const [grp, grpTotal] of bonusByGroup) {
        const isDefault = grp === "__default__";
        const bonusCode = isDefault
          ? "BONUS_EXPENSE"
          : `BONUS_EXP_${grp
              .toUpperCase()
              .replace(/[^A-Z0-9]/g, "_")
              .substring(0, 25)}`;
        const bonusName = isDefault ? "Bonus Expense" : `Bonus Expense - ${grp}`;
        let bonusAccount = freshAccounts.find((a) => a.code === bonusCode);
        if (!bonusAccount) {
          bonusAccount = await storage.createLedgerAccount({
            companyId: req.session.currentCompanyId!,
            code: bonusCode,
            name: bonusName,
            accountType: "Indirect Expense",
            openingBalance: "0",
            active: true,
          });
        }
        await db.insert(voucherEntries).values({
          voucherId: voucher.id,
          ledgerAccountId: bonusAccount.id,
          debitAmount: grpTotal.toFixed(2),
          creditAmount: "0",
          narration: isDefault
            ? `Bulk bonus deposit - ${validBonuses.length} employees - ${voucherNumber}`
            : `Bonus expense - ${grp} - ${voucherNumber}`,
        });
      }

      // Process each employee bonus
      const results = [];
      for (const bonus of validBonuses) {
        const [employee] = await db.select().from(employees).where(eq(employees.id, bonus.employeeId));

        if (!employee) {
          continue; // Skip if employee not found
        }

        // Verify employee belongs to current company
        if (employee.companyId !== req.session.currentCompanyId) {
          continue;
        }

        const bonusAmount = parseFloat(bonus.amount);

        // Credit employee (using employeeId field directly instead of separate ledger account)
        await db.insert(voucherEntries).values({
          voucherId: voucher.id,
          ledgerAccountId: null,
          employeeId: employee.id,
          debitAmount: "0",
          creditAmount: bonusAmount.toFixed(2),
          narration: `Bonus for ${employee.firstName} ${employee.lastName} - ${voucherNumber}`,
        });

        results.push({
          employeeId: employee.id,
          name: `${employee.firstName} ${employee.lastName}`,
          amount: bonusAmount,
        });
      }

      // Sync all employee balances from voucher entries
      const allBonusEntries = await db.select().from(voucherEntries).where(eq(voucherEntries.voucherId, voucher.id));

      await syncEmployeeBalancesFromEntries(
        allBonusEntries.map((e) => ({
          ledgerAccountId: e.ledgerAccountId,
          employeeId: e.employeeId,
          debitAmount: e.debitAmount,
          creditAmount: e.creditAmount,
        })),
        req.session.currentCompanyId!
      );

      // Get updated balances for all employees
      const updatedBonusResults = [];
      for (const result of results) {
        const [updatedEmp] = await db.select().from(employees).where(eq(employees.id, result.employeeId));
        updatedBonusResults.push({
          ...result,
          newBalance: updatedEmp ? parseFloat(updatedEmp.currentBalance) : 0,
        });
      }

      res.json({
        voucher,
        bonuses: updatedBonusResults,
        totalAmount,
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Payroll - Bulk Employee Withdrawal
  app.post("/api/payroll/bulk-withdraw-employees", requireAuth, requireNonPOS, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const { withdrawals, date, notes, paymentAccountType, paymentAccountId } = req.body;

      if (!withdrawals || !Array.isArray(withdrawals) || withdrawals.length === 0) {
        return res.status(400).json({ message: "No withdrawals provided" });
      }

      if (!date || !paymentAccountType || !paymentAccountId) {
        return res.status(400).json({ message: "Date, account type, and account are required" });
      }

      // Filter out empty/zero amounts and validate
      const validWithdrawals = withdrawals.filter((w) => {
        const amount = parseFloat(w.amount);
        return !isNaN(amount) && amount > 0;
      });

      if (validWithdrawals.length === 0) {
        return res.status(400).json({ message: "No valid withdrawal amounts provided" });
      }

      // Calculate total amount
      const totalAmount = validWithdrawals.reduce((sum: number, w) => sum + parseFloat(w.amount), 0);

      // Get payment account (bank or cash)
      let paymentAccount;
      if (paymentAccountType === "bank") {
        [paymentAccount] = await db
          .select()
          .from(bankAccounts)
          .where(eq(bankAccounts.id, parseInt(paymentAccountId)));
      } else {
        const allAccounts = await storage.getAllLedgerAccounts(req.session.currentCompanyId);
        paymentAccount = allAccounts.find((a) => a.id === parseInt(paymentAccountId));
      }

      if (!paymentAccount) {
        return res.status(404).json({ message: "Payment account not found" });
      }

      // Create single voucher for all withdrawals
      const voucherNumber = `WD-BULK-${Date.now()}`;
      const [voucher] = await db
        .insert(vouchers)
        .values({
          companyId: req.session.currentCompanyId,
          voucherNumber,
          voucherType: "Journal",
          voucherDate: date,
          description: notes || `Bulk withdrawal for ${validWithdrawals.length} employees`,
          totalAmount: totalAmount.toFixed(2),
        })
        .returning();

      // Create CREDIT entry for payment account (cash going OUT for withdrawal)
      const paymentAccountId_num = parseInt(paymentAccountId);
      const allAccounts = await storage.getAllLedgerAccounts(req.session.currentCompanyId);
      let paymentLedgerAccount;

      if (paymentAccountType === "bank") {
        // For bank accounts, find the corresponding ledger account
        // Ledger rows carry no bankAccountId column, so this predicate never matches and the
        // bank branch answers 404. Preserved as-is; wiring the bank-to-ledger link is a
        // behaviour change for a separate fix.
        paymentLedgerAccount = allAccounts.find(
          (a: LedgerAccount & { bankAccountId?: unknown }) => a.bankAccountId === paymentAccountId_num
        );
        if (!paymentLedgerAccount) {
          return res.status(404).json({ message: "Ledger account for bank account not found" });
        }
      } else {
        // For cash accounts (ledger accounts), find directly
        paymentLedgerAccount = allAccounts.find((a) => a.id === paymentAccountId_num);
        if (!paymentLedgerAccount) {
          return res.status(404).json({ message: "Cash account not found" });
        }
      }

      await db.insert(voucherEntries).values({
        voucherId: voucher.id,
        ledgerAccountId: paymentLedgerAccount.id,
        debitAmount: "0",
        creditAmount: totalAmount.toFixed(2),
        narration: `Bulk withdrawal - ${validWithdrawals.length} employees - ${voucherNumber}`,
      });

      // Process each employee withdrawal
      const results = [];
      for (const withdrawal of validWithdrawals) {
        const [employee] = await db.select().from(employees).where(eq(employees.id, withdrawal.employeeId));

        if (!employee) continue;
        if (employee.companyId !== req.session.currentCompanyId) continue;

        const withdrawAmount = parseFloat(withdrawal.amount);

        // Debit employee (using employeeId field directly instead of separate ledger account)
        await db.insert(voucherEntries).values({
          voucherId: voucher.id,
          ledgerAccountId: null,
          employeeId: employee.id,
          debitAmount: withdrawAmount.toFixed(2),
          creditAmount: "0",
          narration: `Withdrawal for ${employee.firstName} ${employee.lastName} - ${voucherNumber}`,
        });

        results.push({
          employeeId: employee.id,
          name: `${employee.firstName} ${employee.lastName}`,
          amount: withdrawAmount,
        });
      }

      // Sync all employee balances from voucher entries
      const allWithdrawEntries = await db.select().from(voucherEntries).where(eq(voucherEntries.voucherId, voucher.id));

      await syncEmployeeBalancesFromEntries(
        allWithdrawEntries.map((e) => ({
          ledgerAccountId: e.ledgerAccountId,
          employeeId: e.employeeId,
          debitAmount: e.debitAmount,
          creditAmount: e.creditAmount,
        })),
        req.session.currentCompanyId!
      );

      // Get updated balances for all employees
      const updatedWithdrawResults = [];
      for (const result of results) {
        const [updatedEmp] = await db.select().from(employees).where(eq(employees.id, result.employeeId));
        updatedWithdrawResults.push({
          ...result,
          newBalance: updatedEmp ? parseFloat(updatedEmp.currentBalance) : 0,
        });
      }

      res.json({
        voucher,
        withdrawals: updatedWithdrawResults,
        totalAmount,
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
