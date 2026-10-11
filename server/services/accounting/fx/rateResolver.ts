/**
 * The one exchange-rate resolver (accounting audit phase 24, M1).
 *
 * Before: six resolvers with three precedence rules (factory read-only lookup,
 * factory confirmed lookup, the wave 6 repair's own rule, the ERP "latest"
 * lookups at today's business date, the CFA lookup, and client-sent rates).
 *
 * Now every recorded-rate lookup goes through this module, with one rule
 * (owner decision, phase 24, decided by default): the RECORDED rate dated ON OR
 * BEFORE the document date; on the same date a manual rate beats an auto
 * (recorded market) rate; a rate dated after the document is never used; there
 * is never a default of 1 for a non-USD currency. A newer recorded auto rate
 * therefore beats an older manual rate.
 *
 * Two stores keep their own conventions (one rate store is phase 23's G15/M12):
 *   - "factory": factory_fx_rates, USD per one unit (BASE_PER_TRANSACTION),
 *     sources manual / auto;
 *   - "company": exchange_rates, `rate` = units of `to` per one `from`; a
 *     currency's rate against USD is the pair USD→X (X per USD,
 *     TRANSACTION_PER_BASE) or the inverse pair X→USD; every row is a user
 *     entry (manual). CFA and XOF are one currency.
 *
 * Nothing here fetches or writes: it is safe inside a posting transaction.
 */
