import {
  deleteInfrastructurePostingIdentityForVoucherTx,
  infrastructurePostingIdentity,
  insertInfrastructureVoucherTx,
} from "../../services/accounting/infrastructureVoucherIdentity";
/**
 * Shared payroll accounting helpers.
 * Used by factoryPayrollRoutes (delete/undo) and workerStatementRoutes (repair utility)
 * to keep PAYROLL-GEN-* vouchers in sync when payroll records are removed.
 */

import { db as globalDb, type DatabaseOrTransaction } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { eq, and, sql, inArray, ne, isNull } from "drizzle-orm";
import { ledgerAccounts, vouchers, voucherEntries, factoryPayrolls, factoryWorkers } from "@shared/schema";
import { normalizeVoucherEntryAmounts } from "../../services/accounting/currencyAmounts";
import {
  allocatePayrollAccountingAmounts,
  moneyFromCents,
} from "../../services/accounting/payrollAccountingAmounts";

/** Normalize a USD voucher entry (IDENTITY convention). */
function normUsd(debit: string | number, credit: string | number) {
  const norm = normalizeVoucherEntryAmounts({
    transactionCurrency: "USD",
    baseCurrency: "USD",
    transactionDebitAmount: String(debit),
    transactionCreditAmount: String(credit),
    historicalRate: "1",
  });
  return {
    transactionCurrency: norm.transactionCurrency,
    transactionDebitAmount: norm.transactionDebitAmount,
    transactionCreditAmount: norm.transactionCreditAmount,
    baseDebitAmount: norm.baseDebitAmount,
    baseCreditAmount: norm.baseCreditAmount,
    historicalExchangeRate: norm.historicalExchangeRate,
    rateConvention: norm.rateConvention,
    debitAmount: norm.debitAmount,
    creditAmount: norm.creditAmount,
  };
}

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
  tx: DatabaseOrTransaction,
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
    for (const voucherId of vIds) {
      await deleteInfrastructurePostingIdentityForVoucherTx(tx, voucherId);
    }
    await tx.delete(voucherEntries).where(inArray(voucherEntries.voucherId, vIds));
    await tx.delete(vouchers).where(inArray(vouchers.id, vIds));
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

  const { voucher: genVoucher } = await insertInfrastructureVoucherTx(
    tx,
    {
      companyId,
      voucherNumber: `PAYROLL-GEN-${Date.now()}`,
      voucherType: "Journal",
      voucherDate: periodStart,
      description: desc,
      totalAmount: moneyFromCents(totalGrossCents),
      currency: "USD",
      sourceModule: "FACTORY",
    },
    infrastructurePostingIdentity("payroll-generation", `${companyId}:${periodStart}:${periodEnd}`, "rebuild"),
    { workerRows, totalNet, totalAdvances }
  );

  const journalEntries = [];

  for (const { workerId, workerName, salAmt, bonAmt } of workerRows) {
    const accs = workerAccCache.get(workerId)!;
    if (Number(salAmt) > 0) {
      journalEntries.push({
        voucherId: genVoucher.id,
        ledgerAccountId: accs.salaryId,
        ...normUsd(salAmt, "0"),
        narration: `Salary - ${workerName} (${periodStart} – ${periodEnd})`,
      });
    }
    if (Number(bonAmt) > 0) {
      journalEntries.push({
        voucherId: genVoucher.id,
        ledgerAccountId: accs.bonusId,
        ...normUsd(bonAmt, "0"),
        narration: `Bonus - ${workerName} (${periodStart} – ${periodEnd})`,
      });
    }
  }

  if (totalNetCents > 0) {
    journalEntries.push({
      voucherId: genVoucher.id,
      ledgerAccountId: payableAcc.id,
      ...normUsd("0", totalNet),
      narration: desc,
    });
  }

  if (totalAdvancesCents > 0) {
    journalEntries.push({
      voucherId: genVoucher.id,
      ledgerAccountId: advancesAcc.id,
      ...normUsd("0", totalAdvances),
      narration: `Advance deductions settled - ${count} worker${count !== 1 ? "s" : ""} (${periodStart} – ${periodEnd})`,
    });
  }

  if (journalEntries.length > 0) {
    await tx.insert(voucherEntries).values(journalEntries);
  }
}
