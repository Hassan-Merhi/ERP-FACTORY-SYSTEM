/**
 * Shared state and helpers for the payrollCoreRoutes routes.
 *
 * Extracted verbatim from the former single-file payrollCoreRoutes.ts.
 */
import { getErrorMessage } from "../../../lib/httpHandlers";
import { db } from "../../../db";
import { eq, and, sql, isNull } from "drizzle-orm";
import multer from "multer";
import path from "path";
import fs from "fs";
import { factoryDaybookEntries, factoryWorkerAdvances, ledgerAccounts } from "@shared/schema";
import { normalizeVoucherEntryAmounts } from "../../../services/accounting/currencyAmounts";
import type { AttendanceStatusRow } from "../../../services/payroll/factoryPayrollGenerationPolicy";

/** Normalize a USD voucher entry (IDENTITY convention). Returns dual-currency fields spread-ready. */
export function normUsd(debit: string | number, credit: string | number) {
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

/** Prefer the factory-pinned company ID so cross-tab ERP company switches don't corrupt factory writes. */
export function getFactoryCompanyId(req: import("express").Request): number | undefined {
  return req.session.factoryCompanyId || req.session.currentCompanyId;
}

/** Write a single daybook entry (factory audit log). */
export async function writeDaybookEntry(
  dbOrTx: typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0],
  opts: {
    companyId: number;
    txDate: string;
    txType: string;
    referenceId?: number;
    referenceTable?: string;
    description: string;
    metaJson?: string;
    currencyCode?: string;
    amountCurrency?: number;
    fxRateToUsd?: number;
    amountUsd?: number;
    createdBy?: string | null;
  }
) {
  const currency = opts.currencyCode || "USD";
  const fxRate = opts.fxRateToUsd || 1;
  const amtCurrency = opts.amountCurrency || 0;
  const amtUsd =
    opts.amountUsd !== undefined ? opts.amountUsd : currency === "USD" ? amtCurrency : amtCurrency * fxRate;
  await dbOrTx.insert(factoryDaybookEntries).values({
    companyId: opts.companyId,
    txDate: opts.txDate,
    txType: opts.txType,
    referenceId: opts.referenceId || null,
    referenceTable: opts.referenceTable || null,
    description: opts.description,
    metaJson: opts.metaJson || null,
    currencyCode: currency,
    amountCurrency: String(amtCurrency),
    fxRateToUsd: String(fxRate),
    amountUsd: String(amtUsd),
    createdBy: opts.createdBy || null,
  });
}

/** Find or create a ledger account by name for a company. Returns the account row.
 *  Skips soft-deleted accounts and handles race-condition unique-constraint failures.
 *  If a requested child name collides with its parent account, use a detail suffix
 *  rather than creating a self-parent hierarchy cycle. */
export async function findOrCreateLedger(
  companyId: number,
  name: string,
  accountType: string,
  opts?: { parentId?: number; subType?: string }
): Promise<{ id: number }> {
  let accountName = name;
  let [existing] = await db
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.companyId, companyId),
        eq(ledgerAccounts.name, accountName),
        isNull(ledgerAccounts.deletedAt)
      )
    );

  if (existing && opts?.parentId && existing.id === opts.parentId) {
    accountName = `${name} (Detail)`;
    [existing] = await db
      .select({ id: ledgerAccounts.id })
      .from(ledgerAccounts)
      .where(
        and(
          eq(ledgerAccounts.companyId, companyId),
          eq(ledgerAccounts.name, accountName),
          isNull(ledgerAccounts.deletedAt)
        )
      );
  }
  if (existing) return existing;

  for (let attempt = 0; attempt < 5; attempt++) {
    const [maxCodeRow] = await db
      .select({ maxCode: sql<number | null>`MAX(CAST(code AS INTEGER))` })
      .from(ledgerAccounts)
      .where(and(eq(ledgerAccounts.companyId, companyId), sql`code ~ '^\\d+$'`));
    const nextCode = String((maxCodeRow?.maxCode ?? 0) + 1 + attempt);
    try {
      const insertVals: any = {
        companyId,
        code: nextCode,
        name: accountName,
        accountType,
        active: true,
        isHidden: false,
      };
      if (opts?.parentId) insertVals.parentId = opts.parentId;
      if (opts?.subType) insertVals.subType = opts.subType;
      const [created] = await db.insert(ledgerAccounts).values(insertVals).returning({ id: ledgerAccounts.id });
      return created;
    } catch (err: unknown) {
      if ((err as { code?: string }).code === "23505" || getErrorMessage(err)?.includes("unique")) {
        const [nowFound] = await db
          .select({ id: ledgerAccounts.id })
          .from(ledgerAccounts)
          .where(
            and(
              eq(ledgerAccounts.companyId, companyId),
              eq(ledgerAccounts.name, accountName),
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

export const workerUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(process.cwd(), "uploads", "workers");
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
    },
  }),
});

