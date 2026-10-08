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
import { bankAccounts, ledgerAccounts, vouchers, voucherEntries } from "@shared/schema";
import { eq, and, sql, isNull } from "drizzle-orm";
import { MoneyDecimal, debitMinusCredit, signedOpeningBalance, toMoney } from "../../lib/money";
import { getPartyBalance } from "../../services/accounting/balances/ledgerBalanceEngine";
import { getCustomerByLedgerId } from "../../lib/factoryCustomerLedger";

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

      // A ledger account a customer owns has no balance of its own: the
      // balance engine rolls its lines into the customer (customer-owned
      // opening, its linked-ledger lines and its customer-tagged lines with no
      // other target). Amounts not yet in the ledger (the factory composite
      // used to add finalized orders and the customer_balances cache here) are
      // reported separately and never added to `balance`.
      const owner = await getCustomerByLedgerId(ledgerAccountId);
      if (owner && owner.companyId === companyId) {
        const party = await getPartyBalance(db, { companyId, kind: "customer", id: owner.id, memo: true });
        return res.json({
          balance: toMoney(party?.closing).toNumber(),
          customerId: owner.id,
          notInLedgerTotal: toMoney(party?.memoTotal).toNumber(),
        });
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

      const balance = signedOpeningBalance(account.openingBalance, account.openingBalanceSide)
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
