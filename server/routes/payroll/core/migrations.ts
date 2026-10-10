/**
 * payrollCoreRoutes: PayrollCoreMigration endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { sql, inArray } from "drizzle-orm";
import { ledgerAccounts, voucherEntries } from "@shared/schema";
import { findOrCreateLedger, getFactoryCompanyId, normUsd } from "./_helpers";

/** A PAYROLL-GEN voucher row this migration rewrites, joined to its DR entry. */
type PayrollGenVoucherRow = {
  id: number;
  voucher_date: string;
  description: string | null;
  entry_id?: number;
  debit_amount?: string;
};

/** Per-worker payroll amounts read while rebuilding a period's expense entries. */
type PayrollWorkerAmountsRow = {
  worker_id: number;
  base_salary: string | null;
  transport: string | null;
  bonuses: string | null;
  deductions: string | null;
  advances: string | null;
  net_salary: string | null;
  full_name: string | null;
};

const PAYROLL_MIGRATION_CONFIRMATION_REQUIRED = "Explicit confirmation is required to run this payroll migration";

export function registerPayrollCoreMigrationRoutes(app: Express) {
  // POST /api/factory/payroll/migrate-city-split and /migrate-salary-groups were retired
  // (owner decision, wave 18 B): they rewrote posted PAYROLL-GEN lines with floats,
  // hard-deleted accounts, wrote no audit and trusted the body's company.

  // POST /api/factory/payroll/migrate-worker-names
  // Migration: replaces city-based expense entries in PAYROLL-GEN-* and WBONUS-* vouchers with
  // per-worker named entries ("Salary Expense - Ahmad Hassan" / "Bonus Expense - Ahmad Hassan").
  // Safe to run multiple times (idempotent per voucher).
  app.post("/api/factory/payroll/migrate-worker-names", requireAuth, async (req: Request, res: Response) => {
    try {
      if (req.body?.confirm !== true) {
        return res.status(400).json({ message: PAYROLL_MIGRATION_CONFIRMATION_REQUIRED });
      }
      const currentRole = req.session.currentRole;
      if (!["Admin", "Owner", "Developer"].includes(currentRole ?? "")) {
        return res.status(403).json({ message: "Only Admin, Owner, or Developer can run this migration" });
      }
      // The active company only (wave 18 B): a body companyId naming another company is refused.
      const companyId = getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      if (req.body?.companyId != null && Number(req.body.companyId) !== Number(companyId)) {
        return res.status(403).json({ message: "The request company does not match the active company." });
      }

      // Find all PAYROLL-GEN vouchers for this company
      const genVouchers = await db.execute<PayrollGenVoucherRow>(sql`
        SELECT v.id, v.voucher_date, v.description
        FROM vouchers v
        WHERE v.company_id = ${companyId}
          AND v.voucher_number LIKE 'PAYROLL-GEN-%'
        ORDER BY v.voucher_date
      `);

      let vouchersUpdated = 0;

      for (const row of genVouchers.rows) {
        // Parse period dates from description: "Payroll expense: N workers (YYYY-MM-DD – YYYY-MM-DD)"
        const periodMatch = (row.description as string | null)?.match(
          /\((\d{4}-\d{2}-\d{2})\s*[–-]\s*(\d{4}-\d{2}-\d{2})\)/
        );
        const periodStart = row.voucher_date as string;
        const periodEnd = periodMatch ? periodMatch[2] : null;
        if (!periodEnd) continue;

        // Fetch payroll records + worker names for this period
        const payrollData = await db.execute<PayrollWorkerAmountsRow>(sql`
          SELECT fp.worker_id, fp.base_salary, fp.transport, fp.bonuses,
                 fp.deductions, fp.advances, fp.net_salary, fw.full_name
          FROM factory_payrolls fp
          JOIN factory_workers fw ON fw.id = fp.worker_id
          WHERE fp.company_id = ${companyId}
            AND fp.period_start = ${periodStart}
            AND fp.period_end = ${periodEnd}
        `);

        if (payrollData.rows.length === 0) continue;

        // Resolve per-worker ledger accounts (sequential to avoid nextCode collisions)
        // Ensure group headers exist so worker accounts nest under them in the chart of accounts
        const salGrp = await findOrCreateLedger(companyId, "Salary Expense - Workers", "Expense", { subType: "Group" });
        const bonGrp = await findOrCreateLedger(companyId, "Bonus Expense - Workers", "Expense", { subType: "Group" });
        // Stamp subType=Group on both headers in case they existed before the Group flag was introduced
        await db.execute(
          sql`UPDATE ledger_accounts SET sub_type='Group' WHERE id IN (${salGrp.id}, ${bonGrp.id}) AND (sub_type IS NULL OR sub_type <> 'Group')`
        );
        const workerAccMap = new Map<number, { salaryId: number; bonusId: number }>();
        for (const p of payrollData.rows) {
          if (workerAccMap.has(p.worker_id)) continue;
          const workerName = (p.full_name as string) || `Worker #${p.worker_id}`;
          const sa = await findOrCreateLedger(companyId, `Salary Expense - ${workerName}`, "Expense", {
            parentId: salGrp.id,
          });
          const ba = await findOrCreateLedger(companyId, `Bonus Expense - ${workerName}`, "Expense", {
            parentId: bonGrp.id,
          });
          // Re-parent in case the account already existed without parentId (pre-fix)
          await db.execute(
            sql`UPDATE ledger_accounts SET parent_id = ${salGrp.id} WHERE id = ${sa.id} AND (parent_id IS NULL OR parent_id <> ${salGrp.id})`
          );
          await db.execute(
            sql`UPDATE ledger_accounts SET parent_id = ${bonGrp.id} WHERE id = ${ba.id} AND (parent_id IS NULL OR parent_id <> ${bonGrp.id})`
          );
          workerAccMap.set(p.worker_id, { salaryId: sa.id, bonusId: ba.id });
        }

        await db.transaction(async (tx) => {
          // Delete existing DR (expense) entries for this voucher — CR entries (payable/advances) are preserved
          await tx.execute(sql`
            DELETE FROM voucher_entries
            WHERE voucher_id = ${row.id}
              AND CAST(debit_amount AS numeric) > 0
          `);

          // Insert new per-worker DR entries
          const newEntries = [];
          for (const p of payrollData.rows) {
            const workerName = (p.full_name as string) || `Worker #${p.worker_id}`;
            const accs = workerAccMap.get(p.worker_id)!;
            const salAmt =
              parseFloat(p.base_salary || "0") + parseFloat(p.transport || "0") - parseFloat(p.deductions || "0");
            const bonAmt = parseFloat(p.bonuses || "0");
            if (salAmt > 0) {
              newEntries.push({
                voucherId: row.id,
                ledgerAccountId: accs.salaryId,
                ...normUsd(salAmt.toFixed(2), "0"),
                narration: `Salary - ${workerName} (${periodStart} – ${periodEnd})`,
              });
            }
            if (bonAmt > 0) {
              newEntries.push({
                voucherId: row.id,
                ledgerAccountId: accs.bonusId,
                ...normUsd(bonAmt.toFixed(2), "0"),
                narration: `Bonus - ${workerName} (${periodStart} – ${periodEnd})`,
              });
            }
          }
          if (newEntries.length > 0) {
            await tx.insert(voucherEntries).values(newEntries);
          }
        });
        vouchersUpdated++;
      }

      // ── Step 2: retarget historical paid-bonus vouchers to worker-named accounts ──
      const paidBonusGroup = await findOrCreateLedger(companyId, "Bonus Expense - Workers", "Expense", {
        subType: "Group",
      });
      await db.execute(sql`
        UPDATE ledger_accounts SET sub_type = 'Group'
        WHERE id = ${paidBonusGroup.id} AND (sub_type IS NULL OR sub_type <> 'Group')
      `);

      const paidBonusVouchers = await db.execute(sql`
        SELECT wb.id AS bonus_id, wb.worker_id, fw.full_name, v.id AS voucher_id
        FROM worker_bonuses wb
        JOIN factory_workers fw
          ON fw.id = wb.worker_id
         AND fw.company_id = wb.company_id
        JOIN vouchers v
          ON v.company_id = wb.company_id
         AND v.voucher_number LIKE ('WBONUS-' || wb.id || '-%')
        WHERE wb.company_id = ${companyId}
          AND wb.status = 'paid'
        ORDER BY wb.id, v.id
      `);

      let bonusVouchersUpdated = 0;
      for (const row of paidBonusVouchers.rows as {
        bonus_id: number;
        worker_id: number;
        full_name: string | null;
        voucher_id: number;
      }[]) {
        const workerName = row.full_name?.trim() || `Worker #${row.worker_id}`;
        const bonusAcc = await findOrCreateLedger(companyId, `Bonus Expense - ${workerName}`, "Expense", {
          parentId: paidBonusGroup.id,
        });
        await db.execute(sql`
          UPDATE ledger_accounts SET parent_id = ${paidBonusGroup.id}
          WHERE id = ${bonusAcc.id} AND (parent_id IS NULL OR parent_id <> ${paidBonusGroup.id})
        `);
        const updateResult = await db.execute(sql`
          UPDATE voucher_entries
          SET ledger_account_id = ${bonusAcc.id}
          WHERE voucher_id = ${row.voucher_id}
            AND CAST(debit_amount AS numeric) > 0
        `);
        if ((updateResult.rowCount ?? 0) > 0) bonusVouchersUpdated++;
      }

      // ── Step 3: delete orphaned Salary/Bonus Expense accounts (no entries left) ──
      // These are the old city-based accounts created by migrate-city-split.
      // Now that all voucher entries point to per-worker accounts, city accounts are empty.
      const orphanedAccounts = await db.execute(sql`
        SELECT la.id
        FROM ledger_accounts la
        WHERE la.company_id = ${companyId}
          AND (la.name LIKE 'Salary Expense - %' OR la.name LIKE 'Bonus Expense - %')
          AND la.sub_type IS DISTINCT FROM 'Group'
          AND la.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM voucher_entries ve WHERE ve.ledger_account_id = la.id
          )
      `);
      let accountsDeleted = 0;
      const orphanRows = orphanedAccounts.rows;
      if (orphanRows.length > 0) {
        // Use inArray (drizzle) instead of raw ANY() to avoid parameterization issues
        const orphanIds = orphanRows.map((r) => r.id as number);
        await db.delete(ledgerAccounts).where(inArray(ledgerAccounts.id, orphanIds));
        accountsDeleted = orphanIds.length;
      }

      // ── Step 4: ensure group headers exist and re-parent all worker accounts ──
      const salaryGroup = await findOrCreateLedger(companyId, "Salary Expense - Workers", "Expense", {
        subType: "Group",
      });
      const bonusGroup = await findOrCreateLedger(companyId, "Bonus Expense - Workers", "Expense", {
        subType: "Group",
      });
      await db.execute(sql`
        UPDATE ledger_accounts SET sub_type = 'Group'
        WHERE id IN (${salaryGroup.id}, ${bonusGroup.id}) AND (sub_type IS NULL OR sub_type <> 'Group')
      `);
      const salReparent = await db.execute(sql`
        UPDATE ledger_accounts SET parent_id = ${salaryGroup.id}
        WHERE company_id = ${companyId} AND name LIKE 'Salary Expense - %'
          AND id <> ${salaryGroup.id} AND deleted_at IS NULL
      `);
      const bonReparent = await db.execute(sql`
        UPDATE ledger_accounts SET parent_id = ${bonusGroup.id}
        WHERE company_id = ${companyId} AND name LIKE 'Bonus Expense - %'
          AND id <> ${bonusGroup.id} AND deleted_at IS NULL
      `);

      res.json({
        message: "Payroll accounts fixed",
        vouchersUpdated,
        bonusVouchersUpdated,
        accountsDeleted,
        salaryAccountsReparented: salReparent.rowCount ?? 0,
        bonusAccountsReparented: bonReparent.rowCount ?? 0,
      });
    } catch (error: unknown) {
      logger.error("migrate-worker-names error:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
