/**
 * The rate a non-USD factory document is posted at (accounting audit wave
 * 17 D, owner decision 1 of 2026-10-09).
 *
 * Before: the factory supplier payment, the raw-stock adjustment, the reverse
 * offload's restored freight voucher and the post-offload-charge backfill
 * wrote a EUR/AUD line in the legacy shape (the native amount in the USD
 * columns, no transaction_* amounts) whenever the document had no rate of its
 * own (`factoryEntryAmountsOrLegacy`).
 *
 * Now a non-USD factory document needs a confirmed factory rate dated on or
 * before the document date — `findFactoryFxRateOnOrBefore`: the latest manual
 * rate, else the latest recorded (auto) rate, never a later one; the factory
 * POS and factory invoice rule. Without one the write is refused (409
 * FACTORY_FX_RATE_REQUIRED, with the currency and the date) and nothing is
 * posted. With one, the lines are normalized (`normFactoryEntry`): at the
 * document's own explicitly set rate when it carries one (its USD value was
 * computed from it), otherwise at the confirmed dated rate.
 */
import type { DatabaseOrTransaction } from "../../db";
import { HttpError } from "../../lib/httpHandlers";
import { resolveStoredFxRate } from "./currencyConversion";
import { findFactoryFxRateOnOrBefore, normalizeFactoryCurrency } from "./factoryFxRateOnDate";

export const FACTORY_FX_RATE_REQUIRED = "FACTORY_FX_RATE_REQUIRED" as const;
export const FACTORY_FX_RATE_REQUIRED_MESSAGE =
  "This factory document is in a currency with no confirmed exchange rate on or before its date. Enter the dated factory exchange rate for that currency first.";

/** A non-USD factory document with no confirmed rate on or before its date: refused before anything is posted. */
export class FactoryFxRateRequiredError extends HttpError {
  readonly code = FACTORY_FX_RATE_REQUIRED;
  constructor(
    readonly currency: string,
    readonly documentDate: string
  ) {
    super(409, FACTORY_FX_RATE_REQUIRED_MESSAGE);
    this.name = "FactoryFxRateRequiredError";
  }

  get body() {
    return { code: this.code, message: this.message, currency: this.currency, documentDate: this.documentDate };
  }
}

export interface FactoryDocumentRate {
  /** USD per one unit of the currency, as posted. */
  rate: string;
  source: "identity" | "document" | "manual" | "auto";
  /** The confirmed rate's date (the document date for USD). */
  confirmedRateDate: string;
}

/**
 * The rate a factory document of `currency` dated `documentDate` is posted at,
 * or FactoryFxRateRequiredError. `ownRate` is the document's own rate (and its
 * confirmed flag when the document keeps one); it is used only when it is
 * explicitly set (`resolveStoredFxRate`: positive and, without a flag, not 1).
 */
export async function factoryDocumentRate(
  executor: DatabaseOrTransaction,
  companyId: number,
  currency: string | null | undefined,
  documentDate: string,
  ownRate?: { rate: string | number | null | undefined; confirmed?: boolean | null }
): Promise<FactoryDocumentRate> {
  const ccy = normalizeFactoryCurrency(currency);
  if (ccy === "USD") return { rate: "1", source: "identity", confirmedRateDate: documentDate };
  const confirmed = await findFactoryFxRateOnOrBefore(executor, companyId, ccy, documentDate);
  if (!confirmed) throw new FactoryFxRateRequiredError(ccy, documentDate);
  if (ownRate && resolveStoredFxRate(ccy, ownRate.rate, ownRate.confirmed ?? undefined).looksSet) {
    return { rate: String(ownRate.rate), source: "document", confirmedRateDate: confirmed.effectiveDate };
  }
  return {
    rate: confirmed.rate,
    source: confirmed.source === "manual" ? "manual" : "auto",
    confirmedRateDate: confirmed.effectiveDate,
  };
}
