import Decimal from "decimal.js";
import { pool } from "../../db";
import { normalizeCurrencyCode } from "./currencyAmounts";
import { getCashBankTranslationRates } from "./cashBankTranslationRates";
import {
  DP_AMOUNT,
  DP_RATE,
  amount,
  loadAccounts,
  type NativeBalancesByCurrency,
  type CashBankCurrencySummary,
  type AccountRow,
  type AggregateRow,
  type CashBankAttribution,
  type CashBankRevaluationOptions,
} from "./cashBankRevaluationServiceHelpers";
export type {
  NativeBalancesByCurrency,
  CashBankCurrencySummary,
  CashBankAttribution,
  CashBankRevaluationOptions,
} from "./cashBankRevaluationServiceHelpers";

const UNRESOLVED_BUCKET = "__UNRESOLVED_LEGACY__";

function signedOpeningBalance(account: AccountRow): Decimal {
  // Resolved rows preserve the native amount separately. Legacy unresolved rows
  // have only openingBalance, whose denomination is deliberately unknown.
  const raw = amount(account.openingBalanceNativeAmount ?? account.openingBalance);
  return account.openingBalanceSide === "Cr" ? raw.neg() : raw;
}

function normalizeStoredCurrency(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return normalizeCurrencyCode(value);
  } catch {
    return value.trim().toUpperCase();
  }
}

async function loadAggregates(
  companyId: number,
  accountKind: "ledger" | "bank",
  accountIds: number[],
  attribution: CashBankAttribution
): Promise<AggregateRow[]> {
  if (accountIds.length === 0) return [];
  const accountColumn = accountKind === "ledger" ? "ve.ledger_account_id" : "ve.bank_account_id";
  // Engine attribution: a line naming a ledger account belongs to the ledger account.
  const bankOnly = accountKind === "bank" && attribution === "engine" ? "AND ve.ledger_account_id IS NULL" : "";

  const result = await pool.query<AggregateRow>(
    `WITH classified AS (
       SELECT
         ${accountColumn} AS account_id,
         CASE
           WHEN ve.transaction_currency IS NOT NULL
             AND ve.transaction_debit_amount IS NOT NULL
             AND ve.transaction_credit_amount IS NOT NULL
             AND ve.base_debit_amount IS NOT NULL
             AND ve.base_credit_amount IS NOT NULL
             THEN CASE WHEN UPPER(ve.transaction_currency) = 'XOF' THEN 'CFA' ELSE UPPER(ve.transaction_currency) END
           WHEN COALESCE(UPPER(v.currency), 'USD') = 'USD'
             THEN 'USD'
           ELSE '${UNRESOLVED_BUCKET}'
         END AS entry_currency,
         CASE
           WHEN ve.transaction_currency IS NOT NULL
             AND ve.transaction_debit_amount IS NOT NULL
             AND ve.transaction_credit_amount IS NOT NULL
             AND ve.base_debit_amount IS NOT NULL
             AND ve.base_credit_amount IS NOT NULL
             THEN ve.transaction_debit_amount::numeric
           WHEN COALESCE(UPPER(v.currency), 'USD') = 'USD'
             THEN COALESCE(ve.debit_amount, 0)::numeric
           ELSE 0::numeric
         END AS native_debit,
         CASE
           WHEN ve.transaction_currency IS NOT NULL
             AND ve.transaction_debit_amount IS NOT NULL
             AND ve.transaction_credit_amount IS NOT NULL
             AND ve.base_debit_amount IS NOT NULL
             AND ve.base_credit_amount IS NOT NULL
             THEN ve.transaction_credit_amount::numeric
           WHEN COALESCE(UPPER(v.currency), 'USD') = 'USD'
             THEN COALESCE(ve.credit_amount, 0)::numeric
           ELSE 0::numeric
         END AS native_credit,
         CASE
           WHEN ve.base_debit_amount IS NOT NULL THEN ve.base_debit_amount::numeric
           WHEN COALESCE(UPPER(v.currency), 'USD') = 'USD' THEN COALESCE(ve.debit_amount, 0)::numeric
           ELSE 0::numeric
         END AS hist_base_debit,
         CASE
           WHEN ve.base_credit_amount IS NOT NULL THEN ve.base_credit_amount::numeric
           WHEN COALESCE(UPPER(v.currency), 'USD') = 'USD' THEN COALESCE(ve.credit_amount, 0)::numeric
           ELSE 0::numeric
         END AS hist_base_credit,
         CASE
           WHEN ve.base_debit_amount IS NULL
             AND ve.base_credit_amount IS NULL
             AND COALESCE(UPPER(v.currency), 'USD') <> 'USD'
             THEN 1 ELSE 0
         END AS unresolved,
         CASE
           WHEN ve.base_debit_amount IS NULL
             AND ve.base_credit_amount IS NULL
             AND COALESCE(UPPER(v.currency), 'USD') <> 'USD'
             THEN COALESCE(ve.debit_amount, 0)::numeric - COALESCE(ve.credit_amount, 0)::numeric
           ELSE 0::numeric
         END AS unresolved_raw_net
       FROM voucher_entries ve
       JOIN vouchers v ON v.id = ve.voucher_id
       WHERE v.company_id = $1
         AND v.optional = false
         AND v.deleted_at IS NULL
         AND ${accountColumn} = ANY($2::int[])
         ${bankOnly}
     )
     SELECT
       account_id::text,
       entry_currency,
       COALESCE(SUM(native_debit), 0)::text AS native_debit,
       COALESCE(SUM(native_credit), 0)::text AS native_credit,
       COALESCE(SUM(hist_base_debit), 0)::text AS hist_base_debit,
       COALESCE(SUM(hist_base_credit), 0)::text AS hist_base_credit,
       COALESCE(SUM(unresolved), 0)::text AS unresolved_count,
       COALESCE(SUM(unresolved_raw_net), 0)::text AS unresolved_raw_net
     FROM classified
     GROUP BY account_id, entry_currency`,
    [companyId, accountIds]
  );
  return result.rows;
}

