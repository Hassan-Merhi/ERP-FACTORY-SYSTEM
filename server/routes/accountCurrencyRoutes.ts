import type { Express, RequestHandler } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import Decimal from "decimal.js";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db";
import { requireAuth, requireNonPOS, requireRole } from "../auth";
import { bankAccounts, companies, ledgerAccounts } from "@shared/schema";
import { getCashLedgerAccountSummary } from "../services/accounting/cashLedgerAccountSummaryService";
import { getCashBankAccountSummary, getCashBankRevaluation } from "../services/accounting/cashBankRevaluationService";
import { errorStatus } from "../lib/httpHandlers";
import {
  OPENING_FIELDS,
  accountExistsInCompany,
  hasOwn,
  normalizedOpeningPayload,
  getHistoricalLedgerBalance,
} from "./accountCurrencyRoutesHelpers";

function hasOpeningPayload(body: Record<string, unknown>): boolean {
  return OPENING_FIELDS.some((field) => hasOwn(body, field));
}

async function getBaseCurrency(companyId: number): Promise<string> {
  const [company] = await db
    .select({ baseCurrency: companies.baseCurrency })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  return company?.baseCurrency || "USD";
}

export const normalizeAccountOpeningBalance: RequestHandler = async (req, res, next) => {
  try {
    if (req.method !== "POST" && req.method !== "PUT" && req.method !== "PATCH") return next();
    const isLedger = req.path === "/api/ledger-accounts" || /^\/api\/ledger-accounts\/\d+$/.test(req.path);
    const isBank = req.path === "/api/bank-accounts" || /^\/api\/bank-accounts\/\d+$/.test(req.path);
    if (!isLedger && !isBank) return next();
    if (!hasOpeningPayload(req.body || {})) return next();

    const companyId = req.session.currentCompanyId ?? Number(req.body?.companyId);
    if (!companyId) return res.status(400).json({ message: "No company selected" });
    const baseCurrency = await getBaseCurrency(companyId);
    if (String(req.body?.openingBalanceCurrency || "").toUpperCase() === "ZMW") {
      const [company] = await db
        .select({
          baseCurrency: companies.baseCurrency,
          displayCurrency: companies.displayCurrency,
        })
        .from(companies)
        .where(eq(companies.id, companyId))
        .limit(1);
      if (
        String(company?.baseCurrency).toUpperCase() !== "USD" ||
        String(company?.displayCurrency).toUpperCase() !== "ZMW"
      ) {
        return res.status(409).json({
          code: "ZMW_OPENING_COMPANY_MISMATCH",
          message: "A Kwacha cash/bank opening must belong to a USD-base, ZMW-display company.",
        });
      }
    }

    let existing: typeof ledgerAccounts.$inferSelect | typeof bankAccounts.$inferSelect | null = null;
    const idMatch = req.path.match(/\/(\d+)$/);
    if (idMatch) {
      const id = Number.parseInt(idMatch[1], 10);
      const table = isLedger ? ledgerAccounts : bankAccounts;
      const rows = await db
        .select()
        .from(table)
        .where(and(eq(table.id, id), eq(table.companyId, companyId)))
        .limit(1);
      existing = rows[0] || null;
      if (!existing) return res.status(404).json({ message: "Account not found" });
    }

    req.body = normalizedOpeningPayload(req.body || {}, existing, baseCurrency);
    return next();
  } catch (error: unknown) {
    return res.status(400).json({ message: getErrorMessage(error) });
  }
};

