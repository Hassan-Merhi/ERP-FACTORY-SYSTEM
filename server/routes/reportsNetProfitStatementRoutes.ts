/**
 * Net-profit-statement drill-down routes.
 *
 * Account-level breakdowns behind the net profit statement (purchase
 * accounts, direct incomes, direct expenses, indirect expenses). Extracted
 * from reportsRoutes.ts as a sub-registrar; behaviour is unchanged.
 */
import type { Express } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { requireAuth, requireNonPOS } from "../auth";
import { vouchers, voucherEntries } from "@shared/schema";
import { _npsCached, _npsSetCache } from "./reportsNetProfitCache";

export function registerReportsNetProfitStatementRoutes(app: Express) {
  // Net Profit Drill-down: Purchase Accounts
  app.get("/api/reports/net-profit-statement/purchase-accounts", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const cacheKey = `purchase-accounts:${companyId}`;
      const cached = _npsCached(cacheKey);
      if (cached) return res.json(cached);

      const companyAccounts = await storage.getAllLedgerAccounts(companyId, true);
      const purchaseAccounts = companyAccounts.filter(
        (acc) => acc.code === "PURCHASES" || acc.code?.startsWith("PURCHASES-")
      );

      const accountIds = purchaseAccounts.map((a) => a.id);
      const entries =
        accountIds.length > 0
          ? await db
              .select({
                ledgerAccountId: voucherEntries.ledgerAccountId,
                debitAmount: sql<string>`COALESCE("voucher_entries"."base_debit_amount", "voucher_entries"."debit_amount")`,
                creditAmount: sql<string>`COALESCE("voucher_entries"."base_credit_amount", "voucher_entries"."credit_amount")`,
              })
              .from(voucherEntries)
              .innerJoin(vouchers, eq(voucherEntries.voucherId, vouchers.id))
              .where(
                and(
                  eq(vouchers.companyId, companyId),
                  eq(vouchers.optional, false),
                  isNull(vouchers.deletedAt),
                  inArray(voucherEntries.ledgerAccountId, accountIds)
                )
              )
              .execute()
          : [];

      const accountBalances = new Map<number, { debit: number; credit: number }>();
      for (const entry of entries) {
        if (entry.ledgerAccountId) {
          const debit = parseFloat(entry.debitAmount || "0");
          const credit = parseFloat(entry.creditAmount || "0");
          const current = accountBalances.get(entry.ledgerAccountId) || { debit: 0, credit: 0 };
          accountBalances.set(entry.ledgerAccountId, { debit: current.debit + debit, credit: current.credit + credit });
        }
      }

      const accounts = purchaseAccounts
        .map((acc) => {
          const balance = accountBalances.get(acc.id) || { debit: 0, credit: 0 };
          return {
            id: acc.id,
            code: acc.code,
            name: acc.name,
            debit: balance.debit,
            credit: balance.credit,
            balance: balance.debit - balance.credit,
          };
        })
        .filter((a) => a.debit > 0 || a.credit > 0);

      const total = accounts.reduce((sum, a) => sum + a.balance, 0);
      const result = { accounts, total };
      _npsSetCache(cacheKey, result);
      res.json(result);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Net Profit Drill-down: Direct Incomes
  app.get("/api/reports/net-profit-statement/direct-incomes", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const cacheKey = `direct-incomes:${companyId}`;
      const cached = _npsCached(cacheKey);
      if (cached) return res.json(cached);

      const companyAccounts = await storage.getAllLedgerAccounts(companyId, true);
      const directIncomeAccounts = companyAccounts.filter(
        (acc) => acc.accountType === "Income" && acc.subType === "Direct Income"
      );

      const accountIds = directIncomeAccounts.map((a) => a.id);
      const entries =
        accountIds.length > 0
          ? await db
              .select({
                ledgerAccountId: voucherEntries.ledgerAccountId,
                debitAmount: sql<string>`COALESCE("voucher_entries"."base_debit_amount", "voucher_entries"."debit_amount")`,
                creditAmount: sql<string>`COALESCE("voucher_entries"."base_credit_amount", "voucher_entries"."credit_amount")`,
              })
              .from(voucherEntries)
              .innerJoin(vouchers, eq(voucherEntries.voucherId, vouchers.id))
              .where(
                and(
                  eq(vouchers.companyId, companyId),
                  eq(vouchers.optional, false),
                  isNull(vouchers.deletedAt),
                  inArray(voucherEntries.ledgerAccountId, accountIds)
                )
              )
              .execute()
          : [];

      const accountBalances = new Map<number, { debit: number; credit: number }>();
      for (const entry of entries) {
        if (entry.ledgerAccountId) {
          const debit = parseFloat(entry.debitAmount || "0");
          const credit = parseFloat(entry.creditAmount || "0");
          const current = accountBalances.get(entry.ledgerAccountId) || { debit: 0, credit: 0 };
          accountBalances.set(entry.ledgerAccountId, { debit: current.debit + debit, credit: current.credit + credit });
        }
      }

      const accounts = directIncomeAccounts
        .map((acc) => {
          const balance = accountBalances.get(acc.id) || { debit: 0, credit: 0 };
          return {
            id: acc.id,
            code: acc.code,
            name: acc.name,
            debit: balance.debit,
            credit: balance.credit,
            balance: balance.credit - balance.debit,
          };
        })
        .filter((a) => a.debit > 0 || a.credit > 0);

      const total = accounts.reduce((sum, a) => sum + a.balance, 0);
      const result = { accounts, total };
      _npsSetCache(cacheKey, result);
      res.json(result);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Net Profit Drill-down: Direct Expenses
  app.get("/api/reports/net-profit-statement/direct-expenses", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const cacheKey = `direct-expenses:${companyId}`;
      const cached = _npsCached(cacheKey);
      if (cached) return res.json(cached);

      const companyAccounts = await storage.getAllLedgerAccounts(companyId, true);

      // Direct Expenses - include accounts that are Direct Expenses in any form:
      // - accountType === "Direct Expense"
      // - accountType === "Expense" AND subType === "Direct Expense"
      // - IMPORT_CHARGES parent and its children (import costs that reduce profit)
      const importChargesParent = companyAccounts.find((acc) => acc.code === "IMPORT_CHARGES");
      const importChargesAccountIds = new Set<number>();
      if (importChargesParent) {
        importChargesAccountIds.add(importChargesParent.id);
        companyAccounts.forEach((acc) => {
          if (acc.parentId === importChargesParent.id) importChargesAccountIds.add(acc.id);
        });
      }

      const directExpenseAccounts = companyAccounts.filter(
        (acc) =>
          acc.code !== "PURCHASES" &&
          !acc.code?.startsWith("PURCHASES") &&
          (acc.accountType === "Direct Expense" ||
            (acc.accountType === "Expense" && acc.subType === "Direct Expense") ||
            importChargesAccountIds.has(acc.id))
      );

      const accountIds = directExpenseAccounts.map((a) => a.id);
      const entries =
        accountIds.length > 0
          ? await db
              .select({
                ledgerAccountId: voucherEntries.ledgerAccountId,
                debitAmount: sql<string>`COALESCE("voucher_entries"."base_debit_amount", "voucher_entries"."debit_amount")`,
                creditAmount: sql<string>`COALESCE("voucher_entries"."base_credit_amount", "voucher_entries"."credit_amount")`,
              })
              .from(voucherEntries)
              .innerJoin(vouchers, eq(voucherEntries.voucherId, vouchers.id))
              .where(
                and(
                  eq(vouchers.companyId, companyId),
                  eq(vouchers.optional, false),
                  isNull(vouchers.deletedAt),
                  inArray(voucherEntries.ledgerAccountId, accountIds)
                )
              )
              .execute()
          : [];

      const accountBalances = new Map<number, { debit: number; credit: number }>();
      for (const entry of entries) {
        if (entry.ledgerAccountId) {
          const debit = parseFloat(entry.debitAmount || "0");
          const credit = parseFloat(entry.creditAmount || "0");
          const current = accountBalances.get(entry.ledgerAccountId) || { debit: 0, credit: 0 };
          accountBalances.set(entry.ledgerAccountId, { debit: current.debit + debit, credit: current.credit + credit });
        }
      }

      const accounts = directExpenseAccounts
        .map((acc) => {
          const balance = accountBalances.get(acc.id) || { debit: 0, credit: 0 };
          return {
            id: acc.id,
            code: acc.code,
            name: acc.name,
            debit: balance.debit,
            credit: balance.credit,
            balance: balance.debit - balance.credit,
          };
        })
        .filter((a) => a.debit > 0 || a.credit > 0);

      const total = accounts.reduce((sum, a) => sum + a.balance, 0);
      const result = { accounts, total };
      _npsSetCache(cacheKey, result);
      res.json(result);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Net Profit Drill-down: Indirect Expenses
  app.get("/api/reports/net-profit-statement/indirect-expenses", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const cacheKey = `indirect-expenses:${companyId}`;
      const cached = _npsCached(cacheKey);
      if (cached) return res.json(cached);

      const companyAccounts = await storage.getAllLedgerAccounts(companyId, true);
      const indirectExpenseAccounts = companyAccounts.filter(
        (acc) =>
          (acc.accountType === "Indirect Expense" ||
            (acc.accountType === "Expense" && acc.subType === "Indirect Expense")) &&
          acc.code !== "PRODUCTION_ADJUSTMENT" &&
          acc.code !== "CONSUMPTION_EXPENSE" &&
          acc.code !== "PURCHASES" &&
          !acc.code?.startsWith("PURCHASES")
      );

      const accountIds = indirectExpenseAccounts.map((a) => a.id);
      const entries =
        accountIds.length > 0
          ? await db
              .select({
                ledgerAccountId: voucherEntries.ledgerAccountId,
                debitAmount: sql<string>`COALESCE("voucher_entries"."base_debit_amount", "voucher_entries"."debit_amount")`,
                creditAmount: sql<string>`COALESCE("voucher_entries"."base_credit_amount", "voucher_entries"."credit_amount")`,
              })
              .from(voucherEntries)
              .innerJoin(vouchers, eq(voucherEntries.voucherId, vouchers.id))
              .where(
                and(
                  eq(vouchers.companyId, companyId),
                  eq(vouchers.optional, false),
                  isNull(vouchers.deletedAt),
                  inArray(voucherEntries.ledgerAccountId, accountIds)
                )
              )
              .execute()
          : [];

      const accountBalances = new Map<number, { debit: number; credit: number }>();
      for (const entry of entries) {
        if (entry.ledgerAccountId) {
          const debit = parseFloat(entry.debitAmount || "0");
          const credit = parseFloat(entry.creditAmount || "0");
          const current = accountBalances.get(entry.ledgerAccountId) || { debit: 0, credit: 0 };
          accountBalances.set(entry.ledgerAccountId, { debit: current.debit + debit, credit: current.credit + credit });
        }
      }

      const accounts = indirectExpenseAccounts
        .map((acc) => {
          const balance = accountBalances.get(acc.id) || { debit: 0, credit: 0 };
          return {
            id: acc.id,
            code: acc.code,
            name: acc.name,
            debit: balance.debit,
            credit: balance.credit,
            balance: balance.debit - balance.credit,
          };
        })
        .filter((a) => a.debit > 0 || a.credit > 0);

      const total = accounts.reduce((sum, a) => sum + a.balance, 0);
      const result = { accounts, total };
      _npsSetCache(cacheKey, result);
      res.json(result);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
