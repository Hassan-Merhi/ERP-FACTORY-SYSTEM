/**
 * accountRoutes: AccountLedgerBalance endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { db } from "../../db";
import { storage } from "../../storage";
import { requireAuth } from "../../auth";
import {
  bankAccounts,
  ledgerAccounts,
  vouchers,
  voucherEntries,
  customers,
  customerBalances,
  customerOrders,
} from "@shared/schema";
import { eq, and, sql, isNull } from "drizzle-orm";
import { MoneyDecimal, debitMinusCredit, signedOpeningBalance, sumMoney, toMoney } from "../../lib/money";

export function registerAccountLedgerBalanceRoutes(app: Express) {
  // Get balance for a specific ledger account
  app.get("/api/accounts/ledger/:id/balance", requireAuth, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const ledgerAccountId = parseInt(req.params.id);
      const companyId = req.session.currentCompanyId;

      if (isNaN(ledgerAccountId)) {
        return res.status(400).json({ message: "Invalid ledger account ID" });
      }
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      // Resolve the account inside the active tenant. Looking up by global ID
      // first leaked balances for accounts owned by another company.
      const [account] = await db
        .select({
          openingBalance: ledgerAccounts.openingBalance,
          openingBalanceSide: ledgerAccounts.openingBalanceSide,
        })
        .from(ledgerAccounts)
        .where(and(eq(ledgerAccounts.id, ledgerAccountId), eq(ledgerAccounts.companyId, companyId)))
        .limit(1);

      // If not found as a ledger account in this company, it may be a bank account
      // ID in this company (entries are stored in voucherEntries.bankAccountId).
      if (!account) {
        const [bankAcct] = await db
          .select({ openingBalance: bankAccounts.openingBalance, openingBalanceSide: bankAccounts.openingBalanceSide })
          .from(bankAccounts)
          .where(and(eq(bankAccounts.id, ledgerAccountId), eq(bankAccounts.companyId, companyId)))
          .limit(1);

        if (!bankAcct) {
          // Use 404 for wrong-company IDs as well as genuinely missing IDs so the
          // route does not disclose that another tenant owns the resource.
          return res.status(404).json({ message: "Account not found" });
        }

        const bankTxs = await storage.getVoucherEntriesByBankAccount(ledgerAccountId);
        const bankBalance = signedOpeningBalance(bankAcct.openingBalance, bankAcct.openingBalanceSide).plus(
          debitMinusCredit(bankTxs)
        );
        return res.json({ balance: bankBalance.toNumber() });
      }

      // Check if this ledger account is linked to a customer in the same tenant.
      const [linkedCustomer] = await db
        .select({ id: customers.id, ob: customers.openingBalance, side: customers.openingBalanceSide })
        .from(customers)
        .where(and(eq(customers.ledgerAccountId, ledgerAccountId), eq(customers.companyId, companyId)))
        .limit(1);

      // For factory customer-linked ledger accounts, use the same combined formula
      // as /api/factory/customers so the Accounts page balance matches the Customers page.
      if (linkedCustomer) {
        const currentCompany = await storage.getCompanyById(companyId);
        if (currentCompany?.companyType === "factory") {
          const custId = linkedCustomer.id;
          const [salesRows, cbRows, lVoucherRows, cVoucherRows] = await Promise.all([
            db
              .select({
                total: sql<string>`COALESCE(SUM(CAST(${customerOrders.grandTotal} AS numeric)), 0)`,
              })
              .from(customerOrders)
              .where(
                and(
                  eq(customerOrders.customerId, custId),
                  eq(customerOrders.companyId, companyId),
                  eq(customerOrders.status, "FINALIZED")
                )
              ),

            db
              .select({
                net: sql<string>`COALESCE(SUM(CAST(${customerBalances.debitAmount} AS numeric) - CAST(${customerBalances.creditAmount} AS numeric)), 0)`,
              })
              .from(customerBalances)
              .where(
                and(
                  eq(customerBalances.customerId, custId),
                  eq(customerBalances.companyId, companyId),
                  sql`${customerBalances.referenceType} IS DISTINCT FROM 'INVOICE'`
                )
              ),

            db
              .select({
                net: sql<string>`COALESCE(SUM(CAST(${voucherEntries.debitAmount} AS numeric) - CAST(${voucherEntries.creditAmount} AS numeric)), 0)`,
              })
              .from(voucherEntries)
              .innerJoin(
                vouchers,
                and(
                  eq(voucherEntries.voucherId, vouchers.id),
                  eq(vouchers.companyId, companyId),
                  eq(vouchers.optional, false),
                  isNull(vouchers.deletedAt),
                  sql`${vouchers.voucherNumber} NOT LIKE 'CHARGE-%'`
                )
              )
              .where(eq(voucherEntries.ledgerAccountId, ledgerAccountId)),

            db
              .select({
                net: sql<string>`COALESCE(SUM(CAST(${voucherEntries.debitAmount} AS numeric) - CAST(${voucherEntries.creditAmount} AS numeric)), 0)`,
              })
              .from(voucherEntries)
              .innerJoin(
                vouchers,
                and(
                  eq(voucherEntries.voucherId, vouchers.id),
                  eq(vouchers.companyId, companyId),
                  eq(vouchers.optional, false),
                  isNull(vouchers.deletedAt),
                  sql`${vouchers.voucherNumber} NOT LIKE 'CHARGE-%'`
                )
              )
              .where(and(eq(voucherEntries.customerId, custId), isNull(voucherEntries.ledgerAccountId))),
          ]);

          const ob = toMoney(linkedCustomer.ob);
          // Anything but "Dr" (the default side) counts as a credit opening.
          const signedOb = (linkedCustomer.side || "Dr") === "Dr" ? ob : ob.negated();
          const balance = signedOb.plus(
            sumMoney([salesRows[0]?.total, cbRows[0]?.net, lVoucherRows[0]?.net, cVoucherRows[0]?.net])
          );
          return res.json({ balance: balance.toNumber() });
        }
      }

      const transactions = await storage.getVoucherEntriesByLedger(ledgerAccountId, undefined, undefined, companyId);
      let movement = debitMinusCredit(transactions);

      // Some bank accounts have a linkedLedgerId pointing to this ledger account.
      // Their voucher entries are stored under bankAccountId (not ledgerAccountId),
      // so getVoucherEntriesByLedger misses them. Keep those bank lookups tenant-scoped.
      const linkedBanks = await db
        .select({
          id: bankAccounts.id,
          openingBalance: bankAccounts.openingBalance,
          openingBalanceSide: bankAccounts.openingBalanceSide,
        })
        .from(bankAccounts)
        .where(and(eq(bankAccounts.linkedLedgerId, ledgerAccountId), eq(bankAccounts.companyId, companyId)));

      let linkedBankOB = new MoneyDecimal(0);
      for (const bank of linkedBanks) {
        const bankTxs = await storage.getVoucherEntriesByBankAccount(bank.id);
        movement = movement.plus(debitMinusCredit(bankTxs));
        linkedBankOB = linkedBankOB.plus(signedOpeningBalance(bank.openingBalance, bank.openingBalanceSide));
      }

      const rawSide = linkedCustomer?.side ?? account.openingBalanceSide;
      const balance = signedOpeningBalance(linkedCustomer?.ob ?? account.openingBalance, rawSide)
        .plus(linkedBankOB)
        .plus(movement);

      res.json({ balance: balance.toNumber() });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Get per-currency balance breakdown for a ledger account (all-time, no date filter)
  app.get("/api/accounts/ledger/:id/currency-balances", requireAuth, async (req, res) => {
    try {
      const ledgerAccountId = parseInt(req.params.id);
      const companyId = req.session.currentCompanyId;
      if (isNaN(ledgerAccountId)) {
        return res.status(400).json({ message: "Invalid ledger account ID" });
      }
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const [ownedAccount] = await db
        .select({ id: ledgerAccounts.id })
        .from(ledgerAccounts)
        .where(and(eq(ledgerAccounts.id, ledgerAccountId), eq(ledgerAccounts.companyId, companyId)))
        .limit(1);
      if (!ownedAccount) {
        return res.status(404).json({ message: "Account not found" });
      }

      const rows = await db
        .select({
          currency: vouchers.currency,
          totalDebit: sql<string>`COALESCE(SUM(CAST(${voucherEntries.debitAmount} AS numeric)), 0)`,
          totalCredit: sql<string>`COALESCE(SUM(CAST(${voucherEntries.creditAmount} AS numeric)), 0)`,
        })
        .from(voucherEntries)
        .leftJoin(vouchers, eq(voucherEntries.voucherId, vouchers.id))
        .where(
          and(
            eq(voucherEntries.ledgerAccountId, ledgerAccountId),
            eq(vouchers.companyId, companyId),
            eq(vouchers.optional, false),
            isNull(vouchers.deletedAt)
          )
        )
        .groupBy(vouchers.currency);

      const result = rows.map((r) => ({
        currency: r.currency || "USD",
        totalDebit: toMoney(r.totalDebit).toNumber(),
        totalCredit: toMoney(r.totalCredit).toNumber(),
      }));

      res.json(result);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
