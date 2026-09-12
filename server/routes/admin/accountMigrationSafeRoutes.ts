import { randomUUID } from "crypto";
import type { Express, Request, Response } from "express";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db";
import { requireAuth, requireRole } from "../../auth";
import { logger } from "../../lib/logger";
import { auditLog, companies, ledgerAccounts, voucherEntries, vouchers } from "@shared/schema";
import {
  assertDestinationControlReferencesAreClear,
  detachAccountMigrationControlReferences,
  restoreAccountMigrationControlReferences,
  type AccountMigrationControlSnapshot,
} from "./accountMigrationControlReferences";

const EXECUTE_ACTION = "ACCOUNT_MIGRATION_EXECUTE_SAFE";
const UNDO_ACTION = "ACCOUNT_MIGRATION_UNDO_SAFE";
const MAX_BATCH = 200;
const MAX_CODE_LENGTH = 50;

class AccountMigrationConflict extends Error {
  status: number;

  constructor(message: string, status = 409) {
    super(message);
    this.status = status;
  }
}

type SavedMigration = {
  version: 1;
  migrationId: string;
  srcCompanyId: number;
  destCompanyId: number;
  accountIds: number[];
  movedVoucherIds: number[];
  accounts: Array<{ accountId: number; originalCode: string; finalCode: string }>;
  controls: AccountMigrationControlSnapshot;
};

