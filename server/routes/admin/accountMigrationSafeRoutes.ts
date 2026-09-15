import { randomUUID } from "crypto";
import type { Express, Request, Response } from "express";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db";
import { requireAuth, requireRole } from "../../auth";
import { logger } from "../../lib/logger";
import { voucherMutationBlockReason } from "../../lib/migratedVoucherGuard";
import {
  DurableFinancialOperationError,
  financialOperationFingerprint,
  withDurableFinancialOperation,
} from "../../services/accounting/durableFinancialOperation";
import {
  financialOperationErrorStatus,
  financialOperationRequestPayload,
  resolveFinancialOperationKey,
} from "../../services/accounting/financialOperationRequest";
import {
  assertCompaniesAccess,
  CompanyAccessError,
  getCompanyAccessContext,
} from "../../security/companyAccessBoundary";
import { auditLog, companies, ledgerAccounts, voucherEntries, vouchers } from "@shared/schema";
import {
  assertDestinationControlReferencesAreClear,
  detachAccountMigrationControlReferences,
  restoreAccountMigrationControlReferences,
  type AccountMigrationControlSnapshot,
} from "./accountMigrationControlReferences";
import {
  buildMigrationVoucherPlan,
  migrationClearingAmounts,
  migrationDestinationTotal,
  type MigrationEntryLike,
} from "./accountMigrationBalancePlan";

const EXECUTE_ACTION = "ACCOUNT_MIGRATION_EXECUTE_SAFE";
const UNDO_ACTION = "ACCOUNT_MIGRATION_UNDO_SAFE";
const MAX_BATCH = 200;
const MAX_CODE_LENGTH = 50;
const MIGRATION_CLEARING_SUBTYPE = "account_migration_clearing";

type AccountMigrationTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

type AccountMigrationDatabaseScope = {
  activeCompanyId: number;
  authorizedCompanyIds: string;
};

class AccountMigrationConflict extends Error {
  status: number;

  constructor(message: string, status = 409) {
    super(message);
    this.status = status;
  }
}

type SavedMigrationV1 = {
  version: 1;
  migrationId: string;
  srcCompanyId: number;
  destCompanyId: number;
  accountIds: number[];
  movedVoucherIds: number[];
  accounts: Array<{ accountId: number; originalCode: string; finalCode: string }>;
  controls: AccountMigrationControlSnapshot;
};

type SplitVoucherSnapshot = {
  sourceVoucherId: number;
  destinationVoucherId: number;
  sourceClearingAccountId: number;
  remappedEntries: Array<{ entryId: number; originalLedgerAccountId: number }>;
};

type SavedMigrationV2 = {
  version: 2;
  migrationId: string;
  srcCompanyId: number;
  destCompanyId: number;
  accountIds: number[];
  movedVoucherIds: number[];
  accounts: Array<{ accountId: number; originalCode: string; finalCode: string }>;
  controls: AccountMigrationControlSnapshot;
  splitVouchers: SplitVoucherSnapshot[];
};

type SavedMigration = SavedMigrationV1 | SavedMigrationV2;

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

function migrationClearingCode(prefix: string, companyCode: string): string {
  return `${prefix}-${companyCode}`.slice(0, MAX_CODE_LENGTH);
}

async function getOrCreateMigrationClearingAccount(
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

  const [created] = await tx
    .insert(ledgerAccounts)
    .values({
      companyId: params.companyId,
      code,
      name: params.name,
      accountType: params.accountType,
      subType: MIGRATION_CLEARING_SUBTYPE,
      openingBalance: "0",
      active: true,
      isHidden: false,
    })
    .returning();
  if (!created) throw new AccountMigrationConflict("Could not create account-migration clearing account.");
  return created;
}

