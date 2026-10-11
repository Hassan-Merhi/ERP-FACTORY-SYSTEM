/**
 * The rate a rental payment posts at (accounting audit phase 19 B, PE2).
 */
import { db } from "../../db";
import { parseMoneyInput } from "../../lib/money";
import { resolveCompanyRecordedRate } from "../accounting/fx/rateResolver";

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

/** The recorded TRANSACTION_PER_BASE rate (foreign per USD) for a rental payment, or a 409 error. */
export async function recordedRentalPaymentRate(companyId: number, currency: string, date: string): Promise<string> {
  const code = (currency || "USD").trim().toUpperCase();
  if (code === "USD") return "1";
  const day = String(date).slice(0, 10);
  // Phase 24 (M1): the one resolver (USD→currency or the inverse pair, the later date first).
  const recorded = await resolveCompanyRecordedRate(db, companyId, code, day);
  if (recorded && parseMoneyInput(recorded.unitsPerUsd)?.greaterThan(0)) return recorded.unitsPerUsd;
  const err = new Error(RENTAL_RATE_REQUIRED_MESSAGE) as RentalRateRequiredError;
  err.status = 409;
  err.code = RENTAL_RATE_REQUIRED_CODE;
  err.currency = code;
  err.date = day;
  throw err;
}
