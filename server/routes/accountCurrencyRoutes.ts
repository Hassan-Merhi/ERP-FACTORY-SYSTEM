import type { Express, RequestHandler } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import Decimal from "decimal.js";
import { and, eq, isNull } from "drizzle-orm";
import { db, pool } from "../db";
import { requireAuth, requireNonPOS } from "../auth";
import { bankAccounts, companies, ledgerAccounts } from "@shared/schema";
import { normalizeOpeningBalanceCurrency } from "../services/accounting/openingBalanceCurrency";
import { getCashLedgerAccountSummary } from "../services/accounting/cashLedgerAccountSummaryService";
import { getCashBankAccountSummary, getCashBankRevaluation } from "../services/accounting/cashBankRevaluationService";

const OPENING_FIELDS = [
  "openingBalance",
  "openingBalanceSide",
  "openingBalanceNativeAmount",
  "openingBalanceCurrency",
  "openingBalanceHistoricalRate",
  "openingBalanceBaseAmount",
] as const;

const EXPLICIT_CURRENCY_FIELDS = [
  "openingBalanceNativeAmount",
  "openingBalanceCurrency",
  "openingBalanceHistoricalRate",
  "openingBalanceBaseAmount",
] as const;

/** Flat account-payload values at the JSON/row boundary: strings, numbers, or absent. */
type AccountPayload = Record<string, string | number | null | undefined>;
type ExistingAccount = typeof ledgerAccounts.$inferSelect | typeof bankAccounts.$inferSelect;

function hasOwn(body: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, field);
}

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

function unresolvedOpeningPayload(body: AccountPayload, rawAmount: Decimal): AccountPayload {
  return {
    ...body,
    openingBalance: rawAmount.toFixed(),
    openingBalanceNativeAmount: null,
    openingBalanceCurrency: null,
    openingBalanceHistoricalRate: null,
    openingBalanceBaseAmount: null,
  };
}