async function resolveAccountMigrationDatabaseScope(
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

async function applyAccountMigrationDatabaseScope(
  tx: AccountMigrationTransaction,
  scope: AccountMigrationDatabaseScope
): Promise<void> {
  await tx.execute(sql`SELECT
    set_config('app.company_scope_maintenance', 'off', true),
    set_config('app.current_company_id', ${String(scope.activeCompanyId)}, true),
    set_config('app.authorized_company_ids', ${scope.authorizedCompanyIds}, true)`);
}

async function lockCompanies(tx: AccountMigrationTransaction, sourceCompanyId: number, destinationCompanyId: number) {
  const ids = [sourceCompanyId, destinationCompanyId].sort((a, b) => a - b);
  for (const companyId of ids) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('account-migration'), ${companyId})`);
  }
}

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
    seen.add(current.cause);
    current = asPgError(current.cause);
  }
  return current;
}

function respondWithError(res: Response, error: unknown) {
  if (error instanceof DurableFinancialOperationError) {
    return res.status(financialOperationErrorStatus(error)).json({ message: error.message, code: error.code });
  }
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

function savedMigration(value: unknown): SavedMigration | null {
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
  if (item.version === 2 && !Array.isArray(item.splitVouchers)) return null;
  return item as SavedMigration;
}

function baseAmount(value: string | null | undefined): string {
  const parsed = Number(value ?? 0);
  return (Number.isFinite(parsed) ? parsed : 0).toFixed(6);
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
        const databaseScope = await resolveAccountMigrationDatabaseScope(req, srcCompanyId, destCompanyId);
        const operationKey = resolveFinancialOperationKey(req);
        const operation = await withDurableFinancialOperation(
          {
            companyId: srcCompanyId,
            operationName: "account-migration.execute",
            idempotencyKey: operationKey,
            requestFingerprint: financialOperationFingerprint({
              method: req.method,
              path: req.path,
              companyId: srcCompanyId,
              body: financialOperationRequestPayload(req.body),
            }),
          },
          async (tx) => {
            await applyAccountMigrationDatabaseScope(tx, databaseScope);
            await lockCompanies(tx, srcCompanyId, destCompanyId);

            const companyRows = await tx
              .select({ id: companies.id, code: companies.code, name: companies.name })
              .from(companies)
              .where(inArray(companies.id, [srcCompanyId, destCompanyId]));
            if (companyRows.length !== 2) {
              throw new AccountMigrationConflict("Source or destination company no longer exists.", 404);
            }
            const sourceCompany = companyRows.find((company) => company.id === srcCompanyId)!;
            const destinationCompany = companyRows.find((company) => company.id === destCompanyId)!;

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
              .select()
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

            const accountPlans = accountIds.map((accountId) => {
              const account = sourceById.get(accountId)!;
              return {
                account,
                originalCode: account.code,
                finalCode: uniqueDestinationCode(account.code, occupiedCodes),
                entryCount: entryCount.get(accountId) ?? 0,
                touchedVoucherIds: [...(voucherIdsByAccount.get(accountId) ?? new Set<number>())],
              };
            });

            const touchedVoucherIds = [...new Set(accountPlans.flatMap((plan) => plan.touchedVoucherIds))];
            const selectedAccountSet = new Set(accountIds);
            const migrationId = randomUUID();
            let exclusiveVoucherIds: number[] = [];
            const splitSnapshots: SplitVoucherSnapshot[] = [];

            if (touchedVoucherIds.length > 0) {
              const [touchedVoucherRows, touchedEntries] = await Promise.all([
                tx.select().from(vouchers).where(inArray(vouchers.id, touchedVoucherIds)),
                tx.select().from(voucherEntries).where(inArray(voucherEntries.voucherId, touchedVoucherIds)),
              ]);
              if (touchedVoucherRows.length !== touchedVoucherIds.length) {
                throw new AccountMigrationConflict(
                  "One or more historical vouchers no longer exist. Refresh and retry."
                );
              }
              const foreignVoucher = touchedVoucherRows.find((voucher) => voucher.companyId !== srcCompanyId);
              if (foreignVoucher) {
                throw new AccountMigrationConflict(
                  `Voucher ${foreignVoucher.voucherNumber} belongs to another company. This account contains history from an older cross-company migration; move it back to its original company before migrating it again.`
                );
              }
              const protectedVoucher = touchedVoucherRows.find((voucher) => voucherMutationBlockReason(voucher));
              if (protectedVoucher) {
                throw new AccountMigrationConflict(
                  `Voucher ${protectedVoucher.voucherNumber} ${voucherMutationBlockReason(protectedVoucher)}`
                );
              }

              const entriesByVoucher = new Map<number, MigrationEntryLike[]>();
              for (const entry of touchedEntries) {
                const rows = entriesByVoucher.get(entry.voucherId) ?? [];
                rows.push(entry);
                entriesByVoucher.set(entry.voucherId, rows);
              }
              const voucherById = new Map(touchedVoucherRows.map((voucher) => [voucher.id, voucher]));
              const voucherPlans = touchedVoucherIds.map((voucherId) => {
                const plan = buildMigrationVoucherPlan(
                  voucherId,
                  entriesByVoucher.get(voucherId) ?? [],
                  selectedAccountSet
                );
                const sourceVoucher = voucherById.get(voucherId)!;
                return {
                  plan,
                  sourceVoucher,
                  moveIntact: plan.isExclusive && !voucherMutationBlockReason(sourceVoucher),
                };
              });
              exclusiveVoucherIds = voucherPlans.filter((item) => item.moveIntact).map((item) => item.plan.voucherId);
              const sharedPlans = voucherPlans.filter((item) => !item.moveIntact);

              let sourceClearingAccountId: number | null = null;
              let destinationClearingAccountId: number | null = null;
              if (sharedPlans.length > 0) {
                const sourceClearing = await getOrCreateMigrationClearingAccount(tx, {
                  companyId: srcCompanyId,
                  code: migrationClearingCode("AM-TO", destinationCompany.code),
                  name: `Account Migration Clearing - ${destinationCompany.name}`,
                  accountType: "Asset",
                  selectedAccountIds: selectedAccountSet,
                });
                const destinationClearing = await getOrCreateMigrationClearingAccount(tx, {
                  companyId: destCompanyId,
                  code: migrationClearingCode("AM-FROM", sourceCompany.code),
                  name: `Account Migration Clearing - ${sourceCompany.name}`,
                  accountType: "Liability",
                  selectedAccountIds: selectedAccountSet,
                });
                sourceClearingAccountId = sourceClearing.id;
                destinationClearingAccountId = destinationClearing.id;
              }

              for (const item of sharedPlans) {
                if (sourceClearingAccountId === null || destinationClearingAccountId === null) {
                  throw new AccountMigrationConflict("Account-migration clearing accounts were not initialized.");
                }
                const { plan, sourceVoucher } = item;
                const voucherNumber = `AM-${migrationId.slice(0, 8)}-${sourceVoucher.id}`;
                const [destinationVoucher] = await tx
                  .insert(vouchers)
                  .values({
                    companyId: destCompanyId,
                    locationId: null,
                    locationName: sourceVoucher.locationName,
                    voucherNumber,
                    voucherType: "Journal",
                    voucherDate: sourceVoucher.voucherDate,
                    description: `Account migration from ${sourceCompany.name}: ${sourceVoucher.description || sourceVoucher.voucherNumber}`,
                    totalAmount: migrationDestinationTotal(plan),
                    currency: sourceVoucher.currency || "USD",
                    optional: false,
                    exchangeRate: sourceVoucher.exchangeRate,
                    sourceModule: "ERP",
                    isCreditSale: false,
                    effectiveDate: sourceVoucher.effectiveDate,
                  })
                  .returning({ id: vouchers.id });
                if (!destinationVoucher) {
                  throw new AccountMigrationConflict(
                    `Could not create destination history for ${sourceVoucher.voucherNumber}.`
                  );
                }

                if (plan.selectedEntries.length > 0) {
                  await tx.insert(voucherEntries).values(
                    plan.selectedEntries.map((entry) => ({
                      voucherId: destinationVoucher.id,
                      ledgerAccountId: entry.ledgerAccountId,
                      debitAmount: entry.debitAmount ?? "0",
                      creditAmount: entry.creditAmount ?? "0",
                      narration: entry.narration
                        ? `Moved from ${sourceVoucher.voucherNumber} - ${entry.narration}`
                        : `Moved from ${sourceVoucher.voucherNumber}`,
                      transactionCurrency: entry.transactionCurrency,
                      transactionDebitAmount: entry.transactionDebitAmount,
                      transactionCreditAmount: entry.transactionCreditAmount,
                      baseDebitAmount: entry.baseDebitAmount ?? baseAmount(entry.debitAmount),
                      baseCreditAmount: entry.baseCreditAmount ?? baseAmount(entry.creditAmount),
                      historicalExchangeRate: entry.historicalExchangeRate,
                      rateConvention: entry.rateConvention,
                    }))
                  );
                }

                const clearing = migrationClearingAmounts(plan);
                if (clearing) {
                  await tx.insert(voucherEntries).values({
                    voucherId: destinationVoucher.id,
                    ledgerAccountId: destinationClearingAccountId,
                    debitAmount: clearing.debitAmount,
                    creditAmount: clearing.creditAmount,
                    narration: `Account migration clearing for ${sourceVoucher.voucherNumber}`,
                    transactionCurrency: "USD",
                    transactionDebitAmount: baseAmount(clearing.debitAmount),
                    transactionCreditAmount: baseAmount(clearing.creditAmount),
                    baseDebitAmount: baseAmount(clearing.debitAmount),
                    baseCreditAmount: baseAmount(clearing.creditAmount),
                    historicalExchangeRate: "1.0000000000",
                    rateConvention: "IDENTITY",
                  });
                }

                const remappedEntries = plan.selectedEntries.map((entry) => ({
                  entryId: entry.id,
                  originalLedgerAccountId: entry.ledgerAccountId!,
                }));
                if (remappedEntries.length > 0) {
                  await tx
                    .update(voucherEntries)
                    .set({ ledgerAccountId: sourceClearingAccountId })
                    .where(
                      inArray(
                        voucherEntries.id,
                        remappedEntries.map((entry) => entry.entryId)
                      )
                    );
                }
                splitSnapshots.push({
                  sourceVoucherId: sourceVoucher.id,
                  destinationVoucherId: destinationVoucher.id,
                  sourceClearingAccountId,
                  remappedEntries,
                });
              }
            }

            const controls = await detachAccountMigrationControlReferences(tx, srcCompanyId, accountIds);

            for (const plan of accountPlans) {
              await tx
                .update(ledgerAccounts)
                .set({ companyId: destCompanyId, code: plan.finalCode, parentId: null })
                .where(and(eq(ledgerAccounts.id, plan.account.id), eq(ledgerAccounts.companyId, srcCompanyId)));
            }
            if (exclusiveVoucherIds.length > 0) {
              await tx
                .update(vouchers)
                .set({ companyId: destCompanyId })
                .where(and(eq(vouchers.companyId, srcCompanyId), inArray(vouchers.id, exclusiveVoucherIds)));
            }

            const changes: SavedMigrationV2 = {
              version: 2,
              migrationId,
              srcCompanyId,
              destCompanyId,
              accountIds,
              movedVoucherIds: exclusiveVoucherIds,
              accounts: accountPlans.map((plan) => ({
                accountId: plan.account.id,
                originalCode: plan.originalCode,
                finalCode: plan.finalCode,
              })),
              controls,
              splitVouchers: splitSnapshots,
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
              value: {
                success: true,
                migrationId,
                srcCompanyId,
                destCompanyId,
                totalEntries: accountPlans.reduce((sum, plan) => sum + plan.entryCount, 0),
                movedVoucherIds: exclusiveVoucherIds,
                movedVoucherCount: exclusiveVoucherIds.length + splitSnapshots.length,
                sharedVoucherCount: splitSnapshots.length,
                splitVoucherCount: splitSnapshots.length,
                detachedRoleCashAccountCount: controls.roleCashAccounts.length,
                detachedLocationCashAccountCount: controls.locationCashAccounts.length,
                accounts: accountPlans.map((plan) => ({
                  accountId: plan.account.id,
                  accountName: plan.account.name,
                  originalCode: plan.originalCode,
                  finalCode: plan.finalCode,
                  entryCount: plan.entryCount,
                  wasRenamed: plan.originalCode !== plan.finalCode,
                })),
              },
              resultReference: migrationId,
            };
          }
        );
        const result = operation.value;

        logger.info("[AccountMigration] Safe migration completed", {
          migrationId: result.migrationId,
          accountCount: result.accounts.length,
          movedVoucherCount: result.movedVoucherCount,
          splitVoucherCount: result.splitVoucherCount,
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
        const databaseScope = await resolveAccountMigrationDatabaseScope(req, srcCompanyId, destCompanyId);
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
          await applyAccountMigrationDatabaseScope(tx, databaseScope);
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

          if (saved.version === 2) {
            for (const split of saved.splitVouchers) {
              if (split.remappedEntries.length > 0) {
                const currentRows = await tx
                  .select({ id: voucherEntries.id, ledgerAccountId: voucherEntries.ledgerAccountId })
                  .from(voucherEntries)
                  .where(
                    inArray(
                      voucherEntries.id,
                      split.remappedEntries.map((entry) => entry.entryId)
                    )
                  );
                if (
                  currentRows.length !== split.remappedEntries.length ||
                  currentRows.some((entry) => entry.ledgerAccountId !== split.sourceClearingAccountId)
                ) {
                  throw new AccountMigrationConflict(
                    `Source voucher ${split.sourceVoucherId} changed after migration and cannot be undone automatically.`
                  );
                }
                for (const remapped of split.remappedEntries) {
                  await tx
                    .update(voucherEntries)
                    .set({ ledgerAccountId: remapped.originalLedgerAccountId })
                    .where(eq(voucherEntries.id, remapped.entryId));
                }
              }
              await tx
                .delete(vouchers)
                .where(and(eq(vouchers.id, split.destinationVoucherId), eq(vouchers.companyId, destCompanyId)));
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
              restoredSplitVoucherIds:
                saved.version === 2 ? saved.splitVouchers.map((item) => item.destinationVoucherId) : [],
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
