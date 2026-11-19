// Extracted from ./accountMigrationSafeRoutes.ts to keep that module under the source-size cap.
import type { Express, Request, Response } from "express";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db";
import { requireAuth, requireRole } from "../../auth";
import { logger } from "../../lib/logger";
import {
  assertCompaniesAccess,
  CompanyAccessError,
  getAccessibleCompanyIds,
  getCompanyAccessContext,
} from "../../security/companyAccessBoundary";
import { auditLog, ledgerAccounts } from "@shared/schema";
import {
  EXECUTE_ACTION,
  UNDO_ACTION,
  MAX_BATCH,
  MIGRATION_CLEARING_SUBTYPE,
  deepestError,
  type AccountMigrationTransaction,
  type AccountMigrationDatabaseScope,
  type SavedMigrationV1,
  type SavedMigrationV2,
  type SavedMigration,
} from "./registerAccountMigrationSafeRoutesPart1Helpers";
export {
  EXECUTE_ACTION,
  UNDO_ACTION,
  type SplitVoucherSnapshot,
  type SavedMigrationV2,
} from "./registerAccountMigrationSafeRoutesPart1Helpers";

const MAX_CODE_LENGTH = 50;

export class AccountMigrationConflict extends Error {
  status: number;

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

export function sameIds(left: number[], right: number[]): boolean {
  const a = [...left].sort((x, y) => x - y);
  const b = [...right].sort((x, y) => x - y);
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

export function uniqueDestinationCode(code: string, occupied: Set<string>): string {
  const base = code.trim();
  if (!occupied.has(base)) {
    occupied.add(base);
    return base;
  }
  for (let attempt = 1; attempt <= 10_000; attempt += 1) {
    const suffix = attempt === 1 ? "-MIGRATED" : `-MIGRATED-${attempt}`;
    const candidate = `${base.slice(0, Math.max(1, MAX_CODE_LENGTH - suffix.length))}${suffix}`;
    if (!occupied.has(candidate)) {
      occupied.add(candidate);
      return candidate;
    }
  }
  throw new AccountMigrationConflict(`Could not generate a unique destination code for ${code}.`);
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
      throw new AccountMigrationConflict(
        `Account ${exact.code} is the account-migration clearing account and cannot be migrated in the same batch.`
      );
    }
    if (exact.deletedAt) {
      throw new AccountMigrationConflict(`Account-migration clearing account ${exact.code} is deleted.`);
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
  if (!created) throw new AccountMigrationConflict("Could not create account-migration clearing account.");
  return created;
}

export async function resolveAccountMigrationDatabaseScope(
  req: Request,
  sourceCompanyId: number,
  destinationCompanyId: number
): Promise<AccountMigrationDatabaseScope> {
  const context = getCompanyAccessContext(req);
  await assertCompaniesAccess(context.userId, [sourceCompanyId, destinationCompanyId]);
  const authorizedCompanyIds = [...new Set([sourceCompanyId, destinationCompanyId])]
    .sort((left, right) => left - right)
    .join(",");
  return { activeCompanyId: context.activeCompanyId, authorizedCompanyIds };
}

export async function applyAccountMigrationDatabaseScope(
  tx: AccountMigrationTransaction,
  scope: AccountMigrationDatabaseScope
): Promise<void> {
  await tx.execute(sql`SELECT
    set_config('app.company_scope_maintenance', 'off', true),
    set_config('app.current_company_id', ${String(scope.activeCompanyId)}, true),
    set_config('app.authorized_company_ids', ${scope.authorizedCompanyIds}, true)`);
}

export async function lockCompanies(
  tx: AccountMigrationTransaction,
  sourceCompanyId: number,
  destinationCompanyId: number
) {
  const ids = [sourceCompanyId, destinationCompanyId].sort((a, b) => a - b);
  for (const companyId of ids) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('account-migration'), ${companyId})`);
  }
}

export function respondWithError(res: Response, error: unknown) {
  if (error instanceof CompanyAccessError) {
    return res.status(error.status).json({ message: error.message, code: error.code });
  }
  if (error instanceof AccountMigrationConflict) {
    return res.status(error.status).json({ message: error.message });
  }
  const cause = deepestError(error);
  logger.error("[AccountMigration] Safe route failed", {
    message: cause?.message,
    code: cause?.code,
    constraint: cause?.constraint,
    detail: cause?.detail,
  });
  const status = cause?.code === "23505" || cause?.code === "23514" || cause?.code === "23503" ? 409 : 500;
  return res.status(status).json({
    message: cause?.message || "Account migration failed",
    constraint: cause?.constraint,
    detail: cause?.detail,
  });
}

export function savedMigration(value: unknown): SavedMigration | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<SavedMigrationV1> | Partial<SavedMigrationV2>;
  if (
    (item.version !== 1 && item.version !== 2) ||
    typeof item.migrationId !== "string" ||
    !Array.isArray(item.accountIds) ||
    !Array.isArray(item.movedVoucherIds) ||
    !Array.isArray(item.accounts) ||
    !item.controls
  ) {
    return null;
  }
  if (item.version === 1) return item as SavedMigrationV1;
  const v2 = item as Partial<SavedMigrationV2>;
  if (!Array.isArray(v2.splitVouchers)) return null;
  return v2 as SavedMigrationV2;
}

export function baseAmount(value: string | null | undefined): string {
  const parsed = Number(value ?? 0);
  return (Number.isFinite(parsed) ? parsed : 0).toFixed(6);
}

export function registerAccountMigrationSafeRoutesPart1(app: Express) {
  // Saved moves remain returnable after the browser navigates away to post
  // transactions in the temporary company. Expose only the undo identifiers,
  // not the internal control-reference snapshots stored in the audit row.
  app.get(
    "/api/admin/account-migration/pending",
    requireAuth,
    requireRole("Admin", "Developer"),
    async (req: Request, res: Response) => {
      try {
        const context = getCompanyAccessContext(req);
        const accessible = await getAccessibleCompanyIds(context.userId);
        const companyIds = [...accessible].sort((left, right) => left - right);
        if (companyIds.length === 0) return res.json([]);

        const rows = await db.transaction(async (tx) => {
          await tx.execute(sql`SELECT
            set_config('app.company_scope_maintenance', 'off', true),
            set_config('app.current_company_id', ${String(context.activeCompanyId)}, true),
            set_config('app.authorized_company_ids', ${companyIds.join(",")}, true)`);
          return tx
            .select()
            .from(auditLog)
            .where(
              and(inArray(auditLog.companyId, companyIds), inArray(auditLog.action, [EXECUTE_ACTION, UNDO_ACTION]))
            )
            .orderBy(desc(auditLog.createdAt))
            .limit(500);
        });

        const undone = new Set(rows.filter((row) => row.action === UNDO_ACTION).map((row) => row.recordIdentifier));
        const pending = rows
          .filter((row) => row.action === EXECUTE_ACTION)
          .map((row) => savedMigration(row.changes))
          .filter((saved): saved is SavedMigration => Boolean(saved))
          .filter(
            (saved) =>
              accessible.has(saved.srcCompanyId) &&
              accessible.has(saved.destCompanyId) &&
              !undone.has(saved.migrationId)
          )
          .slice(0, 100)
          .map((saved) => ({
            migrationId: saved.migrationId,
            srcCompanyId: saved.srcCompanyId,
            destCompanyId: saved.destCompanyId,
            accountIds: saved.accountIds,
            movedVoucherIds: saved.movedVoucherIds,
            accounts: saved.accounts.map(({ accountId, originalCode, finalCode }) => ({
              accountId,
              originalCode,
              finalCode,
            })),
          }));
        return res.json(pending);
      } catch (error: unknown) {
        return respondWithError(res, error);
      }
    }
  );
}
