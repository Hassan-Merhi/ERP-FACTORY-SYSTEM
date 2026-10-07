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
import { ledgerAccounts, vouchers, voucherEntries } from "@shared/schema";
import { findOrCreateLedger, getFactoryCompanyId, normUsd } from "./_helpers";

/** A PAYROLL-GEN voucher row this migration rewrites, joined to its DR entry. */
type PayrollGenVoucherRow = {
  id: number;
  voucher_date: string;
  description: string | null;
  entry_id?: number;
  debit_amount?: string;
};

/** Payroll amounts aggregated by worker city. */
type PayrollCityAmountsRow = {
  base_salary: string | null;
  bonuses: string | null;
  transport: string | null;
  deductions: string | null;
  city: string | null;
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

/** A paid worker bonus awaiting an accounting voucher. */
type PaidBonusRow = {
  id: number;
  worker_id: number;
  bonus_date: string;
  amount: string | null;
  notes: string | null;
  cash_account_id: number | null;
  paid_date: string | null;
  city: string | null;
  full_name: string;
};

const PAYROLL_MIGRATION_CONFIRMATION_REQUIRED = "Explicit confirmation is required to run this payroll migration";

function migrationCompletePayload(vouchersUpdated: number, bonusEntriesCreated: number) {
  return { message: "Migration complete", vouchersUpdated, bonusEntriesCreated };
}

export function registerPayrollCoreMigrationRoutes(app: Express) {
  // POST /api/factory/payroll/migrate-city-split
  // One-time migration: splits historical "Factory Worker Payroll" expense entries by city,
  // and creates missing accounting entries for paid worker bonuses.
  app.post("/api/factory/payroll/migrate-city-split", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.body.companyId || getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      // --- Step 1: Resolve city-specific accounts ---
      const cities = await db.execute(sql`
        SELECT DISTINCT TRIM(city) as city
        FROM factory_workers
        WHERE company_id = ${companyId} AND city IS NOT NULL AND TRIM(city) <> ''
      `);
      const cityRows = cities.rows as { city: string }[];

      const migrationWork = await db.execute(sql`
        SELECT (
          EXISTS (
            SELECT 1 FROM vouchers v
            WHERE v.company_id = ${companyId}
              AND v.voucher_number LIKE 'PAYROLL-GEN-%'
          )
          OR EXISTS (
            SELECT 1 FROM worker_bonuses wb
            WHERE wb.company_id = ${companyId}
              AND wb.status = 'paid'
              AND wb.cash_account_id IS NOT NULL
          )
        ) AS has_work
      `);
      const migrationWorkRows = migrationWork.rows as { has_work: boolean }[];
      if (cityRows.length === 0 && !migrationWorkRows[0]?.has_work) {
        return res.json(migrationCompletePayload(0, 0));
      }

      const salaryAccByCity = new Map<string, number>();
      const bonusAccByCity = new Map<string, number>();
      for (const { city } of cityRows) {
        const capCity = city.charAt(0).toUpperCase() + city.slice(1).toLowerCase();
        const [sa, ba] = await Promise.all([
          findOrCreateLedger(companyId, `Salary Expense - ${capCity}`, "Expense"),
          findOrCreateLedger(companyId, `Bonus Expense - ${capCity}`, "Expense"),
        ]);
        salaryAccByCity.set(city.trim(), sa.id);
        bonusAccByCity.set(city.trim(), ba.id);
      }
      const legacyAcc = await findOrCreateLedger(companyId, "Factory Worker Payroll", "Expense");

      // --- Step 2: Migrate PAYROLL-GEN-* vouchers ---
      const genVouchers = await db.execute<PayrollGenVoucherRow>(sql`
        SELECT v.id, v.voucher_date, v.description, ve.id as entry_id, ve.debit_amount
        FROM vouchers v
        JOIN voucher_entries ve ON ve.voucher_id = v.id
        WHERE v.company_id = ${companyId}
          AND v.voucher_number LIKE 'PAYROLL-GEN-%'
          AND ve.ledger_account_id = ${legacyAcc.id}
          AND CAST(ve.debit_amount AS numeric) > 0
      `);

      let vouchersUpdated = 0;
      for (const row of genVouchers.rows) {
        const _voucherDate = row.voucher_date as string;
        // Parse period end from description: "Payroll expense: N workers (YYYY-MM-DD – YYYY-MM-DD)"
        const periodMatch = (row.description as string).match(/\((\d{4}-\d{2}-\d{2})\s*[–-]\s*(\d{4}-\d{2}-\d{2})\)/);
        if (!periodMatch) continue;
        const periodStart = periodMatch[1];
        const periodEnd = periodMatch[2];

        // Find factory_payrolls for this period
        const payrollData = await db.execute<PayrollCityAmountsRow>(sql`
          SELECT fp.base_salary, fp.bonuses, fp.transport, fp.deductions,
                 fw.city
          FROM factory_payrolls fp
          JOIN factory_workers fw ON fw.id = fp.worker_id
          WHERE fp.company_id = ${companyId}
            AND fp.period_start = ${periodStart}
            AND fp.period_end = ${periodEnd}
        `);

        if (payrollData.rows.length === 0) continue;

        // Aggregate by city
        const salByCity = new Map<string, number>();
        const bonByCity = new Map<string, number>();
        for (const pr of payrollData.rows) {
          const city = (pr.city as string | null)?.trim() || "";
          const sal =
            parseFloat(pr.base_salary || "0") + parseFloat(pr.transport || "0") - parseFloat(pr.deductions || "0");
          const bon = parseFloat(pr.bonuses || "0");
          salByCity.set(city, (salByCity.get(city) || 0) + sal);
          bonByCity.set(city, (bonByCity.get(city) || 0) + bon);
        }

        await db.transaction(async (tx) => {
          // Delete the old single-city debit entry
          await tx.execute(sql`DELETE FROM voucher_entries WHERE id = ${row.entry_id}`);

          // Insert new split entries
          const newEntries = [];
          const allCities = new Set([...salByCity.keys(), ...bonByCity.keys()]);
          for (const city of allCities) {
            const salAmt = salByCity.get(city) || 0;
            const bonAmt = bonByCity.get(city) || 0;
            if (city) {
              const capCity = city.charAt(0).toUpperCase() + city.slice(1).toLowerCase();
              if (salAmt > 0) {
                const salAccId = salaryAccByCity.get(city) ?? legacyAcc.id;
                newEntries.push({
                  voucherId: row.id,
                  ledgerAccountId: salAccId,
                  ...normUsd(salAmt.toFixed(2), "0"),
                  narration: `Salary expense - ${capCity} (${periodStart} – ${periodEnd})`,
                });
              }
              if (bonAmt > 0) {
                const bonAccId = bonusAccByCity.get(city) ?? legacyAcc.id;
                newEntries.push({
                  voucherId: row.id,
                  ledgerAccountId: bonAccId,
                  ...normUsd(bonAmt.toFixed(2), "0"),
                  narration: `Bonus expense - ${capCity} (${periodStart} – ${periodEnd})`,
                });
              }
            } else {
              const total = salAmt + bonAmt;
              if (total > 0) {
                newEntries.push({
                  voucherId: row.id,
                  ledgerAccountId: legacyAcc.id,
                  ...normUsd(total.toFixed(2), "0"),
                  narration: `Payroll expense (no city) (${periodStart} – ${periodEnd})`,
                });
              }
            }
          }
          if (newEntries.length > 0) {
            await tx.insert(voucherEntries).values(newEntries);
          }
        });
        vouchersUpdated++;
      }

      // --- Step 3: Create missing accounting for paid worker bonuses ---
      const paidBonuses = await db.execute<PaidBonusRow>(sql`
        SELECT wb.id, wb.worker_id, wb.bonus_date, wb.amount, wb.notes,
               wb.cash_account_id, wb.paid_date,
               fw.city, fw.full_name
        FROM worker_bonuses wb
        JOIN factory_workers fw ON fw.id = wb.worker_id
        WHERE wb.company_id = ${companyId}
          AND wb.status = 'paid'
          AND wb.cash_account_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM vouchers v
            WHERE v.company_id = ${companyId}
              AND v.voucher_number LIKE 'WBONUS-' || wb.id || '-%'
          )
      `);

      let bonusesRecorded = 0;
      const bonusWorkerGroup = await findOrCreateLedger(companyId, "Bonus Expense - Workers", "Expense", {
        subType: "Group",
      });
      await db.execute(sql`
        UPDATE ledger_accounts SET sub_type = 'Group'
        WHERE id = ${bonusWorkerGroup.id} AND (sub_type IS NULL OR sub_type <> 'Group')
      `);

      for (const wb of paidBonuses.rows) {
        const amt = parseFloat(wb.amount || "0");
        if (amt <= 0) continue;
        const workerName = (wb.full_name as string | null)?.trim() || `Worker #${wb.worker_id}`;
        const expAcc = await findOrCreateLedger(companyId, `Bonus Expense - ${workerName}`, "Expense", {
          parentId: bonusWorkerGroup.id,
        });
        await db.execute(sql`
          UPDATE ledger_accounts SET parent_id = ${bonusWorkerGroup.id}
          WHERE id = ${expAcc.id} AND (parent_id IS NULL OR parent_id <> ${bonusWorkerGroup.id})
        `);
        const paidDate = wb.paid_date || wb.bonus_date;
        const narration = wb.notes || `Bonus for ${workerName}`;

        await db.transaction(async (tx) => {
          const [bVoucher] = await tx
            .insert(vouchers)
            .values({
              companyId,
              voucherNumber: `WBONUS-${wb.id}-${Date.now()}`,
              voucherType: "Journal",
              voucherDate: paidDate,
              description: narration,
              totalAmount: amt.toFixed(2),
              currency: "USD",
              sourceModule: "FACTORY",
            })
            .returning();

          await tx.insert(voucherEntries).values([
            {
              voucherId: bVoucher.id,
              ledgerAccountId: expAcc.id,
              ...normUsd(amt.toFixed(2), "0"),
              narration: `Bonus - ${workerName}: ${narration}`,
            },
            {
              voucherId: bVoucher.id,
              ledgerAccountId: Number(wb.cash_account_id),
              ...normUsd("0", amt.toFixed(2)),
              narration,
            },
          ]);
        });
        bonusesRecorded++;
      }

      res.json(migrationCompletePayload(vouchersUpdated, bonusesRecorded));
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

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
      const companyId = req.body.companyId || getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

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

  // POST /api/factory/payroll/migrate-salary-groups
  // Creates "Salary Expense - Workers" and "Bonus Expense - Workers" group header accounts,
  // then re-parents every matching individual worker account under them so the chart of accounts
  // shows an expandable group row instead of a flat list.  Safe to run multiple times.
  app.post("/api/factory/payroll/migrate-salary-groups", requireAuth, async (req: Request, res: Response) => {
    try {
      if (req.body?.confirm !== true) {
        return res.status(400).json({ message: PAYROLL_MIGRATION_CONFIRMATION_REQUIRED });
      }
      const currentRole = req.session.currentRole;
      if (!["Admin", "Owner", "Developer"].includes(currentRole ?? "")) {
        return res.status(403).json({ message: "Only Admin, Owner, or Developer can run this migration" });
      }
      const companyId = req.body.companyId || getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      // 1. Find or create the two group header accounts
      const salaryGroup = await findOrCreateLedger(companyId, "Salary Expense - Workers", "Expense", {
        subType: "Group",
      });
      const bonusGroup = await findOrCreateLedger(companyId, "Bonus Expense - Workers", "Expense", {
        subType: "Group",
      });

      // 2. Ensure sub_type = 'Group' on both (in case they already existed without it)
      await db.execute(sql`
        UPDATE ledger_accounts
        SET sub_type = 'Group'
        WHERE id IN (${salaryGroup.id}, ${bonusGroup.id})
          AND (sub_type IS NULL OR sub_type <> 'Group')
      `);

      // 3. Re-parent all "Salary Expense - *" accounts under salaryGroup
      const salRes = await db.execute(sql`
        UPDATE ledger_accounts
        SET parent_id = ${salaryGroup.id}
        WHERE company_id = ${companyId}
          AND name LIKE 'Salary Expense - %'
          AND id <> ${salaryGroup.id}
          AND deleted_at IS NULL
      `);

      // 4. Re-parent all "Bonus Expense - *" accounts under bonusGroup
      const bonRes = await db.execute(sql`
        UPDATE ledger_accounts
        SET parent_id = ${bonusGroup.id}
        WHERE company_id = ${companyId}
          AND name LIKE 'Bonus Expense - %'
          AND id <> ${bonusGroup.id}
          AND deleted_at IS NULL
      `);

      res.json({
        message: "Salary groups migration complete",
        salaryGroupId: salaryGroup.id,
        bonusGroupId: bonusGroup.id,
        salaryAccountsReparented: salRes.rowCount ?? 0,
        bonusAccountsReparented: bonRes.rowCount ?? 0,
      });
    } catch (error: unknown) {
      logger.error("migrate-salary-groups error:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
