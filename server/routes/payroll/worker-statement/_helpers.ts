/**
 * Shared state and helpers for the workerStatementRoutes routes.
 *
 * Extracted verbatim from the former single-file workerStatementRoutes.ts.
 */
import { getErrorMessage } from "../../../lib/httpHandlers";
import { db } from "../../../db";
import { eq, and, sql, isNull } from "drizzle-orm";
import multer from "multer";
import path from "path";
import fs from "fs";
import { ledgerAccounts } from "@shared/schema";
import type { AttendanceStatusRow } from "../../../services/payroll/factoryPayrollGenerationPolicy";
import { toMoney } from "../../../lib/money";
import { exactMonthlyPay, exactMonthlyPayFromAttendance } from "../core/workerPayAmounts";

/** Prefer the factory-pinned company ID so cross-tab ERP company switches don't corrupt factory writes. */
export function getFactoryCompanyId(req: import("express").Request): number | undefined {
  return req.session.factoryCompanyId || req.session.currentCompanyId;
}

/** Write a single daybook entry (factory audit log). */
// Phase 19 C (M3): one shared daybook writer; a missing rate is stored unresolved (0), never 1.
export { writeDaybookEntry } from "../../../services/factory/factoryDaybookWriter";

/** Find or create a ledger account by name for a company. Returns the account row.
 *  Skips soft-deleted accounts and handles race-condition unique-constraint failures. */
export async function findOrCreateLedger(
  companyId: number,
  name: string,
  accountType: string
): Promise<{ id: number }> {
  const [existing] = await db
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(
      and(eq(ledgerAccounts.companyId, companyId), eq(ledgerAccounts.name, name), isNull(ledgerAccounts.deletedAt))
    );
  if (existing) return existing;

  for (let attempt = 0; attempt < 5; attempt++) {
    const [maxCodeRow] = await db
      .select({ maxCode: sql<number | null>`MAX(CAST(code AS INTEGER))` })
      .from(ledgerAccounts)
      .where(and(eq(ledgerAccounts.companyId, companyId), sql`code ~ '^\\d+$'`));
    const nextCode = String((maxCodeRow?.maxCode ?? 0) + 1 + attempt);
    try {
      const [created] = await db
        .insert(ledgerAccounts)
        .values({ companyId, code: nextCode, name, accountType, active: true, isHidden: false })
        .returning({ id: ledgerAccounts.id });
      return created;
    } catch (err: unknown) {
      if ((err as { code?: string }).code === "23505" || getErrorMessage(err)?.includes("unique")) {
        const [nowFound] = await db
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
  return exactMonthlyPay(toMoney(salary), startStr, endStr).toNumber();
}

// Helper: Compute monthly pay from actual attendance records.
// Monthly payroll uses attendance-based calculation (Present/Late = 1 day, Half Day = 0.5 day)
// rather than calendar-day proration to match actual work performed.
export function computeMonthlyPayFromAttendance(
  baseSalary: number,
  periodStart: string,
  attendanceRows: readonly AttendanceStatusRow[]
): number {
  // Present/Late = 1 day, Half Day = 0.5, at salary / days in the month of periodStart.
  return exactMonthlyPayFromAttendance(toMoney(baseSalary), periodStart, attendanceRows).toNumber();
}