import { and, desc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import { exchangeRates, factoryFxRates } from "@shared/schema";

import type { DatabaseOrTransaction } from "../../../db";
import { MoneyDecimal, toMoney } from "../../../lib/money";

export type RecordedRateSource = "identity" | "manual" | "auto";

export interface RecordedFactoryRate {
  /** USD per one unit of the currency, as stored. */
  rate: string;
  effectiveDate: string;
  source: RecordedRateSource;
}

export interface RecordedCompanyRate {
  /** Units of the currency per one USD (TRANSACTION_PER_BASE), exact. */
  unitsPerUsd: string;
  effectiveDate: string;
  source: RecordedRateSource;
  /** Which stored pair gave it. */
  pair: "identity" | "direct" | "inverse";
}

export interface RecordedPairRate {
  id: number | null;
  /** Units of `to` per one `from`, as stored. */
  rate: string;
  effectiveDate: string;
}

export function normalizeRateCurrency(currencyCode: string | null | undefined): string {
  const code = String(currencyCode || "USD")
    .trim()
    .toUpperCase();
  return code === "XOF" ? "CFA" : code;
}

/** The stored spellings of a currency (CFA is also stored as XOF). */
function storedSpellings(currencyCode: string | null | undefined): string[] {
  const code = normalizeRateCurrency(currencyCode);
  return code === "CFA" ? ["CFA", "XOF"] : [code];
}

/**
 * The factory store's recorded rate (USD per unit) for a currency on a date:
 * the latest rate dated on or before it, manual first on the same date. USD is
 * 1. Null when none.
 */
export async function resolveFactoryRecordedRate(
  executor: DatabaseOrTransaction,
  companyId: number,
  currencyCode: string | null | undefined,
  dateISO: string,
  options: { source?: "manual" | "auto" } = {}
): Promise<RecordedFactoryRate | null> {
  const currency = String(currencyCode || "USD")
    .trim()
    .toUpperCase();
  if (currency === "USD") return { rate: "1", effectiveDate: dateISO, source: "identity" };
  const conditions = [
    eq(factoryFxRates.companyId, companyId),
    inArray(factoryFxRates.currencyCode, currency === "CFA" || currency === "XOF" ? ["CFA", "XOF"] : [currency]),
    lte(factoryFxRates.effectiveDate, dateISO),
    gt(factoryFxRates.rateToUsd, "0"),
  ];
  if (options.source) conditions.push(eq(factoryFxRates.source, options.source));
  const [row] = await executor
    .select({
      rate: factoryFxRates.rateToUsd,
      effectiveDate: factoryFxRates.effectiveDate,
      source: factoryFxRates.source,
    })
    .from(factoryFxRates)
    .where(and(...conditions))
    .orderBy(
      desc(factoryFxRates.effectiveDate),
      desc(sql`CASE WHEN ${factoryFxRates.source} = 'manual' THEN 1 ELSE 0 END`),
      desc(factoryFxRates.id)
    )
    .limit(1);
  if (!row) return null;
  return {
    rate: String(row.rate),
    effectiveDate: String(row.effectiveDate),
    source: row.source === "manual" ? "manual" : "auto",
  };
}

/** The company store's latest row of one pair dated on or before `dateISO`, or null. */
export async function resolveCompanyPairRate(
  executor: DatabaseOrTransaction,
  companyId: number,
  fromCurrency: string,
  toCurrency: string,
  dateISO: string
): Promise<RecordedPairRate | null> {
  if (normalizeRateCurrency(fromCurrency) === normalizeRateCurrency(toCurrency)) {
    return { id: null, rate: "1", effectiveDate: dateISO };
  }
  const [row] = await executor
    .select({ id: exchangeRates.id, rate: exchangeRates.rate, effectiveDate: exchangeRates.effectiveDate })
    .from(exchangeRates)
    .where(
      and(
        eq(exchangeRates.companyId, companyId),
        inArray(exchangeRates.fromCurrency, storedSpellings(fromCurrency)),
        inArray(exchangeRates.toCurrency, storedSpellings(toCurrency)),
        lte(exchangeRates.effectiveDate, dateISO),
        gt(exchangeRates.rate, "0")
      )
    )
    .orderBy(desc(exchangeRates.effectiveDate), desc(exchangeRates.id))
    .limit(1);
  return row ? { id: row.id, rate: String(row.rate), effectiveDate: String(row.effectiveDate) } : null;
}

/**
 * The company store's recorded rate of a currency against USD on a date, as
 * units per USD: the later of the pair USD→X and the inverse X→USD (the direct
 * pair on the same date). USD is 1. Null when none.
 */
export async function resolveCompanyRecordedRate(
  executor: DatabaseOrTransaction,
  companyId: number,
  currencyCode: string | null | undefined,
  dateISO: string
): Promise<RecordedCompanyRate | null> {
  const currency = normalizeRateCurrency(currencyCode);
  if (currency === "USD") return { unitsPerUsd: "1", effectiveDate: dateISO, source: "identity", pair: "identity" };
  const direct = await resolveCompanyPairRate(executor, companyId, "USD", currency, dateISO);
  const inverse = await resolveCompanyPairRate(executor, companyId, currency, "USD", dateISO);
  if (direct && (!inverse || direct.effectiveDate >= inverse.effectiveDate)) {
    return {
      unitsPerUsd: toMoney(direct.rate).toFixed(),
      effectiveDate: direct.effectiveDate,
      source: "manual",
      pair: "direct",
    };
  }
  if (inverse) {
    return {
      unitsPerUsd: new MoneyDecimal(1).div(toMoney(inverse.rate)).toDecimalPlaces(10).toFixed(),
      effectiveDate: inverse.effectiveDate,
      source: "manual",
      pair: "inverse",
    };
  }
  return null;
}

/**
 * The recorded rate of a currency as units per USD from the store a company
 * keeps its rates in: the company store first, else the factory store
 * (inverted). Used where a document may sit in either kind of company
 * (revaluation, realized FX). Null when neither has one.
 */
export async function resolveUnitsPerUsd(
  executor: DatabaseOrTransaction,
  companyId: number,
  currencyCode: string | null | undefined,
  dateISO: string,
  preferred: "company" | "factory" = "company"
): Promise<(RecordedCompanyRate & { store: "company" | "factory" }) | null> {
  const fromCompany = async () => {
    const rate = await resolveCompanyRecordedRate(executor, companyId, currencyCode, dateISO);
    return rate ? { ...rate, store: "company" as const } : null;
  };
  const fromFactory = async () => {
    const rate = await resolveFactoryRecordedRate(executor, companyId, currencyCode, dateISO);
    if (!rate) return null;
    return {
      unitsPerUsd:
        rate.source === "identity" ? "1" : new MoneyDecimal(1).div(toMoney(rate.rate)).toDecimalPlaces(10).toFixed(),
      effectiveDate: rate.effectiveDate,
      source: rate.source,
      pair: rate.source === "identity" ? ("identity" as const) : ("inverse" as const),
      store: "factory" as const,
    };
  };
  const order = preferred === "company" ? [fromCompany, fromFactory] : [fromFactory, fromCompany];
  for (const lookup of order) {
    const found = await lookup();
    if (found) return found;
  }
  return null;
}
