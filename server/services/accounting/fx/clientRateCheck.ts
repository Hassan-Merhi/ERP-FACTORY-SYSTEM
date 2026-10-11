/**
 * Server-side dated rates for ERP vouchers and POS, with client rates checked
 * (accounting audit phase 24, M4; owner decision: tolerance 0.5%).
 *
 * Before: the ERP voucher routes and the POS sale took the rate the client
 * sent, or the company's latest rate as of TODAY whatever the voucher date;
 * POS posted the client's rate as given.
 *
 * Now the rate of a voucher is the company's recorded rate dated on or before
 * the voucher date (`resolveUnitsPerUsd`, the phase 24 resolver: the company
 * rate store, else the factory store):
 *   - a rate sent by the client is accepted only within 0.5% of that recorded
 *     rate (and then used as sent, so the client's own figures still agree);
 *     outside it the request is refused, 409 EXCHANGE_RATE_OUT_OF_TOLERANCE
 *     with the recorded rate and its date;
 *   - a non-USD voucher with no recorded rate on or before its date is
 *     refused, 409 EXCHANGE_RATE_REQUIRED (never a default of 1);
 *   - for a USD voucher the header rate is only the display rate (USD → the
 *     company's display currency): it is the recorded dated rate, a client rate
 *     is checked the same way, and with no recorded rate the header keeps no
 *     rate (the ledger lines are USD either way).
 */
import { eq } from "drizzle-orm";
import { companies } from "@shared/schema";

import { db, type DatabaseOrTransaction } from "../../../db";
import { HttpError } from "../../../lib/httpError";
import { MoneyDecimal, toMoney, type MoneyInput } from "../../../lib/money";
import { normalizeRateCurrency, resolveUnitsPerUsd } from "./rateResolver";

/** 0.5% (owner decision, phase 24). */
export const CLIENT_RATE_TOLERANCE = "0.005";

export const EXCHANGE_RATE_OUT_OF_TOLERANCE = "EXCHANGE_RATE_OUT_OF_TOLERANCE" as const;
export const EXCHANGE_RATE_OUT_OF_TOLERANCE_MESSAGE =
  "The exchange rate sent differs from the rate recorded for this date by more than 0.5%. Use the recorded rate, or record the correct rate for the date first.";
export const EXCHANGE_RATE_REQUIRED = "EXCHANGE_RATE_REQUIRED" as const;
export const EXCHANGE_RATE_REQUIRED_MESSAGE =
  "No exchange rate is recorded for this currency on or before the document date. Record the dated exchange rate first.";

export class ClientRateOutOfToleranceError extends HttpError {
  readonly code = EXCHANGE_RATE_OUT_OF_TOLERANCE;
  constructor(
    readonly currency: string,
    readonly documentDate: string,
    readonly clientRate: string,
    readonly recordedRate: string,
    readonly recordedRateDate: string
  ) {
    super(409, EXCHANGE_RATE_OUT_OF_TOLERANCE_MESSAGE);
    this.name = "ClientRateOutOfToleranceError";
  }

  get body() {
    return {
      code: this.code,
      message: this.message,
      currency: this.currency,
      documentDate: this.documentDate,
      clientRate: this.clientRate,
      recordedRate: this.recordedRate,
      recordedRateDate: this.recordedRateDate,
      tolerance: CLIENT_RATE_TOLERANCE,
    };
  }
}

export class ExchangeRateRequiredError extends HttpError {
  readonly code = EXCHANGE_RATE_REQUIRED;
  constructor(
    readonly currency: string,
    readonly documentDate: string
  ) {
    super(409, EXCHANGE_RATE_REQUIRED_MESSAGE);
    this.name = "ExchangeRateRequiredError";
  }

  get body() {
    return { code: this.code, message: this.message, currency: this.currency, documentDate: this.documentDate };
  }
}

export function isDocumentRateError(
  error: unknown
): error is ClientRateOutOfToleranceError | ExchangeRateRequiredError {
  return error instanceof ClientRateOutOfToleranceError || error instanceof ExchangeRateRequiredError;
}

/** A positive client rate, or null when none was sent. A sent rate that is not a positive number is out of tolerance. */
function clientRateOf(value: MoneyInput | unknown): { present: boolean; rate: string | null } {
  if (value === null || value === undefined || value === "") return { present: false, rate: null };
  if (typeof value !== "string" && typeof value !== "number") return { present: true, rate: null };
  const decimal = toMoney(value as MoneyInput);
  return { present: true, rate: decimal.gt(0) ? decimal.toFixed() : null };
}

/** True when `client` is within the tolerance of `recorded` (relative difference). */
export function withinRateTolerance(client: MoneyInput, recorded: MoneyInput): boolean {
  const recordedRate = toMoney(recorded);
  if (!recordedRate.gt(0)) return false;
  const relative = toMoney(client).minus(recordedRate).abs().div(recordedRate);
  return relative.lte(new MoneyDecimal(CLIENT_RATE_TOLERANCE));
}

export interface DocumentRate {
  /** The rate to store (units of `currency` per USD), or null (USD voucher, no display rate recorded). */
  rate: string | null;
  /** The currency the rate converts USD into. */
  currency: string;
  recordedRate: string | null;
  recordedRateDate: string | null;
  source: "identity" | "client" | "recorded" | "none";
}

