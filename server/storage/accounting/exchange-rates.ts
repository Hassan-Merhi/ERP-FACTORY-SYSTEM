import { eq, and, sql } from "drizzle-orm";
import { db } from "../../db";
import * as schema from "@shared/schema";
import { companyBusinessDate } from "../../services/accounting/companyBusinessDate";

export async function getExchangeRates(companyId: number): Promise<schema.ExchangeRate[]> {
  return await db
    .select()
    .from(schema.exchangeRates)
    .where(eq(schema.exchangeRates.companyId, companyId))
    .orderBy(sql`${schema.exchangeRates.effectiveDate} DESC`);
}

/**
 * The company's latest rate for a pair dated on or before `asOf` (default: the
 * company's business date). A rate dated after it is never returned (wave 17
 * C, owner decision 3): a rate entered ahead for a future date used to become
 * "the latest" at once.
 */
export async function getLatestExchangeRate(
  companyId: number,
  fromCurrency: string,
  toCurrency: string,
  asOf?: string
): Promise<schema.ExchangeRate | undefined> {
  const cutoff = asOf ?? (await companyBusinessDate(companyId));
  return getExchangeRateForDate(companyId, fromCurrency, toCurrency, cutoff);
}

export async function getExchangeRateForDate(
  companyId: number,
  fromCurrency: string,
  toCurrency: string,
  date: string
): Promise<schema.ExchangeRate | undefined> {
  const results = await db
    .select()
    .from(schema.exchangeRates)
    .where(
      and(
        eq(schema.exchangeRates.companyId, companyId),
        eq(schema.exchangeRates.fromCurrency, fromCurrency),
        eq(schema.exchangeRates.toCurrency, toCurrency),
        sql`${schema.exchangeRates.effectiveDate} <= ${date}`
      )
    )
    .orderBy(sql`${schema.exchangeRates.effectiveDate} DESC`)
    .limit(1);
  return results[0];
}

export async function getExchangeRateForExactDate(
  companyId: number,
  fromCurrency: string,
  toCurrency: string,
  date: string
): Promise<schema.ExchangeRate | undefined> {
  const [result] = await db
    .select()
    .from(schema.exchangeRates)
    .where(
      and(
        eq(schema.exchangeRates.companyId, companyId),
        eq(schema.exchangeRates.fromCurrency, fromCurrency),
        eq(schema.exchangeRates.toCurrency, toCurrency),
        eq(schema.exchangeRates.effectiveDate, date)
      )
    )
    .limit(1);
  return result;
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------
