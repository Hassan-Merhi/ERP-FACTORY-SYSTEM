import { eq, and, sql } from "drizzle-orm";
import { db, pool } from "../../db";
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

export async function createExchangeRate(rate: schema.InsertExchangeRate): Promise<schema.ExchangeRate> {
  const [result] = await db.insert(schema.exchangeRates).values(rate).returning();
  return result;
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

/**
 * Atomically saves the company-wide rate for a given (company, date, currency pair) —
 * updating the existing row if one exists for today, or inserting a new one.
 *
 * Uses a raw UPDATE-first / INSERT-if-nothing-updated pattern so it works even when the
 * exchange_rates_company_date_pair_unique index has not yet been created in the database
 * (e.g. production environments with RUN_STARTUP_MIGRATIONS=false).  The index is still
 * created at startup as a best-effort step (see server/index.ts ensureExchangeRateIndex),
 * but correctness does not depend on it being present.
 */
export async function upsertExchangeRate(rate: schema.InsertExchangeRate): Promise<schema.ExchangeRate> {
  const result = await pool.query<schema.ExchangeRate>(
    `WITH updated AS (
       UPDATE exchange_rates
          SET rate = $1
        WHERE company_id   = $2
          AND effective_date = $3
          AND from_currency = $4
          AND to_currency   = $5
        RETURNING *
     ),
     inserted AS (
       INSERT INTO exchange_rates (company_id, from_currency, to_currency, rate, effective_date)
       SELECT $2, $4, $5, $1, $3
        WHERE NOT EXISTS (SELECT 1 FROM updated)
        RETURNING *
     )
     SELECT * FROM updated
     UNION ALL
     SELECT * FROM inserted
     LIMIT 1`,
    [rate.rate, rate.companyId, rate.effectiveDate, rate.fromCurrency, rate.toCurrency]
  );
  return result.rows[0] as schema.ExchangeRate;
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------
