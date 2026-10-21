/**
 * The rate a rental payment posts at (accounting audit phase 19 B, PE2).
 */
import Decimal from "decimal.js";
import { and, eq, sql } from "drizzle-orm";

import { exchangeRates } from "@shared/schema";
import { db, type DbTransaction } from "../../db";
import { parseMoneyInput } from "../../lib/money";

/** A rate refusal that carries the HTTP status and the missing pair. */
export type RentalRateRequiredError = Error & { status: number; code: string; currency: string; date: string };

/**
 * Phase 19 (B), PE2: a non-USD rental payment posts at the company's recorded
 * rate dated on or before the payment date (exchange_rates, USD→currency as
 * foreign per USD, or the inverse pair), never at a rate the client sends and
 * never at a default of 1. Without one the payment is refused (409).
 */
export const RENTAL_RATE_REQUIRED_CODE = "RENTAL_RATE_REQUIRED" as const;
export const RENTAL_RATE_REQUIRED_MESSAGE =
  "No exchange rate is recorded for this currency on or before the payment date. Enter the dated rate before posting the payment.";

export function isRentalRateRequiredError(error: unknown): error is RentalRateRequiredError {
  return (error as { code?: unknown } | null)?.code === RENTAL_RATE_REQUIRED_CODE;
}

/**
 * Same lookup as storage getExchangeRateForDate (exact pair, latest dated on
 * or before the day), run on the caller's transaction when one is given so the
 * rate and the payment posting read the same snapshot.
 */
async function recordedRate(
  executor: typeof db | DbTransaction,
  companyId: number,
  fromCurrency: string,
  toCurrency: string,
  day: string
): Promise<string | null> {
  const [row] = await executor
    .select({ rate: exchangeRates.rate })
    .from(exchangeRates)
    .where(
      and(
        eq(exchangeRates.companyId, companyId),
        eq(exchangeRates.fromCurrency, fromCurrency),
        eq(exchangeRates.toCurrency, toCurrency),
        sql`${exchangeRates.effectiveDate} <= ${day}`
      )
    )
    .orderBy(sql`${exchangeRates.effectiveDate} DESC`)
    .limit(1);
  return row ? String(row.rate) : null;
}

/**
 * The recorded TRANSACTION_PER_BASE rate (foreign per USD) for a rental payment, or a 409 error.
 * The direct USD→currency rate takes precedence over the inverse pair, exactly
 * as before the unified accounting work, so scheduled payments keep posting at
 * the rate the existing rules select.
 */
export async function recordedRentalPaymentRate(
  companyId: number,
  currency: string,
  date: string,
  existingTx?: DbTransaction
): Promise<string> {
  const code = (currency || "USD").trim().toUpperCase();
  if (code === "USD") return "1";
  const day = String(date).slice(0, 10);
  const executor = existingTx ?? db;
  const direct = await recordedRate(executor, companyId, "USD", code, day);
  const directRate = direct ? parseMoneyInput(direct) : null;
  if (directRate && directRate.greaterThan(0)) return directRate.toString();
  const inverse = await recordedRate(executor, companyId, code, "USD", day);
  const inverseRate = inverse ? parseMoneyInput(inverse) : null;
  if (inverseRate && inverseRate.greaterThan(0)) return new Decimal(1).div(inverseRate).toDecimalPlaces(10).toString();
  const err = new Error(RENTAL_RATE_REQUIRED_MESSAGE) as RentalRateRequiredError;
  err.status = 409;
  err.code = RENTAL_RATE_REQUIRED_CODE;
  err.currency = code;
  err.date = day;
  throw err;
}
