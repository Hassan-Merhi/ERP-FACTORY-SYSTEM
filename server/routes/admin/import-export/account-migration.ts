/**
 * importExportRoutes: AccountMigration endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { storage } from "../../../storage";
import { requireAuth, requireRole } from "../../../auth";
import { vouchers, voucherEntries, ledgerAccounts } from "@shared/schema";
import { eq, and, inArray } from "drizzle-orm";

export function registerAccountMigrationRoutes(app: Express) {
  // List all companies (for source/destination pickers)
  app.get(
    "/api/admin/account-migration/companies",
    requireAuth,
    requireRole("Admin", "Developer"),
    async (req: Request, res: Response) => {
      try {
        const all = await storage.getAllCompanies();
        res.json(all);
      } catch (error: unknown) {
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  // List ledger accounts in a company
  app.get(
    "/api/admin/account-migration/accounts/:companyId",
    requireAuth,
    requireRole("Admin", "Developer"),
    async (req: Request, res: Response) => {
      try {
        const companyId = parseInt(req.params.companyId);
        if (isNaN(companyId)) return res.status(400).json({ message: "Invalid companyId" });
        const accounts = await storage.getAllLedgerAccounts(companyId, true);
        res.json(accounts);
      } catch (error: unknown) {
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  // Preview a batch migration — accepts accountIds array
  app.post(
    "/api/admin/account-migration/preview",
    requireAuth,
    requireRole("Admin", "Developer"),
    async (req: Request, res: Response) => {
      try {
        const { accountIds, srcCompanyId, destCompanyId } = req.body;
        if (!Array.isArray(accountIds) || accountIds.length === 0 || !srcCompanyId || !destCompanyId)
          return res.status(400).json({ message: "accountIds (array), srcCompanyId and destCompanyId are required" });
        if (srcCompanyId === destCompanyId)
          return res.status(400).json({ message: "Source and destination must be different companies" });

        const batchSet = new Set<number>(accountIds);

        const accountPreviews = [];
        let grandTotalDebit = 0;
        let grandTotalCredit = 0;
        let grandTotalEntries = 0;

        for (const accountId of accountIds) {
          // Verify account belongs to source company
          const [account] = await db
            .select()
            .from(ledgerAccounts)
            .where(and(eq(ledgerAccounts.id, accountId), eq(ledgerAccounts.companyId, srcCompanyId)));
          if (!account) return res.status(404).json({ message: `Account ${accountId} not found in source company` });

          // Get all voucher entries for this account
          const entryRows = await db
            .select({
              voucherId: voucherEntries.voucherId,
              debit: voucherEntries.debitAmount,
              credit: voucherEntries.creditAmount,
            })
            .from(voucherEntries)
            .where(eq(voucherEntries.ledgerAccountId, accountId));

          const totalDebit = entryRows.reduce((s, r) => s + parseFloat(r.debit || "0"), 0);
          const totalCredit = entryRows.reduce((s, r) => s + parseFloat(r.credit || "0"), 0);
          grandTotalDebit += totalDebit;
          grandTotalCredit += totalCredit;
          grandTotalEntries += entryRows.length;

          const touchedVoucherIds = [...new Set(entryRows.map((r) => r.voucherId))];

          // A voucher is exclusive to the batch only if:
          //   • every ledger-account entry belongs to the migrated batch, AND
          //   • it has NO supplier entries (supplier balance must stay in source company), AND
          //   • it has NO employee entries (employee balance must stay in source company)
          let exclusiveVoucherCount = 0;
          let sharedVoucherCount = 0;
          for (const vid of touchedVoucherIds) {
            const allEntries = await db
              .select({
                la: voucherEntries.ledgerAccountId,
                supplierId: voucherEntries.supplierId,
                employeeId: voucherEntries.employeeId,
              })
              .from(voucherEntries)
              .where(eq(voucherEntries.voucherId, vid));
            const isShared = allEntries.some(
              (e) => e.supplierId !== null || e.employeeId !== null || (e.la !== null && !batchSet.has(e.la as number))
            );
            if (!isShared) exclusiveVoucherCount++;
            else sharedVoucherCount++;
          }

          // Check code conflict in destination
          const [codeConflict] = await db
            .select()
            .from(ledgerAccounts)
            .where(and(eq(ledgerAccounts.companyId, destCompanyId), eq(ledgerAccounts.code, account.code)));

          accountPreviews.push({
            account,
            entryCount: entryRows.length,
            totalDebit,
            totalCredit,
            touchedVoucherCount: touchedVoucherIds.length,
            exclusiveVoucherCount,
            sharedVoucherCount,
            codeConflict: codeConflict ? { id: codeConflict.id, name: codeConflict.name } : null,
          });
        }

        const srcCompany = await storage.getCompanyById(srcCompanyId);
        const destCompany = await storage.getCompanyById(destCompanyId);

        res.json({
          accounts: accountPreviews,
          srcCompany,
          destCompany,
          grandTotalEntries,
          grandTotalDebit,
          grandTotalCredit,
        });
      } catch (error: unknown) {
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  // Execute a batch migration — moves all accounts atomically in one transaction
  app.post(
    "/api/admin/account-migration/execute",
    requireAuth,
    requireRole("Admin", "Developer"),
    async (req: Request, res: Response) => {
      try {
        const { accountIds, srcCompanyId, destCompanyId } = req.body;
        if (!Array.isArray(accountIds) || accountIds.length === 0 || !srcCompanyId || !destCompanyId)
          return res.status(400).json({ message: "accountIds (array), srcCompanyId and destCompanyId are required" });
        if (srcCompanyId === destCompanyId)
          return res.status(400).json({ message: "Source and destination must be different companies" });

        const batchSet = new Set<number>(accountIds);

        // Build per-account plan (code conflict resolution + entry counts)
        const accountPlans: Array<{
          account: { id: number; companyId: number; code: string; name: string; accountType: string; subType: string | null; parentId: number | null; openingBalance: string | null; openingBalanceSide: string | null; openingBalanceNativeAmount: string | null; openingBalanceCurrency: string | null; openingBalanceHistoricalRate: string | null; openingBalanceBaseAmount: string | null; active: boolean; isHidden: boolean; deletedAt: Date | null; createdAt: Date; };
          originalCode: string;
          finalCode: string;
          entryCount: number;
          touchedVoucherIds: number[];
        }> = [];

        // Track ALL voucher IDs touched by ANY account in the batch
        const allTouchedVoucherIds = new Set<number>();

        for (const accountId of accountIds) {
          const [account] = await db
            .select()
            .from(ledgerAccounts)
            .where(and(eq(ledgerAccounts.id, accountId), eq(ledgerAccounts.companyId, srcCompanyId)));
          if (!account) return res.status(404).json({ message: `Account ${accountId} not found in source company` });

          // Auto-resolve code conflict with -MIGRATED suffix
          const [codeConflict] = await db
            .select()
            .from(ledgerAccounts)
            .where(and(eq(ledgerAccounts.companyId, destCompanyId), eq(ledgerAccounts.code, account.code)));
          const finalCode = codeConflict ? `${account.code}-MIGRATED` : account.code;

          const entryRows = await db
            .select({ voucherId: voucherEntries.voucherId })
            .from(voucherEntries)
            .where(eq(voucherEntries.ledgerAccountId, accountId));
          const touchedVoucherIds = [...new Set(entryRows.map((r) => r.voucherId))];
          touchedVoucherIds.forEach((v) => allTouchedVoucherIds.add(v));

          accountPlans.push({
            account,
            originalCode: account.code,
            finalCode,
            entryCount: entryRows.length,
            touchedVoucherIds,
          });
        }

        // Determine which vouchers are exclusive to this batch.
        // A voucher is exclusive only if ALL of the following are true:
        //   • every ledger-account entry belongs to the migrated batch
        //   • it has NO supplier entries (those must stay in the source company)
        //   • it has NO employee entries (those must stay in the source company)
        // Any voucher with a supplier or employee side is treated as "shared"
        // and left in the source company so balances stay correct on both sides.
        const exclusiveVoucherIds: number[] = [];
        for (const vid of allTouchedVoucherIds) {
          const allEntries = await db
            .select({
              la: voucherEntries.ledgerAccountId,
              supplierId: voucherEntries.supplierId,
              employeeId: voucherEntries.employeeId,
            })
            .from(voucherEntries)
            .where(eq(voucherEntries.voucherId, vid));
          const isShared = allEntries.some(
            (e) => e.supplierId !== null || e.employeeId !== null || (e.la !== null && !batchSet.has(e.la as number))
          );
          if (!isShared) exclusiveVoucherIds.push(vid);
        }

        // ── Execute everything in one atomic transaction ────────────────────────
        await db.transaction(async (tx) => {
          for (const plan of accountPlans) {
            await tx
              .update(ledgerAccounts)
              .set({ companyId: destCompanyId, code: plan.finalCode, parentId: null })
              .where(eq(ledgerAccounts.id, plan.account.id));
          }
          if (exclusiveVoucherIds.length > 0) {
            await tx
              .update(vouchers)
              .set({ companyId: destCompanyId })
              .where(inArray(vouchers.id, exclusiveVoucherIds));
          }
        });

        const sharedVoucherCount = allTouchedVoucherIds.size - exclusiveVoucherIds.length;
        const totalEntries = accountPlans.reduce((s, p) => s + p.entryCount, 0);

        logger.info(
          `[AccountMigration] Batch of ${accountIds.length} account(s) moved from company ${srcCompanyId} → ${destCompanyId}. ` +
            `${totalEntries} entries, ${exclusiveVoucherIds.length} vouchers moved, ${sharedVoucherCount} shared vouchers left in source.`
        );

        res.json({
          success: true,
          srcCompanyId,
          destCompanyId,
          totalEntries,
          movedVoucherIds: exclusiveVoucherIds,
          movedVoucherCount: exclusiveVoucherIds.length,
          sharedVoucherCount,
          accounts: accountPlans.map((p) => ({
            accountId: p.account.id,
            accountName: p.account.name,
            originalCode: p.originalCode,
            finalCode: p.finalCode,
            entryCount: p.entryCount,
            wasRenamed: p.originalCode !== p.finalCode,
          })),
        });
      } catch (error: unknown) {
        logger.error("[AccountMigration] Error:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  // Undo a batch migration — moves all accounts back atomically
  app.post(
    "/api/admin/account-migration/undo",
    requireAuth,
    requireRole("Admin", "Developer"),
    async (req: Request, res: Response) => {
      try {
        const { accounts, movedVoucherIds, srcCompanyId, destCompanyId } = req.body;
        // accounts = [{ accountId, originalCode }]
        if (!Array.isArray(accounts) || accounts.length === 0 || !srcCompanyId || !destCompanyId)
          return res.status(400).json({ message: "accounts (array), srcCompanyId and destCompanyId are required" });

        // Sanity-check: all accounts should currently be in destCompany
        for (const a of accounts) {
          const [row] = await db
            .select({ id: ledgerAccounts.id })
            .from(ledgerAccounts)
            .where(and(eq(ledgerAccounts.id, a.accountId), eq(ledgerAccounts.companyId, destCompanyId)));
          if (!row)
            return res.status(404).json({
              message: `Account ${a.accountId} not found in destination company — it may have already been moved or re-migrated.`,
            });
        }

        await db.transaction(async (tx) => {
          for (const a of accounts) {
            await tx
              .update(ledgerAccounts)
              .set({ companyId: srcCompanyId, code: a.originalCode, parentId: null })
              .where(eq(ledgerAccounts.id, a.accountId));
          }
          if (Array.isArray(movedVoucherIds) && movedVoucherIds.length > 0) {
            await tx.update(vouchers).set({ companyId: srcCompanyId }).where(inArray(vouchers.id, movedVoucherIds));
          }
        });

        logger.info(
          `[AccountMigration] UNDO: ${accounts.length} account(s) moved back from company ${destCompanyId} → ${srcCompanyId}. ` +
            `${(movedVoucherIds ?? []).length} vouchers restored.`
        );

        res.json({
          success: true,
          restoredAccountCount: accounts.length,
          restoredVoucherCount: (movedVoucherIds ?? []).length,
        });
      } catch (error: unknown) {
        logger.error("[AccountMigration] Undo error:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  // ── Deployment migration diagnostics ────────────────────────────────────────
  // Returns counts (no sensitive data) useful for verifying a Render deploy.
}
