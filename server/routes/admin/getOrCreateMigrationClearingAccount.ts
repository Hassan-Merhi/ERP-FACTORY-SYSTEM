// Extracted from ./accountMigrationRoundTripRoutes.ts to keep that module under the source-size cap.
import type { Response } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../../db";
import { logger } from "../../lib/logger";
import { CompanyAccessError } from "../../security/companyAccessBoundary";
import { auditLog, ledgerAccounts } from "@shared/schema";
import type { AccountMigrationControlSnapshot } from "./accountMigrationControlReferences";

const EXECUTE_ACTION = "ACCOUNT_MIGRATION_EXECUTE_SAFE";

export const UNDO_ACTION = "ACCOUNT_MIGRATION_UNDO_SAFE";

const MAX_BATCH = 200;

const MAX_CODE_LENGTH = 50;

const MIGRATION_CLEARING_SUBTYPE = "account_migration_clearing";

type AccountMigrationTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

type SplitVoucherSnapshot = {
  sourceVoucherId: number;
  destinationVoucherId: number;
  sourceClearingAccountId: number;
  remappedEntries: Array<{ entryId: number; originalLedgerAccountId: number }>;
};

type SavedMigration = {
  version: 1 | 2;
  migrationId: string;
  srcCompanyId: number;
  destCompanyId: number;
  accountIds: number[];
  movedVoucherIds: number[];
  accounts: Array<{ accountId: number; originalCode: string; finalCode: string }>;
  controls: AccountMigrationControlSnapshot;
  splitVouchers?: SplitVoucherSnapshot[];
};

export class AccountMigrationRoundTripConflict extends Error {
  readonly status: number;

  constructor(message: string, status = 409) {
    super(message);
    this.status = status;
  }
}

export function positiveInt(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function idArray(value: unknown, allowEmpty = false): number[] | null {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > MAX_BATCH) return null;
  const parsed = value.map(positiveInt);
  if (parsed.some((id) => id === null)) return null;
  return [...new Set(parsed as number[])];
}

function sameIds(left: number[], right: number[]): boolean {
  const a = [...left].sort((x, y) => x - y);
  const b = [...right].sort((x, y) => x - y);
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

function savedMigration(value: unknown): SavedMigration | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<SavedMigration>;
  if (
    (item.version !== 1 && item.version !== 2) ||
    typeof item.migrationId !== "string" ||
    !Number.isSafeInteger(item.srcCompanyId) ||
    !Number.isSafeInteger(item.destCompanyId) ||
    !Array.isArray(item.accountIds) ||
    !Array.isArray(item.movedVoucherIds) ||
    !Array.isArray(item.accounts) ||
    !item.controls
  ) {
    return null;
  }
  if (item.version === 2 && !Array.isArray(item.splitVouchers)) return null;
  return item as SavedMigration;
}

export function baseAmount(value: string | null | undefined): string {
  const parsed = Number(value ?? 0);
  return (Number.isFinite(parsed) ? parsed : 0).toFixed(6);
}

export function migrationClearingCode(prefix: string, companyCode: string): string {
  return `${prefix}-${companyCode}`.slice(0, MAX_CODE_LENGTH);
}

export async function getOrCreateMigrationClearingAccount(
  tx: AccountMigrationTransaction,
  params: {
    companyId: number;
    code: string;
    name: string;
    accountType: "Asset" | "Liability";
    selectedAccountIds: ReadonlySet<number>;
  }
) {
  const rows = await tx.select().from(ledgerAccounts).where(eq(ledgerAccounts.companyId, params.companyId));
  const exact = rows.find((row) => row.code === params.code && row.subType === MIGRATION_CLEARING_SUBTYPE);
  if (exact) {
    if (params.selectedAccountIds.has(exact.id)) {
      throw new AccountMigrationRoundTripConflict(
        `Account ${exact.code} is the account-migration clearing account and cannot be migrated.`
      );
    }
    if (exact.deletedAt) {
      throw new AccountMigrationRoundTripConflict(`Account-migration clearing account ${exact.code} is deleted.`);
    }
    return exact;
  }

  const occupied = new Set(rows.map((row) => row.code));
  let code = params.code;
  for (let attempt = 2; occupied.has(code); attempt += 1) {
    const suffix = `-${attempt}`;
    code = `${params.code.slice(0, Math.max(1, MAX_CODE_LENGTH - suffix.length))}${suffix}`;
  }

  // Clearing accounts are looked up by code but ledger_accounts is unique on
  // (company_id, name), and a company can legitimately need both directions
  // against the same counterpart: the asset-side AM-TO account and the
  // liability-side AM-FROM account are both named after that one company. The
  // code-keyed lookup above misses the other direction, so qualify the name
  // with the code when the plain one is taken rather than colliding on insert.
  const occupiedNames = new Set(rows.map((row) => row.name));
  const name = occupiedNames.has(params.name) ? `${params.name} (${code})` : params.name;

  const [created] = await tx
    .insert(ledgerAccounts)
    .values({
      companyId: params.companyId,
      code,
      name,
      accountType: params.accountType,
      subType: MIGRATION_CLEARING_SUBTYPE,
      openingBalance: "0",
      active: true,
      isHidden: true,
    })
    .returning();
  if (!created) throw new AccountMigrationRoundTripConflict("Could not create account-migration clearing account.");
  return created;
}

export async function applyDatabaseScope(
  tx: AccountMigrationTransaction,
  activeCompanyId: number,
  authorizedCompanyIds: string
): Promise<void> {
  await tx.execute(sql`SELECT
    set_config('app.company_scope_maintenance', 'off', true),
    set_config('app.current_company_id', ${String(activeCompanyId)}, true),
    set_config('app.authorized_company_ids', ${authorizedCompanyIds}, true)`);
}

export async function lockCompanies(
  tx: AccountMigrationTransaction,
  companyA: number,
  companyB: number
): Promise<void> {
  const ids = [companyA, companyB].sort((a, b) => a - b);
  for (const companyId of ids) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('account-migration'), ${companyId})`);
  }
}

export function respondWithError(res: Response, error: unknown) {
  if (error instanceof CompanyAccessError) {
    return res.status(error.status).json({ message: error.message, code: error.code });
  }
  if (error instanceof AccountMigrationRoundTripConflict) {
    return res.status(error.status).json({ message: error.message });
  }
  logger.error("[AccountMigration] Round-trip return failed", { error });
  return res.status(500).json({ message: error instanceof Error ? error.message : "Account return migration failed" });
}

export async function findMatchingMigration(
  srcCompanyId: number,
  destCompanyId: number,
  accountIds: number[],
  movedVoucherIds: number[]
): Promise<SavedMigration | null> {
  const recentLogs = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, EXECUTE_ACTION), eq(auditLog.companyId, srcCompanyId)))
    .orderBy(desc(auditLog.createdAt))
    .limit(100);

  for (const row of recentLogs) {
    const saved = savedMigration(row.changes);
    if (
      saved &&
      saved.destCompanyId === destCompanyId &&
      sameIds(saved.accountIds, accountIds) &&
      sameIds(saved.movedVoucherIds, movedVoucherIds)
    ) {
      return saved;
    }
  }
  return null;
}
