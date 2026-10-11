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
 * The external historical rate (USD per unit) for a date. Never stores it:
 * a fetched rate is saved only by the audited Admin/Owner action
 * (saveFetchedFactoryFxRate, accounting audit wave 17 C, owner decision 1).
 */
export async function fetchExternalFactoryFxRate(currencyCode: string, dateISO: string): Promise<string> {
  const response = await fetch(buildValidatedFxUrl(dateISO, currencyCode.trim().toUpperCase()));
  if (!response.ok) throw new Error(`FX API returned ${response.status}`);
  const data = (await response.json()) as { rates?: { USD?: number | string } };
  const raw = data?.rates?.USD;
  const rate = Number(raw);
  if (raw === undefined || raw === null || !Number.isFinite(rate) || rate <= 0) {
    throw new Error("Invalid rate from FX API");
  }
  return String(raw);
}

/**
 * A factory rate as the lookup found it. `saved` is false for an external rate
 * fetched for the request: it is a suggestion, not a recorded rate, and the
 * factory's confirmed-rate readers (findFactoryFxRateOnOrBefore) do not see it.
 */
export interface FactoryFxRateResolution {
  rate: string;
  /** The date the rate applies from (for a fetched rate, the requested date). */
  effectiveDate: string;
  source: "identity" | "manual" | "auto" | "fetched";
  saved: boolean;
}

/**
 * The factory rate (USD per unit) for a currency on a date. Precedence:
 *   1. the latest manual rate dated on or before `dateISO`;
 *   2. the rate already recorded (auto) for exactly that date;
 *   3. the external historical rate for that date, returned but NOT stored
 *      (wave 17 C, owner decision 1: reads never write rates);
 *   4. when the external source fails, the latest recorded rate dated on or
 *      before `dateISO`.
 * A rate dated after the transaction is never used; with none of the above it
 * throws. It never writes, so every caller is read-only on factory_fx_rates.
 */
export async function resolveFactoryFxRateToUsd(
  companyId: number,
  currencyCode: string,
  dateISO: string
): Promise<FactoryFxRateResolution> {
  const normalizedCurrency = currencyCode.trim().toUpperCase();
  if (normalizedCurrency === "USD") return { rate: "1", effectiveDate: dateISO, source: "identity", saved: true };

  const manualRate = await storedFactoryFxRateOnOrBefore(db, companyId, normalizedCurrency, dateISO, "manual");
  if (manualRate) {
    return { rate: manualRate.rate, effectiveDate: manualRate.effectiveDate, source: "manual", saved: true };
  }

  const existingExactRate = await recordedFactoryFxRateForDate(db, companyId, normalizedCurrency, dateISO);
  if (existingExactRate) return { rate: existingExactRate, effectiveDate: dateISO, source: "auto", saved: true };

  try {
    const fetched = await fetchExternalFactoryFxRate(normalizedCurrency, dateISO);
    return { rate: fetched, effectiveDate: dateISO, source: "fetched", saved: false };
  } catch (error: unknown) {
    const fallback = await storedFactoryFxRateOnOrBefore(db, companyId, normalizedCurrency, dateISO);
    if (fallback) {
      return { rate: fallback.rate, effectiveDate: fallback.effectiveDate, source: fallback.source, saved: true };
    }
    throw new Error(
      `No FX rate available for ${dateISO}/${normalizedCurrency}. External API error: ${getErrorMessage(error)}`,
      {
        cause: error,
      }
    );
  }
}

/**
 * Read-only factory rate for a date (the impact preview). Since wave 17 C the
 * posting lookup (getOrFetchFxRateToUsd) never stores a fetched rate either,
 * so both read the same value through resolveFactoryFxRateToUsd.
 */
export async function getFxRateToUsdReadOnly(
  companyId: number,
  currencyCode: string,
  dateISO: string
): Promise<string> {
  return (await resolveFactoryFxRateToUsd(companyId, currencyCode, dateISO)).rate;
}