function normalizedOpeningPayload(
  body: AccountPayload,
  existing: ExistingAccount | null,
  baseCurrency: string
): AccountPayload {
  const hasExplicitCurrencyPayload = EXPLICIT_CURRENCY_FIELDS.some((field) => hasOwn(body, field));
  const existingIsResolved = Boolean(
    existing?.openingBalanceNativeAmount != null &&
    existing?.openingBalanceCurrency &&
    existing?.openingBalanceBaseAmount != null
  );

  // Old edit forms submit only openingBalance, which is historical base after a
  // record has been resolved. Preserve the locked native/rate metadata when that
  // base value is unchanged. If an old form changes it without currency details,
  // make it unresolved rather than pretending the edited number is USD or CFA.
  if (existing && existingIsResolved && !hasExplicitCurrencyPayload) {
    const submittedLegacyAmount = hasOwn(body, "openingBalance")
      ? new Decimal(body.openingBalance || 0)
      : new Decimal(existing.openingBalanceBaseAmount || existing.openingBalance || 0);
    const existingBase = new Decimal(existing.openingBalanceBaseAmount || existing.openingBalance || 0);

    if (!submittedLegacyAmount.isFinite() || submittedLegacyAmount.lt(0)) {
      throw new Error("Opening balance must be a finite non-negative amount.");
    }
    if (submittedLegacyAmount.eq(existingBase)) {
      return {
        ...body,
        openingBalance: existingBase.toFixed(),
        openingBalanceNativeAmount: existing.openingBalanceNativeAmount,
        openingBalanceCurrency: existing.openingBalanceCurrency,
        openingBalanceHistoricalRate: existing.openingBalanceHistoricalRate,
        openingBalanceBaseAmount: existing.openingBalanceBaseAmount,
      };
    }
    return unresolvedOpeningPayload(body, submittedLegacyAmount);
  }

  const nativeOpeningBalance =
    body.openingBalanceNativeAmount ??
    body.openingBalance ??
    existing?.openingBalanceNativeAmount ??
    existing?.openingBalance ??
    "0";
  const amount = new Decimal(nativeOpeningBalance || 0);
  const rawCurrency = (body.openingBalanceCurrency ?? existing?.openingBalanceCurrency ?? null) as
    | string
    | null
    | undefined;

  if (!amount.isFinite() || amount.lt(0)) {
    throw new Error("Opening balance must be a finite non-negative amount.");
  }

  // Never guess a non-zero opening balance's currency. Keep the legacy raw
  // amount visible and explicitly unresolved until an operator reviews it in
  // Accounts → Resolve Historical Opening & Asset Values.
  if (!amount.isZero() && !rawCurrency) {
    return unresolvedOpeningPayload(body, amount);
  }

  const normalized = normalizeOpeningBalanceCurrency({
    openingBalance: nativeOpeningBalance,
    openingBalanceCurrency: rawCurrency,
    openingBalanceHistoricalRate: body.openingBalanceHistoricalRate ?? existing?.openingBalanceHistoricalRate,
    openingBalanceBaseAmount: body.openingBalanceBaseAmount ?? existing?.openingBalanceBaseAmount,
    baseCurrency,
  });

  return {
    ...body,
    ...normalized,
    // Existing reports read openingBalance. Keep it in historical base currency;
    // the original amount is preserved in openingBalanceNativeAmount.
    openingBalance: normalized.openingBalanceBaseAmount,
  };
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

async function getHistoricalLedgerBalance(companyId: number, ledgerAccountId: number) {
  const [account] = await db
    .select()
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.id, ledgerAccountId),
        eq(ledgerAccounts.companyId, companyId),
        isNull(ledgerAccounts.deletedAt)
      )
    )
    .limit(1);
  if (!account) return null;

  const result = await pool.query<{
    historical_net: string;
    unresolved_count: string;
    unresolved_raw_net: string;
  }>(
    `SELECT
       COALESCE(SUM(
         CASE
           WHEN ve.base_debit_amount IS NOT NULL OR ve.base_credit_amount IS NOT NULL
             THEN COALESCE(ve.base_debit_amount, 0)::numeric - COALESCE(ve.base_credit_amount, 0)::numeric
           WHEN COALESCE(UPPER(v.currency), 'USD') = 'USD'
             THEN COALESCE(ve.debit_amount, 0)::numeric - COALESCE(ve.credit_amount, 0)::numeric
           ELSE 0::numeric
         END
       ), 0)::text AS historical_net,
       COALESCE(SUM(
         CASE WHEN ve.base_debit_amount IS NULL AND ve.base_credit_amount IS NULL
                    AND COALESCE(UPPER(v.currency), 'USD') <> 'USD'
              THEN 1 ELSE 0 END
       ), 0)::text AS unresolved_count,
       COALESCE(SUM(
         CASE WHEN ve.base_debit_amount IS NULL AND ve.base_credit_amount IS NULL
                    AND COALESCE(UPPER(v.currency), 'USD') <> 'USD'
              THEN COALESCE(ve.debit_amount, 0)::numeric - COALESCE(ve.credit_amount, 0)::numeric
              ELSE 0::numeric END
       ), 0)::text AS unresolved_raw_net
     FROM voucher_entries ve
     JOIN vouchers v ON v.id = ve.voucher_id
     WHERE ve.ledger_account_id = $1
       AND v.company_id = $2
       AND v.optional = false
       AND v.deleted_at IS NULL`,
    [ledgerAccountId, companyId]
  );

  let historicalBalance = new Decimal(result.rows[0]?.historical_net || 0);
  const openingBase = new Decimal(account.openingBalanceBaseAmount || account.openingBalance || 0);
  const openingNative = new Decimal(account.openingBalanceNativeAmount || 0);
  const hasNonZeroOpening = !openingBase.isZero() || !openingNative.isZero();
  const openingBalanceCurrencyUnresolved =
    hasNonZeroOpening &&
    (!account.openingBalanceCurrency || !account.openingBalanceBaseAmount || !account.openingBalanceNativeAmount);
  if (!openingBalanceCurrencyUnresolved && !openingBase.isZero()) {
    historicalBalance = historicalBalance.plus(account.openingBalanceSide === "Cr" ? openingBase.neg() : openingBase);
  }

  return {
    account,
    historicalBaseBalance: historicalBalance.toDecimalPlaces(6).toFixed(6),
    unresolvedLegacyEntryCount: Number.parseInt(result.rows[0]?.unresolved_count || "0", 10) || 0,
    unresolvedLegacyNetRaw: new Decimal(result.rows[0]?.unresolved_raw_net || 0).toDecimalPlaces(6).toFixed(6),
    openingBalanceCurrencyUnresolved,
    unresolvedOpeningBalanceRaw: openingBalanceCurrencyUnresolved
      ? new Decimal(account.openingBalance || 0)
          .times(account.openingBalanceSide === "Cr" ? -1 : 1)
          .toDecimalPlaces(6)
          .toFixed(6)
      : null,
  };
}

export function registerAccountCurrencyRoutes(app: Express) {
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

      const cashSummary = await getCashLedgerAccountSummary(companyId, id);
      if (cashSummary) {
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

      const historical = await getHistoricalLedgerBalance(companyId, id);
      if (historical) {
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

      const bankSummary = await getCashBankAccountSummary(companyId, "bank", id);
      if (!bankSummary) return res.status(404).json({ message: "Account not found" });
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
      if (!summary) return res.json([]);
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
