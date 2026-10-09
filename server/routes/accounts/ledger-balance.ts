/**
 * accountRoutes: AccountLedgerBalance endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { db } from "../../db";
import { requireAuth } from "../../auth";
import { bankAccounts, ledgerAccounts, vouchers, voucherEntries } from "@shared/schema";
import { eq, and, sql, isNull } from "drizzle-orm";
import { toMoney } from "../../lib/money";
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

      // Optional as-of date (inclusive): without it, everything posted.
      const asOfRaw = req.query?.asOf;
      if (asOfRaw !== undefined && (typeof asOfRaw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(asOfRaw))) {
        return res.status(400).json({ message: "asOf must be a single YYYY-MM-DD value" });
      }
      const asOf = asOfRaw ?? null;

      // The balance engine (wave 17 A), company-scoped: this company's vouchers
      // only, COALESCE(effective_date, voucher_date) <= asOf, the master's own
      // opening with its side (a sideless ledger opening takes its type's
      // usual side; it was Dr), each line counted once by the engine's
      // ownership priority. A bank linked to this ledger (linked_ledger_id) is
      // its own row: its opening and its bank-only lines are no longer folded
      // into the ledger's balance (they were, so the bank was counted twice
      // against the trial balance), and every company's bank lines are no
      // longer read.
      const [account] = await db
        .select({ id: ledgerAccounts.id })
        .from(ledgerAccounts)
        .where(and(eq(ledgerAccounts.id, ledgerAccountId), eq(ledgerAccounts.companyId, companyId)))
        .limit(1);

      // If not found as a ledger account in this company, it may be a bank account
      // ID in this company (entries are stored in voucherEntries.bankAccountId).
      if (!account) {
        const [bankAcct] = await db
          .select({ id: bankAccounts.id })
          .from(bankAccounts)
          .where(and(eq(bankAccounts.id, ledgerAccountId), eq(bankAccounts.companyId, companyId)))
          .limit(1);

        if (!bankAcct) {
          // Use 404 for wrong-company IDs as well as genuinely missing IDs so the
          // route does not disclose that another tenant owns the resource.
          return res.status(404).json({ message: "Account not found" });
        }

        const bank = await getPartyBalance(db, { companyId, kind: "bank", id: bankAcct.id, asOf });
        return res.json({ balance: toMoney(bank?.closing).toNumber(), asOf });
      }

      // A ledger account a customer owns has no balance of its own: the
      // balance engine rolls its lines into the customer (customer-owned
      // opening, its linked-ledger lines and its customer-tagged lines with no
      // other target). Amounts not yet in the ledger (the factory composite
      // used to add finalized orders and the customer_balances cache here) are
      // reported separately and never added to `balance`.
      const owner = await getCustomerByLedgerId(ledgerAccountId);
      if (owner && owner.companyId === companyId) {
        const party = await getPartyBalance(db, { companyId, kind: "customer", id: owner.id, asOf, memo: true });
        return res.json({
          balance: toMoney(party?.closing).toNumber(),
          customerId: owner.id,
          notInLedgerTotal: toMoney(party?.memoTotal).toNumber(),
          asOf,
        });
      }

      const ledger = await getPartyBalance(db, { companyId, kind: "ledger", id: ledgerAccountId, asOf });
      res.json({
        balance: toMoney(ledger?.closing).toNumber(),
        asOf,
        openingSideAssumed: ledger?.openingSideAssumed ?? false,
      });
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
