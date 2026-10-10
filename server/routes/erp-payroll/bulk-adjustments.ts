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
import { sumMoney, toMoney } from "../../lib/money";
import { postableAdjustments } from "./postableAdjustments";

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

      // Filter out empty/zero amounts and employees outside this company
      const validBonuses = await postableAdjustments(bonuses, req.session.currentCompanyId);

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
      const totalAmount = sumMoney(validBonuses.map((b) => b.amount)).toNumber();

      // Create single voucher for all bonuses
      const voucherNumber = `BONUS-BULK-${Date.now()}`;

      // Group bonuses by worker group and create one debit entry per group
      const bonusByGroup = new Map<string, ReturnType<typeof toMoney>>();
      for (const b of validBonuses) {
        const grp = (bonusEmpGroupMap.get(b.employee.id) || "").trim() || "__default__";
        bonusByGroup.set(grp, (bonusByGroup.get(grp) ?? toMoney(0)).plus(b.amount));
      }
      const freshAccounts = await storage.getAllLedgerAccounts(req.session.currentCompanyId);
      const bonusGroupDebits: { ledgerAccountId: number; debitAmount: string; narration: string }[] = [];
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
        bonusGroupDebits.push({
          ledgerAccountId: bonusAccount.id,
          debitAmount: grpTotal.toFixed(2),
          narration: isDefault
            ? `Bulk bonus deposit - ${validBonuses.length} employees - ${voucherNumber}`
            : `Bonus expense - ${grp} - ${voucherNumber}`,
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
            description: notes || `Bulk bonus deposit for ${validBonuses.length} employees`,
            totalAmount: totalAmount.toFixed(2),
          })
          .returning();

        for (const debit of bonusGroupDebits) {
          await tx.insert(voucherEntries).values({
            voucherId: voucher.id,
            ledgerAccountId: debit.ledgerAccountId,
            debitAmount: debit.debitAmount,
            creditAmount: "0",
            narration: debit.narration,
          });
        }

        // Process each employee bonus
        const results = [];
        for (const bonus of validBonuses) {
          const { employee } = bonus;
          const bonusAmount = bonus.amount.toNumber();

          // Credit employee (using employeeId field directly instead of separate ledger account)
          await tx.insert(voucherEntries).values({
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
        // Sync all employee balances from voucher entries, in the voucher's transaction (wave 12).
        const allBonusEntries = await tx.select().from(voucherEntries).where(eq(voucherEntries.voucherId, voucher.id));
        await syncEmployeeBalancesFromEntries(
          allBonusEntries.map((e) => ({
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
      const updatedBonusResults = [];
      for (const result of results) {
        const [updatedEmp] = await db.select().from(employees).where(eq(employees.id, result.employeeId));
        updatedBonusResults.push({
          ...result,
          newBalance: updatedEmp ? toMoney(updatedEmp.currentBalance).toNumber() : 0,
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
      const validWithdrawals = await postableAdjustments(withdrawals, req.session.currentCompanyId);

      if (validWithdrawals.length === 0) {
        return res.status(400).json({ message: "No valid withdrawal amounts provided" });
      }

      // Calculate total amount
      const totalAmount = sumMoney(validWithdrawals.map((w) => w.amount)).toNumber();

      // Get payment account (bank or cash)
      let paymentAccount;
      if (paymentAccountType === "bank") {
        [paymentAccount] = await db
          .select()
          .from(bankAccounts)
          .where(
            and(
              eq(bankAccounts.id, parseInt(paymentAccountId)),
              eq(bankAccounts.companyId, req.session.currentCompanyId!)
            )
          );
      } else {
        const allAccounts = await storage.getAllLedgerAccounts(req.session.currentCompanyId);
        paymentAccount = allAccounts.find((a) => a.id === parseInt(paymentAccountId));
      }

      if (!paymentAccount) {
        return res.status(404).json({ message: "Payment account not found" });
      }

      // Create single voucher for all withdrawals
      // Resolve the payment ledger account before posting so a 404 never leaves
      // an empty voucher header behind.
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

      const voucherNumber = `WD-BULK-${Date.now()}`;
      const { voucher, results } = await db.transaction(async (tx) => {
        const [voucher] = await tx
          .insert(vouchers)
          .values({
            companyId: req.session.currentCompanyId!,
            voucherNumber,
            voucherType: "Journal",
            voucherDate: date,
            description: notes || `Bulk withdrawal for ${validWithdrawals.length} employees`,
            totalAmount: totalAmount.toFixed(2),
          })
          .returning();

        // Create CREDIT entry for payment account (cash going OUT for withdrawal)
        await tx.insert(voucherEntries).values({
          voucherId: voucher.id,
          ledgerAccountId: paymentLedgerAccount.id,
          debitAmount: "0",
          creditAmount: totalAmount.toFixed(2),
          narration: `Bulk withdrawal - ${validWithdrawals.length} employees - ${voucherNumber}`,
        });

        // Process each employee withdrawal
        const results = [];
        for (const withdrawal of validWithdrawals) {
          const { employee } = withdrawal;
          const withdrawAmount = withdrawal.amount.toNumber();

          // Debit employee (using employeeId field directly instead of separate ledger account)
          await tx.insert(voucherEntries).values({
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
        // Sync all employee balances from voucher entries, in the voucher's transaction (wave 12).
        const allWithdrawEntries = await tx
          .select()
          .from(voucherEntries)
          .where(eq(voucherEntries.voucherId, voucher.id));
        await syncEmployeeBalancesFromEntries(
          allWithdrawEntries.map((e) => ({
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
      const updatedWithdrawResults = [];
      for (const result of results) {
        const [updatedEmp] = await db.select().from(employees).where(eq(employees.id, result.employeeId));
        updatedWithdrawResults.push({
          ...result,
          newBalance: updatedEmp ? toMoney(updatedEmp.currentBalance).toNumber() : 0,
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
