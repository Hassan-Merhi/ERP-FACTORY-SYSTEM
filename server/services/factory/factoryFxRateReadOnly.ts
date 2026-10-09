import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { recordedFactoryFxRateForDate, storedFactoryFxRateOnOrBefore } from "./factoryFxRateOnDate";

function buildValidatedFxUrl(dateISO: string, currencyCode: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) {
    throw new Error("Invalid FX date");
  }
  if (!/^[A-Z]{3}$/.test(currencyCode)) {
    throw new Error("Invalid FX currency");
  }

  const url = new URL("https://api.frankfurter.app");
  url.pathname = `/${dateISO}`;
  url.searchParams.set("from", currencyCode);
  url.searchParams.set("to", "USD");
  return url.href;
}

/**
 * Read-only equivalent of the mutation route's FX lookup policy
 * (getOrFetchFxRateToUsd, routes/factory/_helpers.ts).
 *
 * Same precedence, date-aware since wave 8.4 continuation — the latest manual
 * rate dated on or before the date, the rate recorded for exactly that date,
 * the external historical rate, then the latest recorded rate dated on or
 * before the date — but it never persists an externally fetched rate and
 * never uses a rate dated after the transaction. This keeps impact preview
 * strictly read-only while producing the same value the subsequent mutation
 * will normally resolve.
 */
export async function getFxRateToUsdReadOnly(
  companyId: number,
  currencyCode: string,
  dateISO: string
): Promise<string> {
  const normalizedCurrency = currencyCode.trim().toUpperCase();
  if (normalizedCurrency === "USD") return "1";

  const manualRate = await storedFactoryFxRateOnOrBefore(db, companyId, normalizedCurrency, dateISO, "manual");
  if (manualRate) return manualRate.rate;

  const existingExactRate = await recordedFactoryFxRateForDate(db, companyId, normalizedCurrency, dateISO);
  if (existingExactRate) return existingExactRate;

  try {
    const response = await fetch(buildValidatedFxUrl(dateISO, normalizedCurrency));
    if (!response.ok) throw new Error(`FX API returned ${response.status}`);
    const data = (await response.json()) as { rates?: { USD?: number } };
    const rate = Number(data?.rates?.USD);
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error("Invalid rate from FX API");
    }
    return String(rate);
  } catch (error: unknown) {
    const fallback = await storedFactoryFxRateOnOrBefore(db, companyId, normalizedCurrency, dateISO);
    if (fallback) return fallback.rate;
    throw new Error(
      `No FX rate available for ${dateISO}/${normalizedCurrency}. External API error: ${getErrorMessage(error)}`,
      { cause: error }
    );
  }
}
