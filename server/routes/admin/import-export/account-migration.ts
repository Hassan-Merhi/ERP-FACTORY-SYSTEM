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
import { eq, and, inArray, sql } from "drizzle-orm";
import {
  assertCompaniesAccess,
  CompanyAccessError,
  getCompanyAccessContext,
} from "../../../security/companyAccessBoundary";
import { plusMoney } from "../../../lib/money";

class AccountMigrationPreviewNotFound extends Error {}

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

        const context = getCompanyAccessContext(req);
        await assertCompaniesAccess(context.userId, [srcCompanyId, destCompanyId]);
        const authorizedCompanyIds = [...new Set([srcCompanyId, destCompanyId])]
          .sort((left, right) => left - right)
          .join(",");

        const preview = await db.transaction(async (tx) => {
          // Preview is intentionally cross-company. The global tenant boundary
          // validates src/dest membership, but ordinary request scope remains
          // pinned to the active company. Establish the same explicit database
          // scope used by safe execute so source ledgers and destination
          // conflicts are visible without enabling maintenance bypass.
          await tx.execute(sql`SELECT
            set_config('app.company_scope_maintenance', 'off', true),
            set_config('app.current_company_id', ${String(context.activeCompanyId)}, true),
            set_config('app.authorized_company_ids', ${authorizedCompanyIds}, true)`);

          const batchSet = new Set<number>(accountIds);
          const accountPreviews = [];
          let grandTotalDebit = 0;
          let grandTotalCredit = 0;
          let grandTotalEntries = 0;

          for (const accountId of accountIds) {
            // Verify account belongs to source company
            const [account] = await tx
              .select()
              .from(ledgerAccounts)
              .where(and(eq(ledgerAccounts.id, accountId), eq(ledgerAccounts.companyId, srcCompanyId)));
            if (!account) {
              throw new AccountMigrationPreviewNotFound(`Account ${accountId} not found in source company`);
            }

            // Get all voucher entries for this account
            const entryRows = await tx
              .select({
                voucherId: voucherEntries.voucherId,
                debit: voucherEntries.debitAmount,
                credit: voucherEntries.creditAmount,
              })
              .from(voucherEntries)
              .where(eq(voucherEntries.ledgerAccountId, accountId));

            const totalDebit = entryRows.reduce((s, r) => plusMoney(s, r.debit), 0);
            const totalCredit = entryRows.reduce((s, r) => plusMoney(s, r.credit), 0);
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
              const allEntries = await tx
                .select({
                  la: voucherEntries.ledgerAccountId,
                  supplierId: voucherEntries.supplierId,
                  employeeId: voucherEntries.employeeId,
                })
                .from(voucherEntries)
                .where(eq(voucherEntries.voucherId, vid));
              const isShared = allEntries.some(
                (e) =>
                  e.supplierId !== null || e.employeeId !== null || (e.la !== null && !batchSet.has(e.la as number))
              );
              if (!isShared) exclusiveVoucherCount++;
              else sharedVoucherCount++;
            }

            // Check code conflict in destination
            const [codeConflict] = await tx
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

          return { accountPreviews, grandTotalDebit, grandTotalCredit, grandTotalEntries };
        });

        const srcCompany = await storage.getCompanyById(srcCompanyId);
        const destCompany = await storage.getCompanyById(destCompanyId);

        res.json({
          accounts: preview.accountPreviews,
          srcCompany,
          destCompany,
          grandTotalEntries: preview.grandTotalEntries,
          grandTotalDebit: preview.grandTotalDebit,
          grandTotalCredit: preview.grandTotalCredit,
        });
      } catch (error: unknown) {
        if (error instanceof CompanyAccessError) {
          return res.status(error.status).json({ message: error.message, code: error.code });
        }
        if (error instanceof AccountMigrationPreviewNotFound) {
          return res.status(404).json({ message: error.message });
        }
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
