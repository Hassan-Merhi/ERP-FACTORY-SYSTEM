import type { Express } from "express";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import { requireAuth, requireRole } from "../../auth";
import { deleteInfrastructurePostingIdentityForVoucherTx } from "../../services/accounting/infrastructureVoucherIdentity";
import { auditLog, ledgerAccounts, voucherEntries, vouchers } from "@shared/schema";
import {
  assertDestinationControlReferencesAreClear,
  restoreAccountMigrationControlReferences,
} from "./accountMigrationControlReferences";
import {
  AccountMigrationConflict,
  EXECUTE_ACTION,
  UNDO_ACTION,
  applyAccountMigrationDatabaseScope,
  idArray,
  lockCompanies,
  positiveInt,
  registerAccountMigrationSafeRoutesPart1,
  resolveAccountMigrationDatabaseScope,
  respondWithError,
  sameIds,
  savedMigration,
} from "./registerAccountMigrationSafeRoutesPart1";
import { registerAccountMigrationSafeRoutesPart2 } from "./registerAccountMigrationSafeRoutesPart2";

export function registerAccountMigrationSafeRoutes(app: Express) {
  registerAccountMigrationSafeRoutesPart1(app);
  registerAccountMigrationSafeRoutesPart2(app);
  registerAccountMigrationSafeRoutesPart3(app);
}

function registerAccountMigrationSafeRoutesPart3(app: Express) {
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

          // The accounts return to the source company before their source lines
          // are re-pointed at them (see the ordering note in execute).
          for (const account of saved.accounts) {
            await tx
              .update(ledgerAccounts)
              .set({ companyId: srcCompanyId, code: account.originalCode, parentId: null })
              .where(and(eq(ledgerAccounts.id, account.accountId), eq(ledgerAccounts.companyId, destCompanyId)));
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
              await deleteInfrastructurePostingIdentityForVoucherTx(tx, split.destinationVoucherId);
              await tx
                .delete(vouchers)
                .where(and(eq(vouchers.id, split.destinationVoucherId), eq(vouchers.companyId, destCompanyId)));
            }
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
