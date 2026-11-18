// Extracted from ./reportsDashboardAccountRoutes.ts to keep that module under the source-size cap.
import type { Express } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import { requireAuth } from "../auth";
import type Decimal from "decimal.js";
import { signedOpeningBalance, toMoney } from "../lib/money";
import {
  bankAccounts,
  dashboardCashAccounts,
  dashboardPayableAccounts,
  insertDashboardCashAccountSchema,
  insertDashboardPayableAccountSchema,
  ledgerAccounts,
  voucherEntries,
  vouchers,
} from "@shared/schema";

export function registerDashboardAccountRoutesPart1(app: Express) {
  // Dashboard Cash Accounts - user-selected accounts for dashboard display
  app.get("/api/dashboard-cash-accounts", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const accounts = await db
        .select()
        .from(dashboardCashAccounts)
        .where(eq(dashboardCashAccounts.companyId, companyId))
        .orderBy(dashboardCashAccounts.displayOrder)
        .execute();

      if (accounts.length === 0) return res.json([]);

      const ledgerIds = accounts.filter((a) => a.accountType === "ledger").map((a) => a.accountId);
      const bankIds = accounts.filter((a) => a.accountType === "bank").map((a) => a.accountId);

      // Batch-fetch all account details and aggregate entry sums in parallel (4 queries total regardless of account count)
      const [ledgerRows, bankRows, ledgerSums, bankSums] = await Promise.all([
        ledgerIds.length > 0
          ? db.select().from(ledgerAccounts).where(inArray(ledgerAccounts.id, ledgerIds)).execute()
          : [],
        bankIds.length > 0 ? db.select().from(bankAccounts).where(inArray(bankAccounts.id, bankIds)).execute() : [],
        ledgerIds.length > 0
          ? db
              .select({
                accountId: voucherEntries.ledgerAccountId,
                totalDebit: sql<string>`COALESCE(SUM(${voucherEntries.debitAmount}::numeric), 0)`,
                totalCredit: sql<string>`COALESCE(SUM(${voucherEntries.creditAmount}::numeric), 0)`,
              })
              .from(voucherEntries)
              .innerJoin(vouchers, eq(voucherEntries.voucherId, vouchers.id))
              .where(
                and(
                  inArray(voucherEntries.ledgerAccountId, ledgerIds),
                  eq(vouchers.companyId, companyId),
                  isNull(vouchers.deletedAt),
                  eq(vouchers.optional, false)
                )
              )
              .groupBy(voucherEntries.ledgerAccountId)
              .execute()
          : [],
        bankIds.length > 0
          ? db
              .select({
                accountId: voucherEntries.bankAccountId,
                totalDebit: sql<string>`COALESCE(SUM(${voucherEntries.debitAmount}::numeric), 0)`,
                totalCredit: sql<string>`COALESCE(SUM(${voucherEntries.creditAmount}::numeric), 0)`,
              })
              .from(voucherEntries)
              .innerJoin(vouchers, eq(voucherEntries.voucherId, vouchers.id))
              .where(
                and(
                  inArray(voucherEntries.bankAccountId, bankIds),
                  eq(vouchers.companyId, companyId),
                  isNull(vouchers.deletedAt),
                  eq(vouchers.optional, false)
                )
              )
              .groupBy(voucherEntries.bankAccountId)
              .execute()
          : [],
      ]);

      const ledgerMap = new Map(ledgerRows.map((l) => [l.id, l]));
      const bankMap = new Map(bankRows.map((b) => [b.id, b]));
      const ledgerBalMap = new Map(
        ledgerSums.map((r) => [Number(r.accountId), { d: toMoney(r.totalDebit), c: toMoney(r.totalCredit) }])
      );
      const bankBalMap = new Map(
        bankSums.map((r) => [Number(r.accountId), { d: toMoney(r.totalDebit), c: toMoney(r.totalCredit) }])
      );

      const calcBal = (opening: string, side: string | null, sums?: { d: Decimal; c: Decimal }) => {
        let bal = signedOpeningBalance(opening, side === "Cr" ? "Cr" : "Dr");
        if (sums) bal = bal.plus(sums.d).minus(sums.c);
        return bal.toNumber();
      };

      const enrichedAccounts = accounts.map((account) => {
        if (account.accountType === "ledger") {
          const ledger = ledgerMap.get(account.accountId);
          if (!ledger) return null;
          const balance = calcBal(ledger.openingBalance || "0", ledger.openingBalanceSide, ledgerBalMap.get(ledger.id));
          return {
            id: account.id,
            accountType: account.accountType,
            accountId: account.accountId,
            displayOrder: account.displayOrder,
            account: { ...ledger, type: "Ledger", balance, currentBalance: balance },
          };
        } else if (account.accountType === "bank") {
          const bank = bankMap.get(account.accountId);
          if (!bank) return null;
          const balance = calcBal(bank.openingBalance || "0", bank.openingBalanceSide, bankBalMap.get(bank.id));
          return {
            id: account.id,
            accountType: account.accountType,
            accountId: account.accountId,
            displayOrder: account.displayOrder,
            account: { ...bank, type: "Bank", balance, currentBalance: balance },
          };
        }
        return null;
      });

      res.json(enrichedAccounts.filter((a) => a !== null));
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/dashboard-cash-accounts", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const data = insertDashboardCashAccountSchema.parse({
        ...req.body,
        companyId,
      });

      // Check for existing entry to prevent duplicates
      const existing = await db
        .select()
        .from(dashboardCashAccounts)
        .where(
          and(
            eq(dashboardCashAccounts.companyId, companyId),
            eq(dashboardCashAccounts.accountType, data.accountType),
            eq(dashboardCashAccounts.accountId, data.accountId)
          )
        )
        .limit(1)
        .execute();

      if (existing.length > 0) {
        return res.json(existing[0]);
      }

      const [account] = await db.insert(dashboardCashAccounts).values(data).returning().execute();

      res.json(account);
    } catch (error: unknown) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.delete("/api/dashboard-cash-accounts/:id", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid ID" });

      await db
        .delete(dashboardCashAccounts)
        .where(and(eq(dashboardCashAccounts.id, id), eq(dashboardCashAccounts.companyId, companyId)))
        .execute();

      res.json({ success: true });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Reorder dashboard cash accounts
  app.patch("/api/dashboard-cash-accounts/reorder", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const { orderedIds } = req.body as { orderedIds: number[] };
      if (!Array.isArray(orderedIds)) return res.status(400).json({ message: "orderedIds must be an array" });
      await Promise.all(
        orderedIds.map((id, index) =>
          db
            .update(dashboardCashAccounts)
            .set({ displayOrder: index })
            .where(and(eq(dashboardCashAccounts.id, id), eq(dashboardCashAccounts.companyId, companyId)))
            .execute()
        )
      );
      res.json({ success: true });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Dashboard Payable Accounts - user-selected payable accounts for dashboard display
  app.get("/api/dashboard-payable-accounts", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const accounts = await db
        .select()
        .from(dashboardPayableAccounts)
        .where(eq(dashboardPayableAccounts.companyId, companyId))
        .orderBy(dashboardPayableAccounts.displayOrder)
        .execute();

      if (accounts.length === 0) return res.json([]);

      const ledgerIds = accounts.map((a) => a.accountId);

      // Batch-fetch account details and aggregate sums in parallel (2 queries total regardless of account count)
      const [ledgerRows, ledgerSums] = await Promise.all([
        db.select().from(ledgerAccounts).where(inArray(ledgerAccounts.id, ledgerIds)).execute(),
        db
          .select({
            accountId: voucherEntries.ledgerAccountId,
            totalDebit: sql<string>`COALESCE(SUM(${voucherEntries.debitAmount}::numeric), 0)`,
            totalCredit: sql<string>`COALESCE(SUM(${voucherEntries.creditAmount}::numeric), 0)`,
          })
          .from(voucherEntries)
          .innerJoin(vouchers, eq(voucherEntries.voucherId, vouchers.id))
          .where(
            and(
              inArray(voucherEntries.ledgerAccountId, ledgerIds),
              eq(vouchers.companyId, companyId),
              isNull(vouchers.deletedAt),
              eq(vouchers.optional, false)
            )
          )
          .groupBy(voucherEntries.ledgerAccountId)
          .execute(),
      ]);

      const ledgerMap = new Map(ledgerRows.map((l) => [l.id, l]));
      const ledgerBalMap = new Map(
        ledgerSums.map((r) => [Number(r.accountId), { d: toMoney(r.totalDebit), c: toMoney(r.totalCredit) }])
      );

      const enrichedAccounts = accounts.map((account) => {
        const ledger = ledgerMap.get(account.accountId);
        if (!ledger) return null;
        let exactBalance = signedOpeningBalance(
          ledger.openingBalance,
          ledger.openingBalanceSide === "Cr" ? "Cr" : "Dr"
        );
        const sums = ledgerBalMap.get(ledger.id);
        if (sums) exactBalance = exactBalance.plus(sums.d).minus(sums.c);
        const balance = exactBalance.toNumber();
        return {
          id: account.accountId,
          accountId: account.accountId,
          displayOrder: account.displayOrder,
          code: ledger.code || "",
          name: ledger.name || "",
          balance,
        };
      });

      res.json(enrichedAccounts.filter((a) => a !== null));
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/dashboard-payable-accounts", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const data = insertDashboardPayableAccountSchema.parse({
        ...req.body,
        companyId,
      });

      // Check for existing entry to prevent duplicates
      const existing = await db
        .select()
        .from(dashboardPayableAccounts)
        .where(
          and(eq(dashboardPayableAccounts.companyId, companyId), eq(dashboardPayableAccounts.accountId, data.accountId))
        )
        .limit(1)
        .execute();

      if (existing.length > 0) {
        return res.json(existing[0]);
      }

      const [account] = await db.insert(dashboardPayableAccounts).values(data).returning().execute();

      res.json(account);
    } catch (error: unknown) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.delete("/api/dashboard-payable-accounts/:id", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }
      const accountId = parseInt(req.params.id);
      if (isNaN(accountId)) return res.status(400).json({ message: "Invalid account ID" });

      await db
        .delete(dashboardPayableAccounts)
        .where(
          and(eq(dashboardPayableAccounts.accountId, accountId), eq(dashboardPayableAccounts.companyId, companyId))
        )
        .execute();

      res.json({ success: true });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