export function computeMonthlyPay(salary: number, startStr: string, endStr: string): number {
  const start = new Date(startStr + "T00:00:00");
  const end = new Date(endStr + "T00:00:00");
  let total = 0;
  let cur = new Date(start.getFullYear(), start.getMonth(), 1);
  while (cur <= end) {
    const year = cur.getFullYear();
    const month = cur.getMonth();
    const monthLastDay = new Date(year, month + 1, 0);
    const daysInThisMonth = monthLastDay.getDate();
    const segStart = new Date(Math.max(cur.getTime(), start.getTime()));
    const segEnd = new Date(Math.min(monthLastDay.getTime(), end.getTime()));
    const daysInSeg = Math.floor((segEnd.getTime() - segStart.getTime()) / (1000 * 60 * 60 * 24)) + 1;
    total += salary * (daysInSeg / daysInThisMonth);
    cur = new Date(year, month + 1, 1);
  }
  return total;
}

// Helper: Compute monthly pay from actual attendance records.
// Monthly payroll uses attendance-based calculation (Present/Late = 1 day, Half Day = 0.5 day)
// rather than calendar-day proration to match actual work performed.
export function computeMonthlyPayFromAttendance(
  baseSalary: number,
  periodStart: string,
  attendanceRows: readonly AttendanceStatusRow[]
): number {
  const daysInMonth = (dateStr: string) => {
    const d = new Date(dateStr);
    return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  };

  // Count actual days worked: Present/Late = 1 full day, Half Day = 0.5
  let attendedDays = 0;
  for (const row of attendanceRows) {
    const s = row.status || "Absent";
    if (s === "Present" || s === "Late") attendedDays += 1;
    else if (s === "Half Day") attendedDays += 0.5;
  }

  // Daily rate: salary / days in the month of periodStart
  const daysInStartMonth = daysInMonth(periodStart);
  const dailyRate = baseSalary / daysInStartMonth;
  return attendedDays * dailyRate;
}

/**
 * Reduce a worker's outstanding advances by the amount deducted on a payroll.
 *
 * Declared at module scope so the handlers that call it can live in separate
 * modules; it previously relied on hoisting inside the register function.
 */
export async function settleAdvancesForPayroll(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  companyId: number,
  workerId: number,
  advanceAmount: number
) {
  if (advanceAmount <= 0) return;
  const outstanding = await tx
    .select()
    .from(factoryWorkerAdvances)
    .where(
      and(
        eq(factoryWorkerAdvances.companyId, companyId),
        eq(factoryWorkerAdvances.workerId, workerId),
        eq(factoryWorkerAdvances.fullyPaid, false),
        eq(factoryWorkerAdvances.repaymentType, "salary_deduction")
      )
    )
    .orderBy(factoryWorkerAdvances.advanceDate);
  let remaining = advanceAmount;
  for (const adv of outstanding) {
    if (remaining <= 0) break;
    const bal = parseFloat(adv.remainingBalance || "0");
    const reduce = Math.min(bal, remaining);
    const newBal = bal - reduce;
    await tx
      .update(factoryWorkerAdvances)
      .set({
        remainingBalance: newBal.toFixed(2),
        fullyPaid: newBal <= 0,
      })
      .where(eq(factoryWorkerAdvances.id, adv.id));
    remaining -= reduce;
  }
}
