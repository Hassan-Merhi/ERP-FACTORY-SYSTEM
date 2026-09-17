import type { Express, NextFunction, Request, Response } from "express";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db";
import { requireAuth, requireRole } from "../../auth";
import { logger } from "../../lib/logger";
import {
  READONLY_MIGRATED_VOUCHER_MESSAGE,
  isGoldenCoastProgrammeVoucher,
  voucherMutationBlockReason,
} from "../../lib/migratedVoucherGuard";
import {
  infrastructurePostingIdentity,
  insertInfrastructureVoucherTx,
} from "../../services/accounting/infrastructureVoucherIdentity";
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

class AccountMigrationRoundTripConflict extends Error {
  readonly status: number;

  constructor(message: string, status = 409) {
    super(message);
    this.status = status;
  }
}

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

function baseAmount(value: string | null | undefined): string {
  const parsed = Number(value ?? 0);
  return (Number.isFinite(parsed) ? parsed : 0).toFixed(6);
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
      isHidden: false,
    })
    .returning();
  if (!created) throw new AccountMigrationRoundTripConflict("Could not create account-migration clearing account.");
  return created;
}

async function applyDatabaseScope(
  tx: AccountMigrationTransaction,
  activeCompanyId: number,
  authorizedCompanyIds: string
): Promise<void> {
  await tx.execute(sql`SELECT
    set_config('app.company_scope_maintenance', 'off', true),
    set_config('app.current_company_id', ${String(activeCompanyId)}, true),
    set_config('app.authorized_company_ids', ${authorizedCompanyIds}, true)`);
}

