// Extracted from ./factoryInsuranceRoutes.ts to keep that module under the source-size cap.
import { z } from "zod";
import { and, eq, isNull, sql } from "drizzle-orm";
import { type DbTransaction, pool } from "../../db";
import { ledgerAccounts } from "@shared/schema";
import { isCompanyIsolationError } from "../../services/security/requestCompanyScope";
import { toMoney } from "../../lib/money";

export const CLEAR_CONFIRMATION = "CLEAR ALL INSURANCE";

// Insurance-owned journal creation has its own narrow API rather than exposing
// generic Voucher journal creation to everybody with Insurance-tab access.
export const insuranceExtraChargeSchema = z
  .object({
    voucherDate: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/),
    amount: z.string().regex(/^(?:0|[1-9]\d{0,10})(?:\.\d{1,2})?$/),
    debitAccountId: z.number().int().positive(),
    creditAccountId: z.number().int().positive(),
    notes: z.string().trim().max(2000).optional().default(""),
    clientRequestId: z.string().uuid(),
  })
  .refine((value) => value.debitAccountId !== value.creditAccountId, {
    path: ["creditAccountId"],
    message: "Debit and credit accounts must be different",
  })
  .refine((value) => toMoney(value.amount).gt(0), {
    path: ["amount"],
    message: "Amount must be greater than zero",
  });

export const insuranceImportApplySchema = z.object({
  rows: z
    .array(
      z.object({
        sheetName: z.string().min(1).max(100),
        monthStart: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-01$/),
        name: z.string().trim().min(1).max(500),
        amount: z
          .string()
          .regex(/^\d+(\.\d{1,2})?$/)
          .refine((value) => Number.isFinite(Number(value)) && Number(value) >= 0),
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        nationality: z.string().max(500).optional(),
        positionWorking: z.string().max(500).optional(),
        insuranceNumber: z.string().max(500).optional(),
        dob: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        notes: z.string().max(5000).optional(),
      })
    )
    .min(1)
    .max(10_000),
});

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function sendRouteError(res: import("express").Response, error: unknown, fallback: string): void {
  if (isCompanyIsolationError(error)) {
    res.status(403).json({ message: "Forbidden" });
    return;
  }
  res.status(500).json({ message: errorMessage(error, fallback) });
}

export async function findOrCreateLedger(
  companyId: number,
  name: string,
  accountType: string
): Promise<{ id: number }> {
  const existing = await pool.query(
    `SELECT id FROM ledger_accounts WHERE company_id = $1 AND name = $2 AND deleted_at IS NULL LIMIT 1`,
    [companyId, name]
  );
  if (existing.rows.length > 0) return { id: existing.rows[0].id };

  const maxRow = await pool.query(
    `SELECT MAX(CAST(code AS INTEGER)) AS max_code
     FROM ledger_accounts
     WHERE company_id = $1 AND code ~ '^[0-9]+$'`,
    [companyId]
  );
  const nextCode = String((parseInt(maxRow.rows[0]?.max_code || "0") || 0) + 1);

  const inserted = await pool.query(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type, active, is_hidden)
     VALUES ($1, $2, $3, $4, true, false)
     ON CONFLICT (company_id, code) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [companyId, nextCode, name, accountType]
  );
  return { id: inserted.rows[0].id };
}

export async function findOrCreateLedgerTx(
  tx: DbTransaction,
  companyId: number,
  name: string,
  accountType: string
): Promise<{ id: number }> {
  const [existing] = await tx
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(
      and(eq(ledgerAccounts.companyId, companyId), eq(ledgerAccounts.name, name), isNull(ledgerAccounts.deletedAt))
    )
    .limit(1);
  if (existing) return existing;

  const [maxRow] = await tx
    .select({
      maxCode: sql<string>`MAX(CASE WHEN ${ledgerAccounts.code} ~ '^[0-9]+$' THEN CAST(${ledgerAccounts.code} AS INTEGER) ELSE 0 END)`,
    })
    .from(ledgerAccounts)
    .where(eq(ledgerAccounts.companyId, companyId));
  let nextCode = (Number(maxRow?.maxCode ?? 0) || 0) + 1;

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const [inserted] = await tx
      .insert(ledgerAccounts)
      .values({
        companyId,
        code: String(nextCode),
        name,
        accountType,
        active: true,
        isHidden: false,
      })
      .onConflictDoNothing()
      .returning({ id: ledgerAccounts.id });
    if (inserted) return inserted;
    nextCode += 1;
  }
  throw new Error(`Could not allocate a ledger code for ${name}`);
}

export function normalizedMemberName(name: string): string {
  return name.trim().toLocaleLowerCase();
}
