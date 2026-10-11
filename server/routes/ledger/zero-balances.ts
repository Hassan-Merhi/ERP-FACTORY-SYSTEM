/**
 * ledgerRoutesLegacy: LedgerZeroBalance endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 *
 * Wave 12: Owner only, one transaction, refused once the company has a closed
 * fiscal period (the opening-balance lock, services/accounting/openingBalanceLock.ts,
 * refuses the update itself; the route checks first to answer 409 before
 * touching anything), and audited inside the transaction with every account's
 * previous opening.
 */
import type { Express } from "express";
import { and, eq, inArray } from "drizzle-orm";

import { fiscalPeriodClosures, ledgerAccounts } from "@shared/schema";

import { requireAuth, requireRole } from "../../auth";
import { db } from "../../db";
import { closedPeriodErrorResponse } from "../../lib/closedPeriodError";
import { errorStatus, getErrorMessage } from "../../lib/httpHandlers";
import { writeAuditEvent } from "../../services/audit/auditService";

export const ZERO_BALANCES_AFTER_CLOSE_MESSAGE =
  "Opening balances cannot be zeroed after a fiscal period has been closed. Post an adjusting journal dated after the closed period instead.";

class ZeroBalancesRefusal extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export function registerLedgerZeroBalanceRoutes(app: Express) {
  // Zero opening balances for selected ledger accounts
  app.post("/api/ledger-accounts/zero-balances", requireAuth, requireRole("Owner"), async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const { accountIds } = req.body ?? {};
      if (!accountIds || !Array.isArray(accountIds) || accountIds.length === 0) {
        return res.status(400).json({ message: "No accounts selected" });
      }
      const requestedIds = [...new Set(accountIds.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
      if (requestedIds.length === 0) {
        return res.status(400).json({ message: "No valid accounts found" });
      }

      const count = await db.transaction(async (tx) => {
        const [closure] = await tx
          .select({ id: fiscalPeriodClosures.id })
          .from(fiscalPeriodClosures)
          .where(and(eq(fiscalPeriodClosures.companyId, companyId), eq(fiscalPeriodClosures.status, "CLOSED")))
          .limit(1);
        if (closure) throw new ZeroBalancesRefusal(409, ZERO_BALANCES_AFTER_CLOSE_MESSAGE);

        // Only this company's accounts, locked so the audited old values are the ones replaced.
        const accounts = await tx
          .select({
            id: ledgerAccounts.id,
            code: ledgerAccounts.code,
            name: ledgerAccounts.name,
            openingBalance: ledgerAccounts.openingBalance,
            openingBalanceSide: ledgerAccounts.openingBalanceSide,
          })
          .from(ledgerAccounts)
          .where(and(eq(ledgerAccounts.companyId, companyId), inArray(ledgerAccounts.id, requestedIds)))
          .for("update");
        if (accounts.length === 0) throw new ZeroBalancesRefusal(400, "No valid accounts found");

        await tx
          .update(ledgerAccounts)
          .set({ openingBalance: "0" })
          .where(
            and(
              eq(ledgerAccounts.companyId, companyId),
              inArray(
                ledgerAccounts.id,
                accounts.map((account) => account.id)
              )
            )
          );

        // Inside the transaction: the zeroing is refused if its audit cannot be written.
        await writeAuditEvent(
          {
            userId: req.session.userId,
            username: req.session.username || "unknown",
            companyId,
            action: "update",
            tableName: "ledger_accounts",
            recordId: null,
            recordIdentifier: "zero-opening-balances",
            changes: {
              openingBalances: {
                old: accounts.map((account) => ({
                  id: account.id,
                  code: account.code,
                  name: account.name,
                  openingBalance: account.openingBalance ?? "0",
                  openingBalanceSide: account.openingBalanceSide ?? null,
                })),
                new: accounts.map((account) => ({ id: account.id, openingBalance: "0" })),
              },
              accountCount: { new: accounts.length },
            },
          },
          tx
        );
        return accounts.length;
      });

      res.json({ message: `Opening balances zeroed for ${count} account(s)`, count });
    } catch (error: unknown) {
      if (error instanceof ZeroBalancesRefusal) {
        return res.status(error.status).json({ message: error.message });
      }
      const closedPeriod = closedPeriodErrorResponse(error);
      if (closedPeriod) return res.status(closedPeriod.status).json(closedPeriod.body);
      res.status(errorStatus(error, 400)).json({ message: getErrorMessage(error) });
    }
  });
}