async function lockCompanies(tx: AccountMigrationTransaction, companyA: number, companyB: number): Promise<void> {
  const ids = [companyA, companyB].sort((a, b) => a - b);
  for (const companyId of ids) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('account-migration'), ${companyId})`);
  }
}

function respondWithError(res: Response, error: unknown) {
  if (error instanceof CompanyAccessError) {
    return res.status(error.status).json({ message: error.message, code: error.code });
  }
  if (error instanceof AccountMigrationRoundTripConflict) {
    return res.status(error.status).json({ message: error.message });
  }
  logger.error("[AccountMigration] Round-trip return failed", { error });
  return res.status(500).json({ message: error instanceof Error ? error.message : "Account return migration failed" });
}

async function findMatchingMigration(
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

/**
 * Intercepts the normal account-migration undo only when the account received
 * new destination-company accounting activity after it was migrated.
 *
 * A literal undo is only safe before new activity exists. Once the user posts a
 * transaction in the temporary company, moving only the original vouchers back
 * leaves that new voucher pointing at an account owned by another company. That
 * is the cross-company history condition that previously produced zero/wrong
 * balances and read-only history on the next migration.
 *
 * In that case we perform a real reverse migration of the account's CURRENT
 * history. Exclusive vouchers move intact; shared vouchers are split through
 * clearing accounts, exactly like the safe forward migration. This makes the
 * supported workflow:
 *   Properties -> LSHI -> post transaction -> Move Back -> Properties.
 */
export function registerAccountMigrationRoundTripRoutes(app: Express) {
  app.post(
    "/api/admin/account-migration/undo",
    requireAuth,
    requireRole("Admin", "Developer"),
    async (req: Request, res: Response, next: NextFunction) => {
      const accountIds = idArray(
        Array.isArray(req.body?.accounts)
          ? req.body.accounts.map((account: { accountId?: unknown } | null | undefined) => account?.accountId)
          : null
      );
      const movedVoucherIds = idArray(req.body?.movedVoucherIds, true);
      const srcCompanyId = positiveInt(req.body?.srcCompanyId);
      const destCompanyId = positiveInt(req.body?.destCompanyId);
      if (!accountIds || !movedVoucherIds || !srcCompanyId || !destCompanyId) return next();

      try {
        const saved = await findMatchingMigration(srcCompanyId, destCompanyId, accountIds, movedVoucherIds);
        if (!saved) return next();

        const currentAccounts = await db
          .select({ id: ledgerAccounts.id, companyId: ledgerAccounts.companyId })
          .from(ledgerAccounts)
          .where(inArray(ledgerAccounts.id, accountIds));
        if (
          currentAccounts.length !== accountIds.length ||
          currentAccounts.some((account) => account.companyId !== destCompanyId)
        ) {
          return next();
        }

        const linkedEntries = await db
          .select({ voucherId: voucherEntries.voucherId })
          .from(voucherEntries)
          .where(inArray(voucherEntries.ledgerAccountId, accountIds));
        const currentVoucherIds = [...new Set(linkedEntries.map((entry) => entry.voucherId))];
        const originalDestinationVoucherIds = new Set<number>([
          ...saved.movedVoucherIds,
          ...(saved.version === 2 ? (saved.splitVouchers ?? []).map((item) => item.destinationVoucherId) : []),
        ]);
        const postMigrationVoucherIds = currentVoucherIds.filter((id) => !originalDestinationVoucherIds.has(id));

        // No new destination-company transaction exists: let the exact legacy
        // undo restore the original split vouchers byte-for-byte.
        if (postMigrationVoucherIds.length === 0) return next();

        const context = getCompanyAccessContext(req);
        await assertCompaniesAccess(context.userId, [srcCompanyId, destCompanyId]);
        const authorizedCompanyIds = [...new Set([srcCompanyId, destCompanyId])].sort((a, b) => a - b).join(",");

        const result = await db.transaction(async (tx) => {
          await applyDatabaseScope(tx, context.activeCompanyId, authorizedCompanyIds);
          await lockCompanies(tx, srcCompanyId, destCompanyId);

          const [alreadyUndone] = await tx
            .select({ id: auditLog.id })
            .from(auditLog)
            .where(and(eq(auditLog.action, UNDO_ACTION), eq(auditLog.recordIdentifier, saved.migrationId)))
            .limit(1);
          if (alreadyUndone) {
            throw new AccountMigrationRoundTripConflict("This migration has already been moved back.");
          }

          const accountRows = await tx
            .select()
            .from(ledgerAccounts)
            .where(and(eq(ledgerAccounts.companyId, destCompanyId), inArray(ledgerAccounts.id, accountIds)));
          if (accountRows.length !== accountIds.length) {
            throw new AccountMigrationRoundTripConflict(
              "One or more accounts are no longer in the temporary destination company. Refresh and retry."
            );
          }

          const companyRows = await tx
            .select({ id: companies.id, code: companies.code, name: companies.name })
            .from(companies)
            .where(inArray(companies.id, [srcCompanyId, destCompanyId]));
          if (companyRows.length !== 2) {
            throw new AccountMigrationRoundTripConflict("Source or destination company no longer exists.", 404);
          }
          const originalCompany = companyRows.find((company) => company.id === srcCompanyId)!;
          const temporaryCompany = companyRows.find((company) => company.id === destCompanyId)!;

          await assertDestinationControlReferencesAreClear(tx, srcCompanyId, accountIds);

          const originalCodes = await tx
            .select({ id: ledgerAccounts.id, code: ledgerAccounts.code })
            .from(ledgerAccounts)
            .where(eq(ledgerAccounts.companyId, srcCompanyId));
          const codeOwners = new Map(originalCodes.map((account) => [account.code, account.id]));
          for (const account of saved.accounts) {
            const owner = codeOwners.get(account.originalCode);
            if (owner !== undefined && owner !== account.accountId) {
              throw new AccountMigrationRoundTripConflict(
                `Another ${originalCompany.name} account now uses code ${account.originalCode}.`
              );
            }
          }

          const selectedEntries = await tx
            .select()
            .from(voucherEntries)
            .where(inArray(voucherEntries.ledgerAccountId, accountIds));
          const touchedVoucherIds = [...new Set(selectedEntries.map((entry) => entry.voucherId))];
          const selectedAccountSet = new Set(accountIds);
          const movedBackVoucherIds: number[] = [];
          const splitBackVoucherIds: number[] = [];

          if (touchedVoucherIds.length > 0) {
            const [voucherRows, allEntries] = await Promise.all([
              tx.select().from(vouchers).where(inArray(vouchers.id, touchedVoucherIds)),
              tx.select().from(voucherEntries).where(inArray(voucherEntries.voucherId, touchedVoucherIds)),
            ]);
            if (voucherRows.length !== touchedVoucherIds.length) {
              throw new AccountMigrationRoundTripConflict("One or more account vouchers no longer exist.");
            }
            const foreignVoucher = voucherRows.find((voucher) => voucher.companyId !== destCompanyId);
            if (foreignVoucher) {
              throw new AccountMigrationRoundTripConflict(
                `Voucher ${foreignVoucher.voucherNumber} does not belong to ${temporaryCompany.name}. ` +
                  "The account already contains cross-company history and needs reconciliation before moving back."
              );
            }
            const protectedVoucher = voucherRows.find((voucher) => isGoldenCoastProgrammeVoucher(voucher));
            if (protectedVoucher) {
              throw new AccountMigrationRoundTripConflict(
                `Voucher ${protectedVoucher.voucherNumber} is controlled by the Golden Coast accounting programme and cannot be moved by account migration.`
              );
            }

            const entriesByVoucher = new Map<number, MigrationEntryLike[]>();
            for (const entry of allEntries) {
              const rows = entriesByVoucher.get(entry.voucherId) ?? [];
              rows.push(entry);
              entriesByVoucher.set(entry.voucherId, rows);
            }
            const voucherById = new Map(voucherRows.map((voucher) => [voucher.id, voucher]));
            const voucherPlans = touchedVoucherIds.map((voucherId) => {
              const plan = buildMigrationVoucherPlan(
                voucherId,
                entriesByVoucher.get(voucherId) ?? [],
                selectedAccountSet
              );
              const sourceVoucher = voucherById.get(voucherId)!;
              const mutationReason = voucherMutationBlockReason(sourceVoucher);
              return {
                plan,
                sourceVoucher,
                moveIntact: plan.isExclusive && mutationReason !== READONLY_MIGRATED_VOUCHER_MESSAGE,
              };
            });

            const intactPlans = voucherPlans.filter((item) => item.moveIntact);
            const sharedPlans = voucherPlans.filter((item) => !item.moveIntact);
            movedBackVoucherIds.push(...intactPlans.map((item) => item.plan.voucherId));

            let temporaryClearingAccountId: number | null = null;
            let originalClearingAccountId: number | null = null;
            if (sharedPlans.length > 0) {
              const temporaryClearing = await getOrCreateMigrationClearingAccount(tx, {
                companyId: destCompanyId,
                code: migrationClearingCode("AM-TO", originalCompany.code),
                name: `Account Migration Clearing - ${originalCompany.name}`,
                accountType: "Asset",
                selectedAccountIds: selectedAccountSet,
              });
              const originalClearing = await getOrCreateMigrationClearingAccount(tx, {
                companyId: srcCompanyId,
                code: migrationClearingCode("AM-FROM", temporaryCompany.code),
                name: `Account Migration Clearing - ${temporaryCompany.name}`,
                accountType: "Liability",
                selectedAccountIds: selectedAccountSet,
              });
              temporaryClearingAccountId = temporaryClearing.id;
              originalClearingAccountId = originalClearing.id;
            }

            for (const item of sharedPlans) {
              if (temporaryClearingAccountId === null || originalClearingAccountId === null) {
                throw new AccountMigrationRoundTripConflict(
                  "Account-migration clearing accounts were not initialized."
                );
              }
              const { plan, sourceVoucher } = item;
              const voucherNumber = `AMR-${saved.migrationId.slice(0, 8)}-${sourceVoucher.id}`;
              const identity = infrastructurePostingIdentity(
                "account-migration",
                `return:${saved.migrationId}:${sourceVoucher.id}`,
                "round-trip-voucher"
              );
              const { voucher: destinationVoucher } = await insertInfrastructureVoucherTx(
                tx,
                {
                  companyId: srcCompanyId,
                  locationId: null,
                  locationName: sourceVoucher.locationName,
                  voucherNumber,
                  voucherType: "Journal",
                  voucherDate: sourceVoucher.voucherDate,
                  description: /* data-business-value */ `Account migration return from ${temporaryCompany.name}: ${sourceVoucher.description || sourceVoucher.voucherNumber}`,
                  totalAmount: migrationDestinationTotal(plan),
                  currency: sourceVoucher.currency || "USD",
                  optional: false,
                  exchangeRate: sourceVoucher.exchangeRate,
                  sourceModule: "ERP",
                  isCreditSale: false,
                  effectiveDate: sourceVoucher.effectiveDate,
                },
                identity,
                {
                  selectedEntryIds: plan.selectedEntries.map((entry) => entry.id).sort((a, b) => a - b),
                  originalClearingAccountId,
                }
              );

              if (plan.selectedEntries.length > 0) {
                await tx.insert(voucherEntries).values(
                  plan.selectedEntries.map((entry) => ({
                    voucherId: destinationVoucher.id,
                    ledgerAccountId: entry.ledgerAccountId,
                    debitAmount: entry.debitAmount ?? "0",
                    creditAmount: entry.creditAmount ?? "0",
                    narration: entry.narration
                      ? `Returned from ${sourceVoucher.voucherNumber} - ${entry.narration}`
                      : `Returned from ${sourceVoucher.voucherNumber}`,
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
                  ledgerAccountId: originalClearingAccountId,
                  debitAmount: clearing.debitAmount,
                  creditAmount: clearing.creditAmount,
                  narration: `Account migration return clearing for ${sourceVoucher.voucherNumber}`,
                  transactionCurrency: "USD",
                  transactionDebitAmount: baseAmount(clearing.debitAmount),
                  transactionCreditAmount: baseAmount(clearing.creditAmount),
                  baseDebitAmount: baseAmount(clearing.debitAmount),
                  baseCreditAmount: baseAmount(clearing.creditAmount),
                  historicalExchangeRate: "1.0000000000",
                  rateConvention: "IDENTITY",
                });
              }

              const selectedEntryIds = plan.selectedEntries.map((entry) => entry.id);
              if (selectedEntryIds.length > 0) {
                await tx
                  .update(voucherEntries)
                  .set({ ledgerAccountId: temporaryClearingAccountId })
                  .where(inArray(voucherEntries.id, selectedEntryIds));
              }
              splitBackVoucherIds.push(destinationVoucher.id);
            }
          }

          const temporaryControls = await detachAccountMigrationControlReferences(tx, destCompanyId, accountIds);

          for (const savedAccount of saved.accounts) {
            await tx
              .update(ledgerAccounts)
              .set({ companyId: srcCompanyId, code: savedAccount.originalCode, parentId: null })
              .where(and(eq(ledgerAccounts.id, savedAccount.accountId), eq(ledgerAccounts.companyId, destCompanyId)));
          }

          if (movedBackVoucherIds.length > 0) {
            await tx
              .update(vouchers)
              .set({ companyId: srcCompanyId })
              .where(and(eq(vouchers.companyId, destCompanyId), inArray(vouchers.id, movedBackVoucherIds)));
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
              mode: "round_trip_return",
              restoredAccountIds: accountIds,
              postMigrationVoucherIds,
              movedBackVoucherIds,
              splitBackVoucherIds,
              detachedTemporaryRoleCashAccounts: temporaryControls.roleCashAccounts.length,
              detachedTemporaryLocationCashAccounts: temporaryControls.locationCashAccounts.length,
              restoredOriginalRoleCashAccounts: saved.controls.roleCashAccounts.length,
              restoredOriginalLocationCashAccounts: saved.controls.locationCashAccounts.length,
            },
          });

          return {
            restoredAccountCount: accountIds.length,
            movedBackVoucherCount: movedBackVoucherIds.length,
            splitBackVoucherCount: splitBackVoucherIds.length,
          };
        });

        logger.info("[AccountMigration] Round-trip return completed", {
          migrationId: saved.migrationId,
          postMigrationVoucherCount: postMigrationVoucherIds.length,
          ...result,
        });

        return res.json({
          success: true,
          roundTrip: true,
          postMigrationVoucherCount: postMigrationVoucherIds.length,
          ...result,
        });
      } catch (error: unknown) {
        return respondWithError(res, error);
      }
    }
  );
}
