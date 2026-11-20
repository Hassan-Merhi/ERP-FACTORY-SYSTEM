/**
 * accountRoutes: AccountLedgerList endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "../../db";
import { ledgerAccounts } from "@shared/schema";
import { ledgerPostingLeafCondition } from "../../services/accounting/postableLedgerAccountPolicy";
import { requireAuth } from "../../auth";

export function registerAccountLedgerListRoutes(app: Express) {
  // Lightweight ledger-accounts list (id, code, name) — used by dashboard payable-account selector.
  app.get("/api/accounts/all-ledger", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const accounts = await db
        .select()
        .from(ledgerAccounts)
        .where(
          and(
            eq(ledgerAccounts.companyId, companyId),
            isNull(ledgerAccounts.deletedAt),
            eq(ledgerAccounts.isHidden, false),
            ledgerPostingLeafCondition(companyId)
          )
        )
        .orderBy(asc(ledgerAccounts.code));
      res.json(
        accounts.map((acc) => ({
          id: acc.id,
          accountId: acc.id,
          code: acc.code || "",
          name: acc.name,
          balance: 0,
        }))
      );
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // 30-second TTL cache for voucher-sidebar results (keyed by companyId).
  // The sidebar shows aggregate balances; stale data for 30 s is acceptable because
  // TanStack Query on the client invalidates this query after every voucher mutation.
}
