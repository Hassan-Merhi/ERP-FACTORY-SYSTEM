/**
 * Shared payroll accounting helpers.
 * Used by factoryPayrollRoutes (delete/undo) and workerStatementRoutes (repair utility)
 * to keep PAYROLL-GEN-* vouchers in sync when payroll records are removed.
 */

import { db as globalDb, type DatabaseOrTransaction, type DbTransaction } from "../../db";
import { postErpVoucherTx, type ErpVoucherLine } from "../../services/accounting/erpVoucherPosting";
import { getErrorMessage } from "../../lib/httpHandlers";
import { eq, and, sql, ne, isNull } from "drizzle-orm";
import { ledgerAccounts, vouchers, factoryPayrolls, factoryWorkers } from "@shared/schema";
import { allocatePayrollAccountingAmounts, moneyFromCents } from "../../services/accounting/payrollAccountingAmounts";
import { retireVouchersTx } from "../../services/accounting/voucherRetirement";

/**
 * Find or create a ledger account by name for a company.
 * Uses the global db (not a transaction) to avoid race-condition issues with unique constraints.
 * Pass opts.parentId to set the parent group account id on creation.
 * Pass opts.subType (e.g. "Group") to mark the account as a group header.
 */
export async function findOrCreateLedger(
  companyId: number,
  name: string,
  accountType: string,
  opts?: { parentId?: number; subType?: string }
): Promise<{ id: number }> {
  const [existing] = await globalDb
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(
      and(eq(ledgerAccounts.companyId, companyId), eq(ledgerAccounts.name, name), isNull(ledgerAccounts.deletedAt))
    );
  if (existing) return existing;

  for (let attempt = 0; attempt < 5; attempt++) {
    const [maxCodeRow] = await globalDb
      .select({ maxCode: sql<number | null>`MAX(CAST(code AS INTEGER))` })
      .from(ledgerAccounts)
      .where(and(eq(ledgerAccounts.companyId, companyId), sql`code ~ '^\\d+$'`));
    const nextCode = String((maxCodeRow?.maxCode ?? 0) + 1 + attempt);
    try {
      const insertVals: typeof ledgerAccounts.$inferInsert = {
        companyId,
        code: nextCode,
        name,
        accountType,
        active: true,
        isHidden: false,
      };
      if (opts?.parentId) insertVals.parentId = opts.parentId;
      if (opts?.subType) insertVals.subType = opts.subType;

      const [created] = await globalDb.insert(ledgerAccounts).values(insertVals).returning({ id: ledgerAccounts.id });
      return created;
    } catch (err: unknown) {
      if ((err as { code?: string }).code === "23505" || getErrorMessage(err)?.includes("unique")) {
        const [nowFound] = await globalDb
          .select({ id: ledgerAccounts.id })
          .from(ledgerAccounts)
          .where(
            and(
              eq(ledgerAccounts.companyId, companyId),
              eq(ledgerAccounts.name, name),
              isNull(ledgerAccounts.deletedAt)
            )
          );
        if (nowFound) return nowFound;
        continue;
      }
      throw err;
    }
  }
  throw new Error(`Unable to create ledger account "${name}" after multiple attempts`);
}

/**
 * Rebuilds the PAYROLL-GEN-* expense voucher for a payroll period after one or more
 * payroll records have been removed.
 *
 * Steps:
 *  1. Delete all existing PAYROLL-GEN vouchers for company + period (inside tx).
 *  2. Query remaining payrolls for that period (excluding `excludePayrollId`).
 *  3. If any remain → recreate a correctly-sized expense voucher from stored amounts.
 *
 * Must be called BEFORE the payroll row being deleted is actually removed from the DB
 * (pass its id as `excludePayrollId`) so the remaining-payroll query excludes it.
 */
export async function rebuildPayrollGenVoucher(
  executor: DatabaseOrTransaction,
  companyId: number,
  periodStart: string,
  periodEnd: string,
  excludePayrollId?: number
): Promise<void> {
  // The retirement and the re-post commit together; a caller holding the
  // pool itself (not a transaction) gets one here.
  if (executor === globalDb) {
    return globalDb.transaction((tx) =>
      rebuildPayrollGenVoucherTx(tx, companyId, periodStart, periodEnd, excludePayrollId)
    );
  }
  return rebuildPayrollGenVoucherTx(executor as DbTransaction, companyId, periodStart, periodEnd, excludePayrollId);
}