export function registerAccountCurrencyRoutes(app: Express) {
  // A real movement between two existing, company-owned Cash/Bank accounts.
  // It creates a balanced, idempotent journal; it does NOT revalue history.
  app.post(
    "/api/accounts/multi-currency/zambia-transfer",
    requireAuth,
    requireNonPOS,
    requireRole("Admin", "Owner"),
    async (req, res) => {
      try {
        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "Select a company" });
        // Loaded on demand: the posting engine's module graph is far larger
        // than this read-mostly route's and is exercised by its own tests.
        const [{ postZambiaCashTransfer }, { sessionPostingActor }] = await Promise.all([
          import("../services/accounting/zambiaCashTransferService"),
          import("../services/accounting/erpVoucherPosting"),
        ]);
        const result = await postZambiaCashTransfer(
          req.body,
          companyId,
          sessionPostingActor(req, "Zambia USD/ZMW cash or bank currency conversion")
        );
        return res.status(result.replayed ? 200 : 201).json(result);
      } catch (error: unknown) {
        return res.status(errorStatus(error)).json({ message: getErrorMessage(error) });
      }
    }
  );

  app.get("/api/bank-accounts/revaluation", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      return res.json(await getCashBankRevaluation(companyId));
    } catch (error: unknown) {
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/accounts/ledger/:id/balance", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const id = Number.parseInt(req.params.id, 10);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: "Invalid account ID" });
      // Optional as-of date (wave 17 A): COALESCE(effective_date, voucher_date) <= asOf;
      // without it, everything posted (the engine's rule).
      const asOfRaw = req.query?.asOf;
      if (asOfRaw !== undefined && (typeof asOfRaw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(asOfRaw))) {
        return res.status(400).json({ message: "asOf must be a single YYYY-MM-DD value" });
      }
      const asOf = asOfRaw;
      const balanceBasis = req.query?.balanceBasis;
      if (balanceBasis !== undefined && balanceBasis !== "book" && balanceBasis !== "current") {
        return res.status(400).json({ message: "balanceBasis must be book or current" });
      }
      // Book balances are posted voucher debits/credits (rounded per line), not
      // a live translation or a 6-decimal historical currency conversion.
      const postedBookBalance = async (kind: "ledger" | "bank"): Promise<number | null> => {
        const { getPartyBalance } = await import("../services/accounting/balances/ledgerBalanceEngine");
        const party = await getPartyBalance(db, { companyId, kind, id, asOf });
        return party ? Number(party.closing) : null;
      };

      // The cash/bank currency summary has no date cut, so a dated balance is
      // the historical-base ledger balance below (the engine's basis).
      const cashSummary = asOf ? null : await getCashLedgerAccountSummary(companyId, id);
      if (cashSummary) {
        if (balanceBasis === "book") {
          const bookBalance = await postedBookBalance("ledger");
          if (bookBalance === null) return res.status(404).json({ message: "Account not found" });
          // Keep both USD figures available, but book is the primary number
          // on voucher and statement screens; no journal or rate is changed.
          return res.json({ balance: bookBalance, balanceBasis: "book", ...cashSummary });
        }
        const displayBalance = cashSummary.currentTranslatedBaseBalance ?? cashSummary.historicalBaseBalance;
        // historicalBaseBalance only covers entries whose currency is fully resolved to a
        // USD base amount. Add back the two missing pieces so the returned balance equals
        // (OB + all_debits − all_credits) — the same formula used by the legacy route:
        //   1. Unresolved opening balance (OB whose currency metadata was never backfilled)
        //   2. Unresolved legacy entry raw net (non-USD entries without a base conversion)
        let balance = Number(displayBalance);
        if (cashSummary.openingBalanceCurrencyUnresolved && cashSummary.unresolvedOpeningBalanceRaw != null) {
          balance += Number(cashSummary.unresolvedOpeningBalanceRaw);
        }
        balance += Number(cashSummary.unresolvedLegacyNetRaw || 0);
        return res.json({ balance, ...cashSummary });
      }

      const historical = await getHistoricalLedgerBalance(companyId, id, asOf);
      if (historical) {
        if (balanceBasis === "book") {
          const bookBalance = await postedBookBalance("ledger");
          if (bookBalance !== null) {
            return res.json({ balance: bookBalance, balanceBasis: "book", ...historical });
          }
        }
        // historicalBaseBalance = resolved-entry net (USD-denominated).
        // Add back: (1) unresolved OB, (2) unresolved legacy entry raw net.
        // Together these reproduce: OB_signed + total_debits − total_credits.
        let balance = Number(historical.historicalBaseBalance);
        if (historical.openingBalanceCurrencyUnresolved && historical.unresolvedOpeningBalanceRaw != null) {
          balance += Number(historical.unresolvedOpeningBalanceRaw);
        }
        balance += Number(historical.unresolvedLegacyNetRaw || 0);
        return res.json({
          balance,
          currentTranslatedBaseBalance: null,
          translationDifference: null,
          nativeBalancesByCurrency: {},
          totalsProvisional: historical.openingBalanceCurrencyUnresolved || historical.unresolvedLegacyEntryCount > 0,
          ...historical,
        });
      }

      if (asOf) {
        // The revaluation summary has no date cut: a dated bank balance is the
        // engine's (its own opening and its bank-only lines, historical base).
        const [bank] = await db
          .select({ id: bankAccounts.id })
          .from(bankAccounts)
          .where(and(eq(bankAccounts.id, id), eq(bankAccounts.companyId, companyId), isNull(bankAccounts.deletedAt)))
          .limit(1);
        if (!bank) return res.status(404).json({ message: "Account not found" });
        // Loaded on demand: the engine is only needed for a dated bank balance.
        const { getPartyBalance } = await import("../services/accounting/balances/ledgerBalanceEngine");
        const party = await getPartyBalance(db, { companyId, kind: "bank", id, asOf });
        if (balanceBasis === "book")
          return res.json({ balance: Number(party?.closing ?? 0), asOf, balanceBasis: "book" });
        return res.json({ balance: Number(party?.historicalBaseClosing ?? 0), asOf });
      }
      const bankSummary = await getCashBankAccountSummary(companyId, "bank", id);
      if (!bankSummary) return res.status(404).json({ message: "Account not found" });
      if (balanceBasis === "book") {
        const bookBalance = await postedBookBalance("bank");
        if (bookBalance === null) return res.status(404).json({ message: "Account not found" });
        return res.json({ balance: bookBalance, balanceBasis: "book", ...bankSummary });
      }
      const displayBalance = bankSummary.currentTranslatedBaseBalance ?? bankSummary.historicalBaseBalance;
      let bankBalance = Number(displayBalance);
      if (bankSummary.openingBalanceCurrencyUnresolved && bankSummary.unresolvedOpeningBalanceRaw != null) {
        bankBalance += Number(bankSummary.unresolvedOpeningBalanceRaw);
      }
      bankBalance += Number(bankSummary.unresolvedLegacyNetRaw || 0);
      return res.json({ balance: bankBalance, ...bankSummary });
    } catch (error: unknown) {
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/accounts/ledger/:id/currency-balances", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const id = Number.parseInt(req.params.id, 10);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: "Invalid account ID" });
      const summary =
        (await getCashBankAccountSummary(companyId, "ledger", id)) ||
        (await getCashBankAccountSummary(companyId, "bank", id));
      if (!summary) {
        // An empty list is the right answer for an account this tenant owns
        // that simply has no cash/bank currency balances. It is the wrong
        // answer for an id the tenant does not own at all: that has to be
        // indistinguishable from a missing id, like the sibling /balance
        // route, so the response does not confirm another tenant's account.
        if (!(await accountExistsInCompany(companyId, id))) {
          return res.status(404).json({ message: "Account not found" });
        }
        return res.json([]);
      }
      return res.json(
        Object.entries(summary.nativeBalancesByCurrency).map(([currency, net]) => {
          const value = new Decimal(net);
          return {
            currency,
            totalDebit: value.gte(0) ? value.toNumber() : 0,
            totalCredit: value.lt(0) ? value.abs().toNumber() : 0,
            net: value.toNumber(),
            historicalBaseBalance: summary.historicalBaseBalance,
            currentTranslatedBaseBalance: summary.currentTranslatedBaseBalance,
            translationDifference: summary.translationDifference,
            totalsProvisional: summary.totalsProvisional,
          };
        })
      );
    } catch (error: unknown) {
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
