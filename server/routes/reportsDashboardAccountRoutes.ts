/**
 * Dashboard account-configuration routes.
 *
 * User-selected cash / payable accounts shown on the dashboard, plus the
 * per-type account-selection persistence. Extracted from reportsRoutes.ts
 * as a sub-registrar; behaviour is unchanged.
 */
import type { Express } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { and, eq, isNull, or } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { requireAuth } from "../auth";
import { debitMinusCredit, signedOpeningBalance } from "../lib/money";
import { dashboardAccountSelections, dashboardPayableAccounts, voucherEntries, vouchers } from "@shared/schema";
import { registerDashboardAccountRoutesPart1 } from "./registerDashboardAccountRoutesPart1";

export function registerDashboardAccountRoutes(app: Express) {
  registerDashboardAccountRoutesPart1(app);
  registerDashboardAccountRoutesPart2(app);
}

function registerDashboardAccountRoutesPart2(app: Express) {
  // Reorder dashboard payable accounts
  app.patch("/api/dashboard-payable-accounts/reorder", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const { orderedIds } = req.body as { orderedIds: number[] };
      if (!Array.isArray(orderedIds)) return res.status(400).json({ message: "orderedIds must be an array" });
      await Promise.all(
        orderedIds.map((id, index) =>
          db
            .update(dashboardPayableAccounts)
            .set({ displayOrder: index })
            .where(and(eq(dashboardPayableAccounts.id, id), eq(dashboardPayableAccounts.companyId, companyId)))
            .execute()
        )
      );
      res.json({ success: true });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Dashboard Account Selections - for Available Cash and Cash to Pay widgets
  app.get("/api/dashboard-account-selections/:type", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const selectionType = req.params.type;
      if (!["availableCash", "cashToPay"].includes(selectionType)) {
        return res.status(400).json({ message: "Invalid selection type" });
      }

      const [selection] = await db
        .select()
        .from(dashboardAccountSelections)
        .where(
          and(
            eq(dashboardAccountSelections.companyId, companyId),
            eq(dashboardAccountSelections.selectionType, selectionType)
          )
        )
        .execute();

      if (!selection) {
        return res.json({ accountIds: [], accounts: [] });
      }

      // Fetch account details for the selected account IDs
      const accounts = [];
      if (selection.accountIds && selection.accountIds.length > 0) {
        const allLedgerAccounts = await storage.getAllLedgerAccounts(companyId);

        for (const accountId of selection.accountIds) {
          const account = allLedgerAccounts.find((a) => a.id === accountId);
          if (account) {
            // Calculate current balance from voucher entries (excluding optional vouchers)
            const entries = await db
              .select({
                debitAmount: voucherEntries.debitAmount,
                creditAmount: voucherEntries.creditAmount,
              })
              .from(voucherEntries)
              .innerJoin(vouchers, eq(voucherEntries.voucherId, vouchers.id))
              .where(
                and(
                  eq(voucherEntries.ledgerAccountId, accountId),
                  eq(vouchers.companyId, companyId),
                  isNull(vouchers.deletedAt),
                  or(eq(vouchers.optional, false), isNull(vouchers.optional))
                )
              )
              .execute();

            // Opening balance (Dr positive) plus the account's lines, exactly.
            const balance = signedOpeningBalance(
              account.openingBalance,
              account.openingBalanceSide === "Cr" ? "Cr" : "Dr"
            )
              .plus(debitMinusCredit(entries))
              .toNumber();

            accounts.push({
              id: account.id,
              code: account.code,
              name: account.name,
              accountType: account.accountType,
              balance: balance,
            });
          }
        }
      }

      res.json({ accountIds: selection.accountIds || [], accounts });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.put("/api/dashboard-account-selections/:type", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const selectionType = req.params.type;
      if (!["availableCash", "cashToPay"].includes(selectionType)) {
        return res.status(400).json({ message: "Invalid selection type" });
      }

      const { accountIds } = req.body;
      if (!Array.isArray(accountIds)) {
        return res.status(400).json({ message: "accountIds must be an array" });
      }

      // Upsert the selection
      const [existing] = await db
        .select()
        .from(dashboardAccountSelections)
        .where(
          and(
            eq(dashboardAccountSelections.companyId, companyId),
            eq(dashboardAccountSelections.selectionType, selectionType)
          )
        )
        .execute();

      if (existing) {
        await db
          .update(dashboardAccountSelections)
          .set({ accountIds, updatedAt: new Date() })
          .where(eq(dashboardAccountSelections.id, existing.id))
          .execute();
      } else {
        await db
          .insert(dashboardAccountSelections)
          .values({
            companyId,
            selectionType,
            accountIds,
          })
          .execute();
      }

      res.json({ success: true });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