/**
 * The rate (units per USD) of `currency` for a document dated `documentDate`,
 * with a client rate checked against the recorded one. Throws
 * ExchangeRateRequiredError / ClientRateOutOfToleranceError (409).
 */
export async function checkedDocumentRate(
  executor: DatabaseOrTransaction,
  input: { companyId: number; currency: string | null | undefined; documentDate: string; clientRate?: unknown }
): Promise<DocumentRate> {
  const currency = normalizeRateCurrency(input.currency);
  const date = String(input.documentDate).slice(0, 10);
  if (currency === "USD") {
    return { rate: "1", currency, recordedRate: "1", recordedRateDate: date, source: "identity" };
  }
  const recorded = await resolveUnitsPerUsd(executor, input.companyId, currency, date);
  if (!recorded) throw new ExchangeRateRequiredError(currency, date);
  const client = clientRateOf(input.clientRate);
  if (!client.present) {
    return {
      rate: recorded.unitsPerUsd,
      currency,
      recordedRate: recorded.unitsPerUsd,
      recordedRateDate: recorded.effectiveDate,
      source: "recorded",
    };
  }
  if (!client.rate || !withinRateTolerance(client.rate, recorded.unitsPerUsd)) {
    throw new ClientRateOutOfToleranceError(
      currency,
      date,
      String(input.clientRate),
      recorded.unitsPerUsd,
      recorded.effectiveDate
    );
  }
  return {
    rate: client.rate,
    currency,
    recordedRate: recorded.unitsPerUsd,
    recordedRateDate: recorded.effectiveDate,
    source: "client",
  };
}

/**
 * The header rate of a voucher: for a non-USD voucher its currency's checked
 * rate (required); for a USD voucher the display rate (USD → the company's
 * display currency) on the voucher date, a client rate checked, null when the
 * company has no display currency or no rate is recorded for it.
 */
export async function voucherHeaderRate(
  input: {
    companyId: number;
    voucherCurrency: string | null | undefined;
    voucherDate: string;
    clientRate?: unknown;
  },
  executor: DatabaseOrTransaction = db
): Promise<DocumentRate> {
  const voucherCurrency = normalizeRateCurrency(input.voucherCurrency);
  if (voucherCurrency !== "USD") {
    return checkedDocumentRate(executor, {
      companyId: input.companyId,
      currency: voucherCurrency,
      documentDate: input.voucherDate,
      clientRate: input.clientRate,
    });
  }
  const [company] = await executor
    .select({ baseCurrency: companies.baseCurrency, displayCurrency: companies.displayCurrency })
    .from(companies)
    .where(eq(companies.id, input.companyId))
    .limit(1);
  const display = normalizeRateCurrency(company?.displayCurrency || "USD");
  const none: DocumentRate = {
    rate: null,
    currency: display,
    recordedRate: null,
    recordedRateDate: null,
    source: "none",
  };
  if (display === "USD") return none;
  try {
    return await checkedDocumentRate(executor, {
      companyId: input.companyId,
      currency: display,
      documentDate: input.voucherDate,
      clientRate: input.clientRate,
    });
  } catch (error) {
    if (error instanceof ExchangeRateRequiredError) return none;
    throw error;
  }
}

/**
 * Checks the per-line rates a client sends with full dual-currency fields
 * (transactionCurrency + historicalExchangeRate + rateConvention): every
 * non-USD line's rate must be within the tolerance of the recorded rate of its
 * currency on the document date (TRANSACTION_PER_BASE as sent,
 * BASE_PER_TRANSACTION inverted). Throws like `checkedDocumentRate`.
 */
export async function checkClientEntryRates(
  executor: DatabaseOrTransaction,
  input: { companyId: number; documentDate: string; entries: ReadonlyArray<unknown> }
): Promise<void> {
  for (const raw of input.entries) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const currency =
      typeof entry.transactionCurrency === "string" ? normalizeRateCurrency(entry.transactionCurrency) : "USD";
    if (currency === "USD") continue;
    const convention = String(entry.rateConvention ?? "TRANSACTION_PER_BASE").toUpperCase();
    if (convention === "IDENTITY") continue;
    const sent = toMoney(entry.historicalExchangeRate as MoneyInput);
    const clientRate =
      entry.historicalExchangeRate == null || entry.historicalExchangeRate === ""
        ? undefined
        : convention === "BASE_PER_TRANSACTION"
          ? sent.gt(0)
            ? new MoneyDecimal(1).div(sent).toFixed()
            : "0"
          : sent.toFixed();
    await checkedDocumentRate(executor, {
      companyId: input.companyId,
      currency,
      documentDate: input.documentDate,
      clientRate,
    });
  }
}

/** Sends a document-rate refusal (409 with its body); false when `error` is not one. */
export function sendDocumentRateError(
  res: { status(code: number): { json(body: unknown): unknown } },
  error: unknown
): boolean {
  if (!isDocumentRateError(error)) return false;
  res.status(error.statusCode).json(error.body);
  return true;
}
