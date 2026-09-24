/**
 * ledgerRoutesLegacy: LedgerAccountDelete endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { db } from "../../db";
import { storage } from "../../storage";
import { requireAuth, requireRole, requireNonPOS } from "../../auth";
import { logAudit } from "../_helpers";
import { ledgerAccounts, voucherEntries } from "@shared/schema";
import { eq, and, inArray, isNull } from "drizzle-orm";

export function registerLedgerAccountDeleteRoutes(app: Express) {
  app.delete("/api/ledger-accounts/:id", requireAuth, requireNonPOS, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const accountId = parseInt(req.params.id);
      if (isNaN(accountId)) {
        return res.status(400).json({ message: "Invalid account ID" });
      }

      // Verify account exists and belongs to current company
      const existingAccount = await storage.getLedgerAccountById(accountId);
      if (!existingAccount) {
        return res.status(404).json({ message: "Account not found" });
      }
      if (existingAccount.companyId !== req.session.currentCompanyId) {
        return res.status(403).json({
          message: "Access denied: Account belongs to a different company",
        });
      }

      // Check if account is used in any voucher entries (scoped to this company)
      const entries = await storage.getVoucherEntriesByLedger(
        accountId,
        undefined,
        undefined,
        req.session.currentCompanyId
      );
      if (entries && entries.length > 0) {
        return res.status(400).json({
          message:
            "Cannot delete ledger account: It has been used in transactions. Please remove all related transactions first.",
        });
      }

      // Check if account is a parent to other accounts
      const allAccounts = await storage.getAllLedgerAccounts(req.session.currentCompanyId);
      const hasChildren = allAccounts.some((acc) => acc.parentId === accountId);
      if (hasChildren) {
        return res.status(400).json({
          message:
            "Cannot delete ledger account: It is a parent account. Please remove or reassign child accounts first.",
        });
      }

      await storage.deleteLedgerAccount(accountId);
      try {
        await logAudit({
          userId: req.session.userId!,
          username: req.session.username || "unknown",
          companyId: req.session.currentCompanyId!,
          action: "delete",
          tableName: "ledger_accounts",
          recordId: existingAccount.id,
          recordIdentifier: existingAccount.name,
          changes: {
            name: { old: existingAccount.name },
            code: { old: existingAccount.code },
            accountType: { old: existingAccount.accountType },
            subType: { old: existingAccount.subType || null },
            openingBalance: { old: existingAccount.openingBalance || "0" },
          },
        });
      } catch {
        /* non-fatal */
      }
      res.json({ message: "Ledger account deleted successfully" });
    } catch (error: unknown) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  // Bulk-delete empty ledger accounts
  app.post(
    "/api/ledger-accounts/bulk-delete",
    requireAuth,
    requireRole("Admin"),
    requireNonPOS,
    async (req, res) => {
      try {
        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const { accountIds } = req.body;
        if (!accountIds || !Array.isArray(accountIds) || accountIds.length === 0) {
          return res.status(400).json({ message: "No accounts provided" });
        }

        const allAccounts = await db
          .select()
          .from(ledgerAccounts)
          .where(and(eq(ledgerAccounts.companyId, companyId), isNull(ledgerAccounts.deletedAt)));
        const accountMap = new Map(allAccounts.map((a) => [a.id, a]));
        const allAccountIds = allAccounts.map((a) => a.id);

        // Get IDs that have entries
        const usedRows =
          allAccountIds.length > 0
            ? await db
                .selectDistinct({ accountId: voucherEntries.ledgerAccountId })
                .from(voucherEntries)
                .where(inArray(voucherEntries.ledgerAccountId, allAccountIds))
            : [];
        const usedIds = new Set(usedRows.map((r) => r.accountId));
        const parentIds = new Set(allAccounts.filter((a) => a.parentId !== null).map((a) => a.parentId as number));

        const deleted: number[] = [];
        const skipped: { id: number; reason: string }[] = [];

        for (const rawId of accountIds) {
          const id = parseInt(rawId);
          const account = accountMap.get(id);
          if (!account) {
            skipped.push({ id, reason: "Not found or wrong company" });
            continue;
          }
          if (usedIds.has(id)) {
            skipped.push({ id, reason: "Has voucher entries" });
            continue;
          }
          if (parentIds.has(id)) {
            skipped.push({ id, reason: "Is a parent account" });
            continue;
          }
          const ob = parseFloat(account.openingBalance || "0");
          if (Math.abs(ob) > 0.001) {
            skipped.push({ id, reason: "Has opening balance" });
            continue;
          }
          await storage.deleteLedgerAccount(id);
          deleted.push(id);
        }

        res.json({ deleted: deleted.length, skipped: skipped.length, skippedDetails: skipped });
      } catch (error: unknown) {
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}