export async function getCashBankRevaluation(
  companyId: number,
  options: CashBankRevaluationOptions = {}
): Promise<{
  accounts: CashBankCurrencySummary[];
  currentCfaPerUsd: string | null;
  currentZmwPerUsd: string | null;
  unresolvedAccountCount: number;
}> {
  const attribution = options.attribution ?? "legacy";
  const [accounts, rates] = await Promise.all([
    loadAccounts(companyId, attribution),
    getCashBankTranslationRates(companyId, options.asOf),
  ]);
  const currentCfaPerUsd = rates.CFA;
  const currentZmwPerUsd = rates.ZMW;

  const ledgerIds = accounts.filter((row) => row.accountKind === "ledger").map((row) => row.id);
  const bankIds = accounts.filter((row) => row.accountKind === "bank").map((row) => row.id);
  const [ledgerRows, bankRows] = await Promise.all([
    loadAggregates(companyId, "ledger", ledgerIds, attribution),
    loadAggregates(companyId, "bank", bankIds, attribution),
  ]);

  const rowMap = new Map<string, AggregateRow[]>();
  for (const [kind, rows] of [
    ["ledger", ledgerRows],
    ["bank", bankRows],
  ] as const) {
    for (const row of rows) {
      const key = `${kind}:${row.account_id}`;
      const list = rowMap.get(key) || [];
      list.push(row);
      rowMap.set(key, list);
    }
  }

  const summaries = accounts.map((account): CashBankCurrencySummary => {
    const rows = rowMap.get(`${account.accountKind}:${account.id}`) || [];
    const native = new Map<string, Decimal>();
    let historicalBase = new Decimal(0);
    let unresolvedLegacyEntryCount = 0;
    let unresolvedLegacyNetRaw = new Decimal(0);

    for (const row of rows) {
      if (row.entry_currency === UNRESOLVED_BUCKET) {
        unresolvedLegacyEntryCount += Number.parseInt(row.unresolved_count || "0", 10) || 0;
        unresolvedLegacyNetRaw = unresolvedLegacyNetRaw.plus(row.unresolved_raw_net || 0);
        continue;
      }
      const currency = normalizeStoredCurrency(row.entry_currency) || "USD";
      native.set(
        currency,
        (native.get(currency) || new Decimal(0)).plus(amount(row.native_debit).minus(row.native_credit))
      );
      historicalBase = historicalBase.plus(row.hist_base_debit).minus(row.hist_base_credit);
    }

    const openingRaw = signedOpeningBalance(account);
    const openingCurrency = normalizeStoredCurrency(account.openingBalanceCurrency);
    let openingBalanceCurrencyUnresolved = false;
    let unresolvedOpeningBalanceRaw: string | null = null;

    if (!openingRaw.isZero()) {
      if (openingCurrency && account.openingBalanceNativeAmount != null && account.openingBalanceBaseAmount != null) {
        native.set(openingCurrency, (native.get(openingCurrency) || new Decimal(0)).plus(openingRaw));
        const openingBase = amount(account.openingBalanceBaseAmount);
        historicalBase = historicalBase.plus(account.openingBalanceSide === "Cr" ? openingBase.neg() : openingBase);
      } else {
        openingBalanceCurrencyUnresolved = true;
        unresolvedOpeningBalanceRaw = openingRaw.toDecimalPlaces(DP_AMOUNT).toFixed(DP_AMOUNT);
      }
    }

    const nativeBalancesByCurrency: NativeBalancesByCurrency = {};
    for (const [currency, value] of native) {
      if (!value.isZero()) nativeBalancesByCurrency[currency] = value.toDecimalPlaces(DP_AMOUNT).toFixed(DP_AMOUNT);
    }

    const unresolvedTranslationCurrencies: string[] = [];
    let translated = new Decimal(0);
    let currentRateMissing = false;

    for (const [currency, value] of native) {
      if (currency === "USD") {
        translated = translated.plus(value);
      } else if (currency === "CFA" || currency === "ZMW") {
        const rate = currency === "CFA" ? currentCfaPerUsd : currentZmwPerUsd;
        if (!rate) {
          currentRateMissing = true;
          unresolvedTranslationCurrencies.push(currency);
        } else {
          translated = translated.plus(value.div(rate));
        }
      } else {
        unresolvedTranslationCurrencies.push(currency);
      }
    }

    const totalsProvisional =
      openingBalanceCurrencyUnresolved ||
      unresolvedLegacyEntryCount > 0 ||
      currentRateMissing ||
      unresolvedTranslationCurrencies.length > 0;

    const currentTranslatedBaseBalance = totalsProvisional
      ? null
      : translated.toDecimalPlaces(DP_AMOUNT).toFixed(DP_AMOUNT);
    const translationDifference = totalsProvisional
      ? null
      : translated.minus(historicalBase).toDecimalPlaces(DP_AMOUNT).toFixed(DP_AMOUNT);

    return {
      accountKind: account.accountKind,
      id: account.id,
      linkedLedgerId: account.linkedLedgerId,
      name: account.name,
      code: account.code,
      accountType: account.accountType,
      nativeBalancesByCurrency,
      historicalBaseBalance: historicalBase.toDecimalPlaces(DP_AMOUNT).toFixed(DP_AMOUNT),
      currentTranslatedBaseBalance,
      translationDifference,
      currentCfaPerUsd: currentCfaPerUsd?.toDecimalPlaces(DP_RATE).toFixed(DP_RATE) ?? null,
      currentZmwPerUsd: currentZmwPerUsd?.toDecimalPlaces(DP_RATE).toFixed(DP_RATE) ?? null,
      currentRateMissing,
      openingBalanceCurrencyUnresolved,
      unresolvedOpeningBalanceRaw,
      unresolvedLegacyEntryCount,
      unresolvedLegacyNetRaw: unresolvedLegacyNetRaw.toDecimalPlaces(DP_AMOUNT).toFixed(DP_AMOUNT),
      unresolvedTranslationCurrencies: [...new Set(unresolvedTranslationCurrencies)],
      totalsProvisional,
    };
  });

  return {
    accounts: summaries,
    currentCfaPerUsd: currentCfaPerUsd?.toDecimalPlaces(DP_RATE).toFixed(DP_RATE) ?? null,
    currentZmwPerUsd: currentZmwPerUsd?.toDecimalPlaces(DP_RATE).toFixed(DP_RATE) ?? null,
    unresolvedAccountCount: summaries.filter((row) => row.totalsProvisional).length,
  };
}

export async function getCashBankAccountSummary(
  companyId: number,
  accountKind: "ledger" | "bank",
  accountId: number
): Promise<CashBankCurrencySummary | null> {
  const result = await getCashBankRevaluation(companyId);
  return result.accounts.find((row) => row.accountKind === accountKind && row.id === accountId) || null;
}