async function rebuildPayrollGenVoucherTx(
  tx: DbTransaction,
  companyId: number,
  periodStart: string,
  periodEnd: string,
  excludePayrollId?: number
): Promise<void> {
  const existingGenVouchers = await tx
    .select({ id: vouchers.id })
    .from(vouchers)
    .where(
      and(
        eq(vouchers.companyId, companyId),
        sql`${vouchers.voucherNumber} LIKE 'PAYROLL-GEN-%'`,
        eq(vouchers.voucherDate, periodStart),
        sql`${vouchers.description} LIKE ${"%" + periodEnd + "%"}`
      )
    );

  if (existingGenVouchers.length > 0) {
    const vIds = existingGenVouchers.map((v) => v.id);
    // Wave 16 (A): retired (soft delete with lines, audited here), not hard-deleted.
    await retireVouchersTx(tx, {
      companyId,
      voucherIds: vIds,
      reason: "payroll-generation-rebuild",
    });
  }

  const remaining = await tx
    .select({
      workerId: factoryPayrolls.workerId,
      bonuses: factoryPayrolls.bonuses,
      advances: factoryPayrolls.advances,
      netSalary: factoryPayrolls.netSalary,
      fullName: factoryWorkers.fullName,
    })
    .from(factoryPayrolls)
    .leftJoin(factoryWorkers, eq(factoryWorkers.id, factoryPayrolls.workerId))
    .where(
      and(
        eq(factoryPayrolls.companyId, companyId),
        eq(factoryPayrolls.periodStart, periodStart),
        eq(factoryPayrolls.periodEnd, periodEnd),
        ...(excludePayrollId !== undefined ? [ne(factoryPayrolls.id, excludePayrollId)] : [])
      )
    );

  if (remaining.length === 0) return;

  let totalNetCents = 0;
  let totalAdvancesCents = 0;
  const workerRows: { workerId: number; workerName: string; salAmt: string; bonAmt: string }[] = [];

  for (const p of remaining) {
    const workerName = (p.fullName as string | null) || `Worker #${p.workerId}`;
    const accounting = allocatePayrollAccountingAmounts({
      netSalary: p.netSalary || "0",
      advances: p.advances || "0",
      bonus: p.bonuses || "0",
    });
    workerRows.push({
      workerId: p.workerId,
      workerName,
      salAmt: accounting.salaryExpense,
      bonAmt: accounting.bonusExpense,
    });
    totalNetCents += accounting.netCents;
    totalAdvancesCents += accounting.advanceCents;
  }

  const totalGrossCents = totalNetCents + totalAdvancesCents;
  if (totalGrossCents <= 0) return;

  const payableAcc = await findOrCreateLedger(companyId, "Payroll Payable", "Liability");
  const advancesAcc = await findOrCreateLedger(companyId, "Factory Worker Advances", "Asset");
  const salaryGroup = await findOrCreateLedger(companyId, "Salary Expense - Workers", "Expense", { subType: "Group" });
  const bonusGroup = await findOrCreateLedger(companyId, "Bonus Expense - Workers", "Expense", { subType: "Group" });

  await globalDb.execute(
    sql`UPDATE ledger_accounts SET sub_type='Group' WHERE id IN (${salaryGroup.id}, ${bonusGroup.id}) AND (sub_type IS NULL OR sub_type <> 'Group')`
  );

  const workerAccCache = new Map<number, { salaryId: number; bonusId: number }>();
  for (const { workerId, workerName } of workerRows) {
    if (workerAccCache.has(workerId)) continue;
    const sa = await findOrCreateLedger(companyId, `Salary Expense - ${workerName}`, "Expense", {
      parentId: salaryGroup.id,
    });
    const ba = await findOrCreateLedger(companyId, `Bonus Expense - ${workerName}`, "Expense", {
      parentId: bonusGroup.id,
    });
    await globalDb.execute(
      sql`UPDATE ledger_accounts SET parent_id = ${salaryGroup.id} WHERE id = ${sa.id} AND (parent_id IS NULL OR parent_id <> ${salaryGroup.id})`
    );
    await globalDb.execute(
      sql`UPDATE ledger_accounts SET parent_id = ${bonusGroup.id} WHERE id = ${ba.id} AND (parent_id IS NULL OR parent_id <> ${bonusGroup.id})`
    );
    workerAccCache.set(workerId, { salaryId: sa.id, bonusId: ba.id });
  }

  const count = remaining.length;
  const desc = `Payroll expense: ${count} worker${count !== 1 ? "s" : ""} (${periodStart} – ${periodEnd})`;
  const totalNet = moneyFromCents(totalNetCents);
  const totalAdvances = moneyFromCents(totalAdvancesCents);

  // Phase 22 (B): through the central engine; PAYROLL-GEN- kept with the
  // company and period as a deterministic suffix (numbers are unique across
  // companies; the old journal was retired above, which released its number
  // and posting identity).
  const journalLines: ErpVoucherLine[] = [];
  for (const { workerId, workerName, salAmt, bonAmt } of workerRows) {
    const accs = workerAccCache.get(workerId)!;
    journalLines.push({
      ledgerAccountId: accs.salaryId,
      debit: salAmt,
      narration: `Salary - ${workerName} (${periodStart} – ${periodEnd})`,
    });
    journalLines.push({
      ledgerAccountId: accs.bonusId,
      debit: bonAmt,
      narration: `Bonus - ${workerName} (${periodStart} – ${periodEnd})`,
    });
  }
  journalLines.push({ ledgerAccountId: payableAcc.id, credit: totalNet, narration: desc });
  journalLines.push({
    ledgerAccountId: advancesAcc.id,
    credit: totalAdvances,
    narration: `Advance deductions settled - ${count} worker${count !== 1 ? "s" : ""} (${periodStart} – ${periodEnd})`,
  });

  await postErpVoucherTx(tx, {
    companyId,
    voucherNumber: `PAYROLL-GEN-${companyId}-${periodStart}-${periodEnd}`,
    voucherType: "Journal",
    voucherDate: periodStart,
    description: desc,
    sourceModule: "FACTORY",
    lines: journalLines,
    source: { type: "payroll-generation", id: `${companyId}:${periodStart}:${periodEnd}`, revision: "rebuild" },
  });
}
