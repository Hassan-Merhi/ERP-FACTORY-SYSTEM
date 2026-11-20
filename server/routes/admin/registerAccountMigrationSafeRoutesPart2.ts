// Extracted from ./accountMigrationSafeRoutes.ts to keep that module under the source-size cap.
import { randomUUID } from "crypto";
import type { Express, Request, Response } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import { requireAuth, requireRole } from "../../auth";
import { validateRequest } from "../../lib/validateRequest";
import { executeAccountMigrationInput } from "./accountMigrationWriteSchemas";
import { logger } from "../../lib/logger";
import { toMoney } from "../../lib/money";
import { getPartyBalances } from "../../services/accounting/balances/ledgerBalanceEngine";
import {
  isGoldenCoastProgrammeVoucher,
  READONLY_MIGRATED_VOUCHER_MESSAGE,
  voucherMutationBlockReason,
} from "../../lib/migratedVoucherGuard";
import {
  infrastructurePostingIdentity,
  insertInfrastructureVoucherTx,
} from "../../services/accounting/infrastructureVoucherIdentity";
import { auditLog, companies, ledgerAccounts, voucherEntries, vouchers } from "@shared/schema";
import { detachAccountMigrationControlReferences } from "./accountMigrationControlReferences";
import {
  buildMigrationVoucherPlan,
  migrationClearingAmounts,
  migrationDestinationTotal,
  type MigrationEntryLike,
} from "./accountMigrationBalancePlan";
import {
  AccountMigrationConflict,
  EXECUTE_ACTION,
  applyAccountMigrationDatabaseScope,
  baseAmount,
  getOrCreateMigrationClearingAccount,
  idArray,
  lockCompanies,
  migrationClearingCode,
  positiveInt,
  resolveAccountMigrationDatabaseScope,
  respondWithError,
  uniqueDestinationCode,
  type SavedMigrationV2,
  type SplitVoucherSnapshot,
} from "./registerAccountMigrationSafeRoutesPart1";