function positiveInt(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function idArray(value: unknown, allowEmpty = false): number[] | null {
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

function uniqueDestinationCode(code: string, occupied: Set<string>): string {
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

async function lockCompanies(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  sourceCompanyId: number,
  destinationCompanyId: number
) {
  const ids = [sourceCompanyId, destinationCompanyId].sort((a, b) => a - b);
  for (const companyId of ids) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('account-migration'), ${companyId})`);
  }
}

/** Loose view over a thrown value's error fields, including the cause chain. */
interface PgErrorLike {
  message?: string;
  code?: string;
  constraint?: string;
  detail?: string;
  cause?: unknown;
}

function deepestError(error: unknown): PgErrorLike {
  const asPgError = (value: unknown): PgErrorLike => (value && typeof value === "object" ? (value as PgErrorLike) : {});
  let current = asPgError(error);
  const seen = new Set<unknown>();
  while (current.cause && !seen.has(current.cause)) {
    seen.add(current);
    current = asPgError(current.cause);
  }
  return current;
}

function respondWithError(res: import("express").Response, error: unknown) {
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

function savedMigration(value: unknown): SavedMigration | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<SavedMigration>;
  if (
    item.version !== 1 ||
    typeof item.migrationId !== "string" ||
    !Array.isArray(item.accountIds) ||
    !Array.isArray(item.movedVoucherIds) ||
    !Array.isArray(item.accounts) ||
    !item.controls
  ) {
    return null;
  }
  return item as SavedMigration;
}

export function registerAccountMigrationSafeRoutes(app: Express) {
  app.post(
    "/api/admin/account-migration/execute",
    requireAuth,
    requireRole("Admin", "Developer"),
    async (req: Request, res: Response) => {
      const accountIds = idArray(req.body?.accountIds);
      const srcCompanyId = positiveInt(req.body?.srcCompanyId);
      const destCompanyId = positiveInt(req.body?.destCompanyId);
      if (!accountIds || !srcCompanyId || !destCompanyId) {
        return res.status(400).json({ message: "Valid accountIds, srcCompanyId and destCompanyId are required." });
      }
      if (srcCompanyId === destCompanyId) {
        return res.status(400).json({ message: "Source and destination must be different companies." });
      }

      try {
        const result = await db.transaction(async (tx) => {
          await lockCompanies(tx, srcCompanyId, destCompanyId);

          const companyRows = await tx
            .select({ id: companies.id })
            .from(companies)
            .where(inArray(companies.id, [srcCompanyId, destCompanyId]));
          if (companyRows.length !== 2) {
            throw new AccountMigrationConflict("Source or destination company no longer exists.", 404);
          }

          const sourceAccounts = await tx
            .select()
            .from(ledgerAccounts)
            .where(and(eq(ledgerAccounts.companyId, srcCompanyId), inArray(ledgerAccounts.id, accountIds)));
          const sourceById = new Map(sourceAccounts.map((account) => [account.id, account]));
          const missingId = accountIds.find((id) => !sourceById.has(id));
          if (missingId) {
            throw new AccountMigrationConflict(
              `Account ${missingId} is no longer in the source company. Refresh and preview again.`,
              404
            );
          }

          const destinationAccounts = await tx
            .select({ code: ledgerAccounts.code })
            .from(ledgerAccounts)
            .where(eq(ledgerAccounts.companyId, destCompanyId));
          const occupiedCodes = new Set(destinationAccounts.map((account) => account.code));

          const selectedEntries = await tx
            .select({
              voucherId: voucherEntries.voucherId,
              ledgerAccountId: voucherEntries.ledgerAccountId,
            })
            .from(voucherEntries)
            .where(inArray(voucherEntries.ledgerAccountId, accountIds));
          const entryCount = new Map<number, number>();
          const voucherIdsByAccount = new Map<number, Set<number>>();
          for (const entry of selectedEntries) {
            if (entry.ledgerAccountId === null) continue;
            entryCount.set(entry.ledgerAccountId, (entryCount.get(entry.ledgerAccountId) ?? 0) + 1);
            const voucherIds = voucherIdsByAccount.get(entry.ledgerAccountId) ?? new Set<number>();
            voucherIds.add(entry.voucherId);
            voucherIdsByAccount.set(entry.ledgerAccountId, voucherIds);
          }

          const plans = accountIds.map((accountId) => {
            // Every id passed the missingId guard above, so the lookup cannot miss.
            const account = sourceById.get(accountId)!;
            return {
              account,
              originalCode: account.code,
              finalCode: uniqueDestinationCode(account.code, occupiedCodes),
              entryCount: entryCount.get(accountId) ?? 0,
              touchedVoucherIds: [...(voucherIdsByAccount.get(accountId) ?? new Set<number>())],
            };
          });

          const touchedVoucherIds = [...new Set(plans.flatMap((plan) => plan.touchedVoucherIds))];
          const selectedAccountSet = new Set(accountIds);
          const movedVoucherIds: number[] = [];
          if (touchedVoucherIds.length > 0) {
            const touchedEntries = await tx
              .select({
                voucherId: voucherEntries.voucherId,
                ledgerAccountId: voucherEntries.ledgerAccountId,
                supplierId: voucherEntries.supplierId,
                employeeId: voucherEntries.employeeId,
              })
              .from(voucherEntries)
              .where(inArray(voucherEntries.voucherId, touchedVoucherIds));
            const entriesByVoucher = new Map<number, typeof touchedEntries>();
            for (const entry of touchedEntries) {
              const rows = entriesByVoucher.get(entry.voucherId) ?? [];
              rows.push(entry);
              entriesByVoucher.set(entry.voucherId, rows);
            }
            for (const voucherId of touchedVoucherIds) {
              const shared = (entriesByVoucher.get(voucherId) ?? []).some(
                (entry) =>
                  entry.supplierId !== null ||
                  entry.employeeId !== null ||
                  (entry.ledgerAccountId !== null && !selectedAccountSet.has(entry.ledgerAccountId))
              );
              if (!shared) movedVoucherIds.push(voucherId);
            }
          }

          // The production tenant-control trigger rejects the parent account move
          // until source-company user/POS cash references have been removed.
          const controls = await detachAccountMigrationControlReferences(tx, srcCompanyId, accountIds);

          for (const plan of plans) {
            await tx
              .update(ledgerAccounts)
              .set({ companyId: destCompanyId, code: plan.finalCode, parentId: null })
              .where(and(eq(ledgerAccounts.id, plan.account.id), eq(ledgerAccounts.companyId, srcCompanyId)));
          }
          if (movedVoucherIds.length > 0) {
            await tx
              .update(vouchers)
              .set({ companyId: destCompanyId })
              .where(and(eq(vouchers.companyId, srcCompanyId), inArray(vouchers.id, movedVoucherIds)));
          }

          const migrationId = randomUUID();
          const changes: SavedMigration = {
            version: 1,
            migrationId,
            srcCompanyId,
            destCompanyId,
            accountIds,
            movedVoucherIds,
            accounts: plans.map((plan) => ({
              accountId: plan.account.id,
              originalCode: plan.originalCode,
              finalCode: plan.finalCode,
            })),
            controls,
          };
          await tx.insert(auditLog).values({
            userId: String(req.session?.userId ?? "system"),
            username: String(req.session?.username ?? "system"),
            companyId: srcCompanyId,
            action: EXECUTE_ACTION,
            tableName: "ledger_accounts",
            recordIdentifier: migrationId,
            changes,
          });

          return {
            success: true,
            migrationId,
            srcCompanyId,
            destCompanyId,
            totalEntries: plans.reduce((sum, plan) => sum + plan.entryCount, 0),
            movedVoucherIds,
            movedVoucherCount: movedVoucherIds.length,
            sharedVoucherCount: touchedVoucherIds.length - movedVoucherIds.length,
            detachedRoleCashAccountCount: controls.roleCashAccounts.length,
            detachedLocationCashAccountCount: controls.locationCashAccounts.length,
            accounts: plans.map((plan) => ({
              accountId: plan.account.id,
              accountName: plan.account.name,
              originalCode: plan.originalCode,
              finalCode: plan.finalCode,
              entryCount: plan.entryCount,
              wasRenamed: plan.originalCode !== plan.finalCode,
            })),
          };
        });

        logger.info("[AccountMigration] Safe migration completed", {
          migrationId: result.migrationId,
          accountCount: result.accounts.length,
          movedVoucherCount: result.movedVoucherCount,
          detachedRoleCashAccountCount: result.detachedRoleCashAccountCount,
          detachedLocationCashAccountCount: result.detachedLocationCashAccountCount,
        });
        return res.json(result);
      } catch (error: unknown) {
        return respondWithError(res, error);
      }
    }
  );

  app.post(
    "/api/admin/account-migration/undo",
    requireAuth,
    requireRole("Admin", "Developer"),
    async (req, res, next) => {
      const accountIds = idArray(
        Array.isArray(req.body?.accounts)
          ? req.body.accounts.map((account: { accountId?: unknown } | null | undefined) => account?.accountId)
          : null
      );
      const movedVoucherIds = idArray(req.body?.movedVoucherIds, true);
      const srcCompanyId = positiveInt(req.body?.srcCompanyId);
      const destCompanyId = positiveInt(req.body?.destCompanyId);
      if (!accountIds || !movedVoucherIds || !srcCompanyId || !destCompanyId) {
        return res.status(400).json({ message: "Invalid migration undo payload." });
      }

      try {
        const recentLogs = await db
          .select()
          .from(auditLog)
          .where(and(eq(auditLog.action, EXECUTE_ACTION), eq(auditLog.companyId, srcCompanyId)))
          .orderBy(desc(auditLog.createdAt))
          .limit(100);
        const audit = recentLogs.find((row) => {
          const saved = savedMigration(row.changes);
          return (
            saved !== null &&
            saved.destCompanyId === destCompanyId &&
            sameIds(saved.accountIds, accountIds) &&
            sameIds(saved.movedVoucherIds, movedVoucherIds)
          );
        });
        if (!audit) return next();
        const saved = savedMigration(audit.changes);
        if (!saved) return next();

        const [alreadyUndone] = await db
          .select({ id: auditLog.id })
          .from(auditLog)
          .where(and(eq(auditLog.action, UNDO_ACTION), eq(auditLog.recordIdentifier, saved.migrationId)))
          .limit(1);
        if (alreadyUndone) {
          return res.status(409).json({ message: "This migration has already been undone." });
        }

        await db.transaction(async (tx) => {
          await lockCompanies(tx, srcCompanyId, destCompanyId);
          const currentAccounts = await tx
            .select({ id: ledgerAccounts.id, companyId: ledgerAccounts.companyId })
            .from(ledgerAccounts)
            .where(inArray(ledgerAccounts.id, accountIds));
          if (
            currentAccounts.length !== accountIds.length ||
            currentAccounts.some((account) => account.companyId !== destCompanyId)
          ) {
            throw new AccountMigrationConflict("One or more accounts are no longer in the destination company.");
          }

          await assertDestinationControlReferencesAreClear(tx, destCompanyId, accountIds);

          const sourceCodes = await tx
            .select({ id: ledgerAccounts.id, code: ledgerAccounts.code })
            .from(ledgerAccounts)
            .where(eq(ledgerAccounts.companyId, srcCompanyId));
          const sourceCodeOwners = new Map(sourceCodes.map((account) => [account.code, account.id]));
          for (const account of saved.accounts) {
            const owner = sourceCodeOwners.get(account.originalCode);
            if (owner !== undefined && owner !== account.accountId) {
              throw new AccountMigrationConflict(
                `Another source-company account now uses code ${account.originalCode}.`
              );
            }
          }

          for (const account of saved.accounts) {
            await tx
              .update(ledgerAccounts)
              .set({ companyId: srcCompanyId, code: account.originalCode, parentId: null })
              .where(and(eq(ledgerAccounts.id, account.accountId), eq(ledgerAccounts.companyId, destCompanyId)));
          }
          if (saved.movedVoucherIds.length > 0) {
            await tx
              .update(vouchers)
              .set({ companyId: srcCompanyId })
              .where(and(eq(vouchers.companyId, destCompanyId), inArray(vouchers.id, saved.movedVoucherIds)));
          }
          await restoreAccountMigrationControlReferences(tx, srcCompanyId, saved.controls);

          await tx.insert(auditLog).values({
            userId: String(req.session?.userId ?? "system"),
            username: String(req.session?.username ?? "system"),
            companyId: srcCompanyId,
            action: UNDO_ACTION,
            tableName: "ledger_accounts",
            recordIdentifier: saved.migrationId,
            changes: {
              restoredAccountIds: accountIds,
              restoredVoucherIds: saved.movedVoucherIds,
              restoredRoleCashAccounts: saved.controls.roleCashAccounts.length,
              restoredLocationCashAccounts: saved.controls.locationCashAccounts.length,
            },
          });
        });

        return res.json({ success: true, restoredAccountCount: accountIds.length });
      } catch (error: unknown) {
        return respondWithError(res, error);
      }
    }
  );
}
