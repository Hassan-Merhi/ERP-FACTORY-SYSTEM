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
 * is now (phase 24, M1): the latest rate dated ON OR BEFORE the transaction
 * date, a manual rate before an auto one on the same date, never a rate dated
 * after the transaction. A
 * non-USD amount with no such rate has no rate (null): callers refuse the
 * write or flag the amount as unresolved, never assume 1.
 */
import type { DatabaseOrTransaction } from "../../db";
import { resolveFactoryRecordedRate } from "../accounting/fx/rateResolver";

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

/**
 * The latest stored rate dated on or before `dateISO` (of one source when
 * given; manual first on the same date otherwise), or null. Phase 24 (M1):
 * delegates to the one resolver (services/accounting/fx/rateResolver.ts).
 */
export async function storedFactoryFxRateOnOrBefore(
  executor: DatabaseOrTransaction,
  companyId: number,
  currencyCode: string,
  dateISO: string,
  source?: "manual" | "auto"
): Promise<FactoryFxRateOnDate | null> {
  const currency = normalizeFactoryCurrency(currencyCode);
  if (currency === "USD") return null;
  return resolveFactoryRecordedRate(executor, companyId, currency, dateISO, { source });
}

/**
 * The company's confirmed rate for a currency on a date. Phase 24 (M1, owner
 * decision on precedence): the recorded rate dated on or before it, a manual
 * rate before an auto rate ON THE SAME DATE (before: any older manual rate
 * beat a newer recorded auto rate). USD is 1. Null when there is none. Never
 * fetches, so it is safe inside a posting transaction.
 */
export async function findFactoryFxRateOnOrBefore(
  executor: DatabaseOrTransaction,
  companyId: number,
  currencyCode: string | null | undefined,
  dateISO: string
): Promise<FactoryFxRateOnDate | null> {
  return resolveFactoryRecordedRate(executor, companyId, normalizeFactoryCurrency(currencyCode), dateISO);
}
