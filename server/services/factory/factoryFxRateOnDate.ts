/**
 * Date-aware factory FX lookup (accounting audit wave 8.4 continuation).
 *
 * factory_fx_rates holds, per company and currency, rates in USD per unit of
 * the currency, each with the date it applies from (`effective_date`):
 *   - "manual" rows, entered by a user (the confirmed company rates);
 *   - "auto" rows, an external historical rate recorded for the date it was
 *     fetched for.
 *
 * Every lookup used to take the most recent manual rate whatever its date, so
 * a sale dated in March could be priced at a rate entered in October. The rule
 * is now: the latest rate dated ON OR BEFORE the transaction date, a manual
 * rate before an auto one, never a rate dated after the transaction. A
 * non-USD amount with no such rate has no rate (null): callers refuse the
 * write or flag the amount as unresolved, never assume 1.
 */
import { and, desc, eq, gt, lte } from "drizzle-orm";
import { factoryFxRates } from "@shared/schema";

import type { DatabaseOrTransaction } from "../../db";

export interface FactoryFxRateOnDate {
  /** USD per one unit of the currency, as stored. */
  rate: string;
  /** The date the rate applies from (on or before the requested date). */
  effectiveDate: string;
  source: "identity" | "manual" | "auto";
}

export function normalizeFactoryCurrency(currencyCode: string | null | undefined): string {
  return String(currencyCode || "USD")
    .trim()
    .toUpperCase();
}

/** The latest stored rate of one source dated on or before `dateISO`, or null. */
export async function storedFactoryFxRateOnOrBefore(
  executor: DatabaseOrTransaction,
  companyId: number,
  currencyCode: string,
  dateISO: string,
  source?: "manual" | "auto"
): Promise<FactoryFxRateOnDate | null> {
  const conditions = [
    eq(factoryFxRates.companyId, companyId),
    eq(factoryFxRates.currencyCode, normalizeFactoryCurrency(currencyCode)),
    lte(factoryFxRates.effectiveDate, dateISO),
    gt(factoryFxRates.rateToUsd, "0"),
  ];
  if (source) conditions.push(eq(factoryFxRates.source, source));
  const [row] = await executor
    .select({
      rate: factoryFxRates.rateToUsd,
      effectiveDate: factoryFxRates.effectiveDate,
      source: factoryFxRates.source,
    })
    .from(factoryFxRates)
    .where(and(...conditions))
    .orderBy(desc(factoryFxRates.effectiveDate), desc(factoryFxRates.id))
    .limit(1);
  if (!row) return null;
  return {
    rate: String(row.rate),
    effectiveDate: String(row.effectiveDate),
    source: row.source === "manual" ? "manual" : "auto",
  };
}

/**
 * The company's confirmed rate for a currency on a date: the latest manual
 * rate dated on or before it, else the latest recorded (auto) rate dated on or
 * before it. USD is 1. Null when there is none. Never fetches, so it is safe
 * inside a posting transaction.
 */
export async function findFactoryFxRateOnOrBefore(
  executor: DatabaseOrTransaction,
  companyId: number,
  currencyCode: string | null | undefined,
  dateISO: string
): Promise<FactoryFxRateOnDate | null> {
  const currency = normalizeFactoryCurrency(currencyCode);
  if (currency === "USD") return { rate: "1", effectiveDate: dateISO, source: "identity" };
  return (
    (await storedFactoryFxRateOnOrBefore(executor, companyId, currency, dateISO, "manual")) ??
    (await storedFactoryFxRateOnOrBefore(executor, companyId, currency, dateISO, "auto"))
  );
}

/** The recorded (auto) rate for exactly `dateISO`, or null. */
export async function recordedFactoryFxRateForDate(
  executor: DatabaseOrTransaction,
  companyId: number,
  currencyCode: string,
  dateISO: string
): Promise<string | null> {
  const [row] = await executor
    .select({ rate: factoryFxRates.rateToUsd })
    .from(factoryFxRates)
    .where(
      and(
        eq(factoryFxRates.companyId, companyId),
        eq(factoryFxRates.currencyCode, normalizeFactoryCurrency(currencyCode)),
        eq(factoryFxRates.effectiveDate, dateISO),
        eq(factoryFxRates.source, "auto")
      )
    )
    .limit(1);
  return row ? String(row.rate) : null;
}