export function registerAccountMigrationSafeRoutesPart2(app: Express) {
  app.post(
    "/api/admin/account-migration/execute",
    requireAuth,
    requireRole("Admin", "Developer"),
    validateRequest(executeAccountMigrationInput),
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
        const result = await db.transaction(async (tx) => {
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

          // Snapshot the same closing balances the statement/trial balance report.
          // Post-condition below runs before commit, so any difference rolls back
          // the entire migration rather than silently changing the user's balance.
          const sourcePartyBalances = await getPartyBalances(tx, {
            companyId: srcCompanyId,
            kind: "ledger",
            ids: accountIds,
          });
          const sourceClosingById = new Map(sourcePartyBalances.parties.map((party) => [party.id, party.closing]));
          for (const accountId of accountIds) {
            if (!sourceClosingById.has(accountId)) {
              throw new AccountMigrationConflict(
                `Account ${accountId} is owned by another balance dimension (such as a linked customer); migrate that owner separately.`
              );
            }
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
          const migrationIdentityAccountIds = [...accountIds].sort((left, right) => left - right).join(",");
          const migrationId = randomUUID();
          let exclusiveVoucherIds: number[] = [];
          const splitSnapshots: SplitVoucherSnapshot[] = [];

          // The accounts move to the destination company before any line is
          // written that references them there: the ledger integrity guard
          // checks each line against its account's company as it is written.
          for (const plan of accountPlans) {
            await tx
              .update(ledgerAccounts)
              .set({ companyId: destCompanyId, code: plan.finalCode, parentId: null })
              .where(and(eq(ledgerAccounts.id, plan.account.id), eq(ledgerAccounts.companyId, srcCompanyId)));
          }

          if (touchedVoucherIds.length > 0) {
            const [touchedVoucherRows, touchedEntries] = await Promise.all([
              tx.select().from(vouchers).where(inArray(vouchers.id, touchedVoucherIds)),
              tx.select().from(voucherEntries).where(inArray(voucherEntries.voucherId, touchedVoucherIds)),
            ]);
            if (touchedVoucherRows.length !== touchedVoucherIds.length) {
              throw new AccountMigrationConflict("One or more historical vouchers no longer exist. Refresh and retry.");
            }
            const foreignVoucher = touchedVoucherRows.find((voucher) => voucher.companyId !== srcCompanyId);
            if (foreignVoucher) {
              throw new AccountMigrationConflict(
                `Voucher ${foreignVoucher.voucherNumber} belongs to another company. This account contains history from an older cross-company migration; move it back to its original company before migrating it again.`
              );
            }
            const protectedVoucher = touchedVoucherRows.find((voucher) => isGoldenCoastProgrammeVoucher(voucher));
            if (protectedVoucher) {
              throw new AccountMigrationConflict(
                `Voucher ${protectedVoucher.voucherNumber} is controlled by the Golden Coast accounting programme and cannot be moved by account migration.`
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
              const mutationReason = voucherMutationBlockReason(sourceVoucher);
              return {
                plan,
                sourceVoucher,
                moveIntact: plan.isExclusive && mutationReason !== READONLY_MIGRATED_VOUCHER_MESSAGE,
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
              const sourceIdentity = infrastructurePostingIdentity(
                "account-migration",
                `${srcCompanyId}:${destCompanyId}:${migrationIdentityAccountIds}:${sourceVoucher.id}`,
                "shared-voucher"
              );
              const { voucher: destinationVoucher } = await insertInfrastructureVoucherTx(
                tx,
                {
                  companyId: destCompanyId,
                  locationId: null,
                  locationName: sourceVoucher.locationName,
                  voucherNumber,
                  voucherType: "Journal",
                  voucherDate: sourceVoucher.voucherDate,
                  description: /* data-business-value */ `Account migration from ${sourceCompany.name}: ${sourceVoucher.description || sourceVoucher.voucherNumber}`,
                  totalAmount: migrationDestinationTotal(plan),
                  currency: sourceVoucher.currency || "USD",
                  // Keep archived/optional history archived/optional after splitting.
                  // Making an excluded voucher live changes the receiving balance.
                  optional: sourceVoucher.optional ?? false,
                  deletedAt: sourceVoucher.deletedAt,
                  exchangeRate: sourceVoucher.exchangeRate,
                  sourceModule: "ERP",
                  isCreditSale: false,
                  effectiveDate: sourceVoucher.effectiveDate,
                },
                sourceIdentity,
                {
                  selectedEntryIds: plan.selectedEntries.map((entry) => entry.id).sort((left, right) => left - right),
                  destinationClearingAccountId,
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

          if (exclusiveVoucherIds.length > 0) {
            await tx
              .update(vouchers)
              .set({ companyId: destCompanyId })
              .where(and(eq(vouchers.companyId, srcCompanyId), inArray(vouchers.id, exclusiveVoucherIds)));
          }

          const destinationPartyBalances = await getPartyBalances(tx, {
            companyId: destCompanyId,
            kind: "ledger",
            ids: accountIds,
          });
          const destinationClosingById = new Map(
            destinationPartyBalances.parties.map((party) => [party.id, party.closing])
          );
          for (const accountId of accountIds) {
            const expected = sourceClosingById.get(accountId)!;
            const actual = destinationClosingById.get(accountId);
            if (actual === undefined || !toMoney(expected).eq(toMoney(actual))) {
              throw new AccountMigrationConflict(
                `Account ${accountId} closing-balance mismatch (source ${expected}, destination ${actual ?? "missing"}). No accounts or vouchers were moved.`
              );
            }
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
            success: true,
            migrationId,
            srcCompanyId,
            destCompanyId,
            totalEntries: accountPlans.reduce((sum, plan) => sum + plan.entryCount, 0),
            movedVoucherIds: exclusiveVoucherIds,
            movedVoucherCount: exclusiveVoucherIds.length + splitSnapshots.length,
            sharedVoucherCount: splitSnapshots.length,
            splitVoucherCount: splitSnapshots.length,
            balances: accountIds.map((accountId) => ({
              accountId,
              sourceClosing: sourceClosingById.get(accountId)!,
              destinationClosing: destinationClosingById.get(accountId)!,
            })),
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
          };
        });

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
}
