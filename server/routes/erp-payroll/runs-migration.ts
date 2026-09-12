/**
 * payrollRoutes: PayrollRunMigration endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { eq, and } from "drizzle-orm";
import { db, pool } from "../../db";
import { storage } from "../../storage";
import { requireAuth, requireNonPOS } from "../../auth";
import {
  employeeGroupMembers,
  employeeGroups,
  erpPayrollRunItems,
  erpPayrollRuns,
  voucherEntries,
  vouchers,
} from "@shared/schema";

export function registerPayrollRunMigrationRoutes(app: Express) {
  // ── Migrate old PAID runs to per-group Salary Expense - {Group} accounts ──
  app.post(
    "/api/payroll/runs/migrate-group-expenses",
    requireAuth,
    requireNonPOS,
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const companyIdNum: number = companyId;

        // Shared group-membership lookup: employeeId → groupName (current assignments)
        const groupMemberships = await db
          .select({ employeeId: employeeGroupMembers.employeeId, groupName: employeeGroups.name })
          .from(employeeGroupMembers)
          .innerJoin(employeeGroups, eq(employeeGroupMembers.employeeGroupId, employeeGroups.id))
          .where(and(eq(employeeGroups.companyId, companyId), eq(employeeGroups.active, true)));
        const empGroupMap = new Map<number, string>();
        for (const row of groupMemberships) {
          if (!empGroupMap.has(row.employeeId)) empGroupMap.set(row.employeeId, row.groupName);
        }

        // Helper: get or create a ledger account by code
        async function getOrCreateAccount(code: string, name: string) {
          const accs = await storage.getAllLedgerAccounts(companyIdNum);
          let acc = accs.find((a) => a.code === code);
          if (!acc) {
            const isBonus = code === "BONUS_EXPENSE" || code.startsWith("BONUS_EXP_");
            acc = await storage.createLedgerAccount({
              companyId: companyIdNum,
              code,
              name,
              accountType: isBonus ? "Indirect Expense" : "Expense",
              openingBalance: "0",
              active: true,
            });
          }
          return acc;
        }

        // ── 1. Worker payroll runs (SAL-{runId}-*) ───────────────────────────────
        const allAccounts = await storage.getAllLedgerAccounts(companyId);
        const oldSalaryIds = new Set(
          allAccounts.filter((a) => a.code === "SALARY_EXPENSE" || a.code.startsWith("WORKER_PAY_")).map((a) => a.id)
        );

        const paidRuns = await db
          .select()
          .from(erpPayrollRuns)
          .where(and(eq(erpPayrollRuns.companyId, companyId), eq(erpPayrollRuns.status, "PAID")));

        let migrated = 0;
        let alreadyCorrect = 0;
        let noGroups = 0;
        let noVoucher = 0;

        for (const run of paidRuns) {
          const salVouchers = await pool.query(
            `SELECT * FROM vouchers WHERE company_id = $1 AND voucher_number LIKE $2 AND deleted_at IS NULL`,
            [companyId, `SAL-${run.id}-%`]
          );
          if (salVouchers.rows.length === 0) {
            noVoucher++;
            continue;
          }
          const oldVoucher = salVouchers.rows[0];

          const debitRes = await pool.query(
            `SELECT * FROM voucher_entries WHERE voucher_id = $1 AND debit_amount::numeric > 0`,
            [oldVoucher.id]
          );
          const hasOldDebit = debitRes.rows.some((e) => oldSalaryIds.has(e.ledger_account_id));
          if (!hasOldDebit) {
            alreadyCorrect++;
            continue;
          }

          const runItems = await db.select().from(erpPayrollRunItems).where(eq(erpPayrollRunItems.runId, run.id));
          const totalAmount = runItems.reduce((s, i) => s + parseFloat(i.netPay), 0);
          const itemsByGroup = new Map<string, number>();
          for (const item of runItems) {
            const stored = (item.groupName || "").trim();
            const grp = stored || (item.employeeId ? empGroupMap.get(item.employeeId) || "__default__" : "__default__");
            itemsByGroup.set(grp, (itemsByGroup.get(grp) || 0) + parseFloat(item.netPay));
          }
          const hasNamedGroups = [...itemsByGroup.keys()].some((k) => k !== "__default__");
          if (!hasNamedGroups) {
            noGroups++;
            continue;
          }

          await db.update(vouchers).set({ deletedAt: new Date() }).where(eq(vouchers.id, oldVoucher.id));
          const newVoucherNumber = `SAL-${run.id}-${Date.now()}`;
          const [newVoucher] = await db
            .insert(vouchers)
            .values({
              companyId,
              voucherNumber: newVoucherNumber,
              voucherType: "Payment",
              voucherDate: run.date,
              description: run.notes || `Payroll run #${run.id}`,
              totalAmount: totalAmount.toFixed(2),
            })
            .returning();

          for (const [grp, grpTotal] of itemsByGroup) {
            const isDefault = grp === "__default__";
            const code = isDefault
              ? "SALARY_EXPENSE"
              : `SAL_EXP_${grp
                  .toUpperCase()
                  .replace(/[^A-Z0-9]/g, "_")
                  .substring(0, 25)}`;
            const name = isDefault ? "Salary Expense" : `Salary Expense - ${grp}`;
            const acc = await getOrCreateAccount(code, name);
            await db.insert(voucherEntries).values({
              voucherId: newVoucher.id,
              ledgerAccountId: acc.id,
              debitAmount: grpTotal.toFixed(2),
              creditAmount: "0",
              narration: isDefault
                ? `Salary expense — payroll run #${run.id}`
                : `Salary expense - ${grp} — run #${run.id}`,
            });
          }
          if (run.paymentAccountId) {
            await db.insert(voucherEntries).values({
              voucherId: newVoucher.id,
              ledgerAccountId: run.paymentAccountId,
              debitAmount: "0",
              creditAmount: totalAmount.toFixed(2),
              narration: `Cash paid — payroll run #${run.id}`,
            });
          }
          migrated++;
        }

        // ── 2. Salary deposit vouchers (SAL-DEP-*) ───────────────────────────────
        // Old codes: PAYROLL_DEPOSIT_EXPENSE (very old) or a single SALARY_EXPENSE (no per-group split)
        const freshAccs2 = await storage.getAllLedgerAccounts(companyId);
        const oldDepIds = new Set(
          freshAccs2.filter((a) => a.code === "PAYROLL_DEPOSIT_EXPENSE" || a.code === "SALARY_EXPENSE").map((a) => a.id)
        );
        const accCodeById = new Map(freshAccs2.map((a) => [a.id, a.code]));

        const depVouchersRes = await pool.query(
          `SELECT * FROM vouchers WHERE company_id = $1 AND voucher_number LIKE 'SAL-DEP-%' AND deleted_at IS NULL ORDER BY id`,
          [companyId]
        );

        let depositsMigrated = 0;
        let depositsAlreadyCorrect = 0;

        for (const dv of depVouchersRes.rows) {
          const debitRes = await pool.query(
            `SELECT * FROM voucher_entries WHERE voucher_id = $1 AND debit_amount::numeric > 0`,
            [dv.id]
          );
          const creditRes = await pool.query(
            `SELECT * FROM voucher_entries WHERE voucher_id = $1 AND credit_amount::numeric > 0`,
            [dv.id]
          );

          const hasOldDebit = debitRes.rows.some((e) => oldDepIds.has(e.ledger_account_id));
          if (!hasOldDebit) {
            depositsAlreadyCorrect++;
            continue;
          }

          // Determine if any old debit is truly wrong (PAYROLL_DEPOSIT_EXPENSE, or SALARY_EXPENSE without per-group)
          const hasPayrollDepExpense = debitRes.rows.some(
            (e: { ledger_account_id: number }) => accCodeById.get(e.ledger_account_id) === "PAYROLL_DEPOSIT_EXPENSE"
          );

          // Group employees from credit entries to determine new per-group debits
          const byGroup = new Map<string, number>();
          for (const entry of creditRes.rows) {
            const empId = entry.employee_id ? parseInt(entry.employee_id) : null;
            const grp = empId ? empGroupMap.get(empId) || "__default__" : "__default__";
            byGroup.set(grp, (byGroup.get(grp) || 0) + parseFloat(entry.credit_amount));
          }

          const hasNamedDepGroups = [...byGroup.keys()].some((k) => k !== "__default__");

          // Skip if already SALARY_EXPENSE (not PAYROLL_DEPOSIT_EXPENSE) and no named groups
          if (!hasPayrollDepExpense && !hasNamedDepGroups) {
            depositsAlreadyCorrect++;
            continue;
          }

          // Delete old debit entries that use old-style accounts
          for (const de of debitRes.rows) {
            if (oldDepIds.has(de.ledger_account_id)) {
              await pool.query(`DELETE FROM voucher_entries WHERE id = $1`, [de.id]);
            }
          }

          // Insert new per-group debit entries
          for (const [grp, grpTotal] of byGroup) {
            const isDefault = grp === "__default__";
            const code = isDefault
              ? "SALARY_EXPENSE"
              : `SAL_EXP_${grp
                  .toUpperCase()
                  .replace(/[^A-Z0-9]/g, "_")
                  .substring(0, 25)}`;
            const name = isDefault ? "Salary Expense" : `Salary Expense - ${grp}`;
            const acc = await getOrCreateAccount(code, name);
            await db.insert(voucherEntries).values({
              voucherId: dv.id,
              ledgerAccountId: acc.id,
              debitAmount: grpTotal.toFixed(2),
              creditAmount: "0",
              narration: isDefault
                ? `Salary deposit - ${dv.voucher_number}`
                : `Salary deposit - ${grp} - ${dv.voucher_number}`,
            });
          }
          depositsMigrated++;
        }

        // ── 3. Bonus vouchers (BONUS-*) ───────────────────────────────────────────
        // Handles two cases:
        //   A) Old code: SALARY_EXPENSE used for bonuses (pre-Phase 5)
        //   B) Generic BONUS_EXPENSE used (Phase 5) but not yet split per group
        const freshAccs3 = await storage.getAllLedgerAccounts(companyId);
        // IDs that need replacing: both the old SALARY_EXPENSE and the unsplit generic BONUS_EXPENSE
        const oldBonusIds = new Set(
          freshAccs3.filter((a) => a.code === "SALARY_EXPENSE" || a.code === "BONUS_EXPENSE").map((a) => a.id)
        );
        // IDs that are already per-group (BONUS_EXP_*) — vouchers with only these are already correct
        const perGroupBonusIds = new Set(freshAccs3.filter((a) => a.code.startsWith("BONUS_EXP_")).map((a) => a.id));

        const bonusVouchersRes = await pool.query(
          `SELECT * FROM vouchers WHERE company_id = $1 AND voucher_number LIKE 'BONUS-%' AND deleted_at IS NULL ORDER BY id`,
          [companyId]
        );

        let bonusesMigrated = 0;
        let bonusesAlreadyCorrect = 0;

        for (const bv of bonusVouchersRes.rows) {
          const debitRes = await pool.query(
            `SELECT * FROM voucher_entries WHERE voucher_id = $1 AND debit_amount::numeric > 0`,
            [bv.id]
          );
          const creditRes = await pool.query(
            `SELECT * FROM voucher_entries WHERE voucher_id = $1 AND credit_amount::numeric > 0`,
            [bv.id]
          );

          // Determine what kind of debit entries exist on this voucher
          const hasOldOrGenericDebit = debitRes.rows.some((e) => oldBonusIds.has(e.ledger_account_id));
          const hasPerGroupDebit = debitRes.rows.some((e) => perGroupBonusIds.has(e.ledger_account_id));
          const creditTotal = creditRes.rows.reduce(
            (s: number, e: { credit_amount: string }) => s + parseFloat(e.credit_amount),
            0
          );

          // Skip only when per-group debits exist AND no old/generic debit remains
          // (vouchers with NO debit entries at all must be processed — previous migration may have
          //  deleted the old entry but failed to insert the replacement)
          if (!hasOldOrGenericDebit && (hasPerGroupDebit || creditTotal <= 0)) {
            bonusesAlreadyCorrect++;
            continue;
          }

          // Group employees from credit entries by their current group membership
          const byGroup = new Map<string, number>();
          for (const entry of creditRes.rows) {
            const empId = entry.employee_id ? parseInt(entry.employee_id) : null;
            const grp = empId ? empGroupMap.get(empId) || "__default__" : "__default__";
            byGroup.set(grp, (byGroup.get(grp) || 0) + parseFloat(entry.credit_amount));
          }

          // If no groups derived from credits, fall back to debit total (or credit total if
          // debit entries were already deleted by a previous failed migration run)
          if (byGroup.size === 0) {
            const totalFromDebits = debitRes.rows
              .filter((e) => oldBonusIds.has(e.ledger_account_id))
              .reduce((s: number, e: { debit_amount: string }) => s + parseFloat(e.debit_amount), 0);
            const fallbackTotal = totalFromDebits > 0 ? totalFromDebits : creditTotal;
            if (fallbackTotal > 0) byGroup.set("__default__", fallbackTotal);
          }

          // Check if there are any named groups — if only __default__, still fix account code
          const _hasNamedGroups = [...byGroup.keys()].some((k) => k !== "__default__");

          // Delete old/generic debit entries (SALARY_EXPENSE or unsplit BONUS_EXPENSE)
          for (const de of debitRes.rows) {
            if (oldBonusIds.has(de.ledger_account_id)) {
              await pool.query(`DELETE FROM voucher_entries WHERE id = $1`, [de.id]);
            }
          }

          // Insert new per-group BONUS_EXP_* debit entries (or BONUS_EXPENSE if no groups)
          for (const [grp, grpTotal] of byGroup) {
            const isDefault = grp === "__default__";
            const code = isDefault
              ? "BONUS_EXPENSE"
              : `BONUS_EXP_${grp
                  .toUpperCase()
                  .replace(/[^A-Z0-9]/g, "_")
                  .substring(0, 25)}`;
            const name = isDefault ? "Bonus Expense" : `Bonus Expense - ${grp}`;
            const acc = await getOrCreateAccount(code, name);
            await db.insert(voucherEntries).values({
              voucherId: bv.id,
              ledgerAccountId: acc.id,
              debitAmount: grpTotal.toFixed(2),
              creditAmount: "0",
              narration: isDefault
                ? `Bonus expense - ${bv.voucher_number}`
                : `Bonus expense - ${grp} - ${bv.voucher_number}`,
            });
          }
          bonusesMigrated++;
        }

        res.json({
          migrated,
          alreadyCorrect,
          noGroups,
          noVoucher,
          total: paidRuns.length,
          depositsMigrated,
          depositsAlreadyCorrect,
          bonusesMigrated,
          bonusesAlreadyCorrect,
        });
      } catch (e: unknown) {
        res.status(500).json({ message: getErrorMessage(e) });
      }
    }
  );

  // ── End ERP Payroll Runs ──────────────────────────────────────────────────
}
