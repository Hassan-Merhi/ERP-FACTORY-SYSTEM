import Decimal from "decimal.js";
import { and, eq, isNull, or } from "drizzle-orm";
import { db, pool } from "../../db";
import { ledgerAccounts } from "@shared/schema";
import type { CashBankCurrencySummary, NativeBalancesByCurrency } from "./cashBankRevaluationService";
import { normalizeCurrencyCode } from "./currencyAmounts";
import { getLatestCfaPerUsd } from "./latestCfaPerUsd";

const DP_AMOUNT = 6;
const DP_RATE = 10;
const UNRESOLVED_BUCKET = "__UNRESOLVED_LEGACY__";

interface LedgerAccountRow {
  id: number;
  name: string;
  code: string;
  accountType: string;
  openingBalance: string | null;
  openingBalanceSide: string | null;
  openingBalanceNativeAmount: string | null;
  openingBalanceCurrency: string | null;
  openingBalanceHistoricalRate: string | null;
  openingBalanceBaseAmount: string | null;
}

interface AggregateRow {
  entry_currency: string;
  native_debit: string;
  native_credit: string;
  hist_base_debit: string;
  hist_base_credit: string;
  unresolved_count: string;
  unresolved_raw_net: string;
}

function amount(value: string | number | null | undefined): Decimal {
  try {
    const result = new Decimal(value ?? 0);
    return result.isFinite() ? result : new Decimal(0);
  } catch {
    return new Decimal(0);
  }
}

function signedOpeningBalance(account: LedgerAccountRow): Decimal {
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

async function loadLedgerAccount(companyId: number, accountId: number): Promise<LedgerAccountRow | null> {
  const [row] = await db
    .select({
      id: ledgerAccounts.id,
      name: ledgerAccounts.name,
      code: ledgerAccounts.code,
      accountType: ledgerAccounts.accountType,
      openingBalance: ledgerAccounts.openingBalance,
      openingBalanceSide: ledgerAccounts.openingBalanceSide,
      openingBalanceNativeAmount: ledgerAccounts.openingBalanceNativeAmount,
      openingBalanceCurrency: ledgerAccounts.openingBalanceCurrency,
      openingBalanceHistoricalRate: ledgerAccounts.openingBalanceHistoricalRate,
      openingBalanceBaseAmount: ledgerAccounts.openingBalanceBaseAmount,
    })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.id, accountId),
        eq(ledgerAccounts.companyId, companyId),
        isNull(ledgerAccounts.deletedAt),
        or(eq(ledgerAccounts.accountType, "Bank"), eq(ledgerAccounts.accountType, "Cash"))
      )
    )
    .limit(1);

  return row ?? null;
}

async function loadLedgerAggregate(companyId: number, accountId: number): Promise<AggregateRow[]> {
  const result = await pool.query<AggregateRow>(
    `WITH classified AS (
       SELECT
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
         AND ve.ledger_account_id = $2
     )
     SELECT
       entry_currency,
       COALESCE(SUM(native_debit), 0)::text AS native_debit,
       COALESCE(SUM(native_credit), 0)::text AS native_credit,
       COALESCE(SUM(hist_base_debit), 0)::text AS hist_base_debit,
       COALESCE(SUM(hist_base_credit), 0)::text AS hist_base_credit,
       COALESCE(SUM(unresolved), 0)::text AS unresolved_count,
       COALESCE(SUM(unresolved_raw_net), 0)::text AS unresolved_raw_net
     FROM classified
     GROUP BY entry_currency`,
    [companyId, accountId]
  );
  return result.rows;
}

function summarizeLedgerAccount(
  account: LedgerAccountRow,
  rows: AggregateRow[],
  currentCfaPerUsd: Decimal | null
): CashBankCurrencySummary {
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
    const movement = amount(row.native_debit).minus(row.native_credit);
    native.set(currency, (native.get(currency) || new Decimal(0)).plus(movement));
    historicalBase = historicalBase.plus(row.hist_base_debit).minus(row.hist_base_credit);
  }

  const openingRaw = signedOpeningBalance(account);
  const openingCurrency = normalizeStoredCurrency(account.openingBalanceCurrency);
  let openingBalanceCurrencyUnresolved = false;
  let unresolvedOpeningBalanceRaw: string | null = null;

  if (!openingRaw.isZero()) {
    const hasResolvedOpening =
      openingCurrency && account.openingBalanceNativeAmount != null && account.openingBalanceBaseAmount != null;
    if (hasResolvedOpening) {
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
    } else if (currency === "CFA") {
      if (!currentCfaPerUsd) {
        currentRateMissing = true;
        unresolvedTranslationCurrencies.push(currency);
      } else {
        translated = translated.plus(value.div(currentCfaPerUsd));
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
    accountKind: "ledger",
    id: account.id,
    linkedLedgerId: null,
    name: account.name,
    code: account.code,
    accountType: account.accountType,
    nativeBalancesByCurrency,
    historicalBaseBalance: historicalBase.toDecimalPlaces(DP_AMOUNT).toFixed(DP_AMOUNT),
    currentTranslatedBaseBalance,
    translationDifference,
    currentCfaPerUsd: currentCfaPerUsd?.toDecimalPlaces(DP_RATE).toFixed(DP_RATE) ?? null,
    currentRateMissing,
    openingBalanceCurrencyUnresolved,
    unresolvedOpeningBalanceRaw,
    unresolvedLegacyEntryCount,
    unresolvedLegacyNetRaw: unresolvedLegacyNetRaw.toDecimalPlaces(DP_AMOUNT).toFixed(DP_AMOUNT),
    unresolvedTranslationCurrencies: [...new Set(unresolvedTranslationCurrencies)],
    totalsProvisional,
  };
}

/** `asOf`: the date of the current CFA rate (default: the company's business date). */
export async function getCashLedgerAccountSummary(
  companyId: number,
  accountId: number,
  asOf?: string
): Promise<CashBankCurrencySummary | null> {
  const account = await loadLedgerAccount(companyId, accountId);
  if (!account) return null;

  const [rows, currentCfaPerUsd] = await Promise.all([
    loadLedgerAggregate(companyId, accountId),
    getLatestCfaPerUsd(companyId, asOf),
  ]);
  return summarizeLedgerAccount(account, rows, currentCfaPerUsd);
}
