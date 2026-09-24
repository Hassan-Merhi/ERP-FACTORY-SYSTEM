import { punctuationInsensitiveSearch } from "../../lib/searchNormalization";
/**
 * ledgerRoutesLegacy: LedgerAccountRead endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { db } from "../../db";
import { storage } from "../../storage";
import { requireAuth, requireNonPOS } from "../../auth";
import { ledgerAccounts, vouchers, voucherEntries } from "@shared/schema";
import { eq, and, or, asc, isNull, isNotNull } from "drizzle-orm";

export function registerLedgerAccountReadRoutes(app: Express) {
  app.get("/api/ledger-accounts", requireAuth, async (req, res) => {
    try {
      const { companyId, accountType, search, includeHidden } = req.query;
      const effectiveCompanyId = companyId ? parseInt(companyId as string) : req.session.currentCompanyId;

      if (!effectiveCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      // Picker consumers never need balances, audit timestamps or other account
      // metadata. Project the compact contract in SQL instead of fetching full
      // rows and trimming them later in the response bridge.
      if (req.query.profile === "picker") {
        const conditions = [
          eq(ledgerAccounts.companyId, effectiveCompanyId),
          isNull(ledgerAccounts.deletedAt),
        ];
        if (accountType && typeof accountType === "string" && accountType.trim()) {
          conditions.push(eq(ledgerAccounts.accountType, accountType.trim()));
        }
        if (search && typeof search === "string" && search.trim()) {
          const term = search.trim();
          const searchCondition = or(
            punctuationInsensitiveSearch(ledgerAccounts.name, term),
            punctuationInsensitiveSearch(ledgerAccounts.code, term)
          );
          if (searchCondition) conditions.push(searchCondition);
        }
        if (includeHidden !== "true") conditions.push(eq(ledgerAccounts.isHidden, false));

        const accounts = await db
          .select({
            id: ledgerAccounts.id,
            code: ledgerAccounts.code,
            name: ledgerAccounts.name,
            accountType: ledgerAccounts.accountType,
            subType: ledgerAccounts.subType,
            parentId: ledgerAccounts.parentId,
            active: ledgerAccounts.active,
            isHidden: ledgerAccounts.isHidden,
          })
          .from(ledgerAccounts)
          .where(and(...conditions))
          .orderBy(asc(ledgerAccounts.code));
        return res.json(accounts);
      }

      let accounts;
      if (accountType && typeof accountType === "string" && accountType.trim()) {
        // Push accountType filter to SQL — avoids fetching all accounts then
        // discarding most of them in JS (e.g. 8 Cash accounts out of 400 total).
        const conditions = [
          eq(ledgerAccounts.companyId, effectiveCompanyId),
          isNull(ledgerAccounts.deletedAt),
          eq(ledgerAccounts.accountType, accountType.trim()),
        ];
        if (includeHidden !== "true") conditions.push(eq(ledgerAccounts.isHidden, false));
        accounts = await db
          .select()
          .from(ledgerAccounts)
          .where(and(...conditions))
          .orderBy(asc(ledgerAccounts.code));
      } else if (search && typeof search === "string" && search.trim()) {
        const term = search.trim();
        const searchConds = [
          eq(ledgerAccounts.companyId, effectiveCompanyId),
          isNull(ledgerAccounts.deletedAt),
          or(
            punctuationInsensitiveSearch(ledgerAccounts.name, term),
            punctuationInsensitiveSearch(ledgerAccounts.code, term)
          ),
        ];
        if (includeHidden !== "true") searchConds.push(eq(ledgerAccounts.isHidden, false));
        accounts = await db
          .select()
          .from(ledgerAccounts)
          .where(and(...searchConds))
          .orderBy(asc(ledgerAccounts.code));
      } else {
        accounts = await storage.getAllLedgerAccounts(effectiveCompanyId, includeHidden === "true");
      }
      res.json(accounts);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Get all "empty" ledger accounts (no entries, zero OB, no children)
  // Must be registered BEFORE /:id so Express doesn't swallow "empty" as an id param.
  app.get("/api/ledger-accounts/empty", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const allAccounts = await db
        .select()
        .from(ledgerAccounts)
        .where(and(eq(ledgerAccounts.companyId, companyId), isNull(ledgerAccounts.deletedAt)));

      const accountIds = allAccounts.map((a) => a.id);
      if (accountIds.length === 0) return res.json([]);

      // Accounts that have any voucher entries — scoped to this company only
      // The innerJoin on vouchers with companyId already scopes to this company's accounts;
      // the inArray is redundant since all accounts belong to this company.
      const usedInEntries = await db
        .selectDistinct({ accountId: voucherEntries.ledgerAccountId })
        .from(voucherEntries)
        .innerJoin(vouchers, eq(voucherEntries.voucherId, vouchers.id))
        .where(and(isNotNull(voucherEntries.ledgerAccountId), eq(vouchers.companyId, companyId)));
      const usedIds = new Set(usedInEntries.map((r) => r.accountId));

      // Accounts that are parents to other accounts
      const parentIds = new Set(allAccounts.filter((a) => a.parentId !== null).map((a) => a.parentId as number));

      const empty = allAccounts.filter((a) => {
        if (usedIds.has(a.id)) return false;
        if (parentIds.has(a.id)) return false;
        const ob = parseFloat(a.openingBalance || "0");
        if (Math.abs(ob) > 0.001) return false;
        return true;
      });

      res.json(empty);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/ledger-accounts/:id", requireAuth, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const accountId = parseInt(req.params.id);
      if (isNaN(accountId)) {
        return res.status(400).json({ message: "Invalid ledger account ID" });
      }

      const account = await storage.getLedgerAccountById(accountId);
      if (!account) {
        return res.status(404).json({ message: "Ledger account not found" });
      }

      // Verify account belongs to current company
      if (account.companyId !== req.session.currentCompanyId) {
        return res.status(404).json({ message: "Ledger account not found" });
      }

      res.json(account);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
