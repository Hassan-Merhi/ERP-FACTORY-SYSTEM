/**
 * Approved, company-scoped Zambia ERP voucher rate policy.
 *
 * ERP stores ZMW per USD. The caller's number is never trusted as approval;
 * it must match the rate in exchange_rates effective on the voucher's date.
 * This is a SOURCE write boundary, not a historical data migration.
 */
import Decimal from "decimal.js";
import { HttpError } from "../../lib/httpError";
import { and, eq } from "drizzle-orm";
import { ledgerAccounts } from "@shared/schema";
import { ROUNDING_ACCOUNT_CODE, ENGINE_ROUNDING_NARRATION } from "./engineRounding";
import type { DbTransaction } from "../../db";
import { storage } from "../../storage";
import { companyBusinessDate } from "./companyBusinessDate";
import { companyRateDateSchema, companyRateValueSchema } from "@shared/companyRatePolicy";

export class ZambiaVoucherRateError extends HttpError {
  readonly code = "ZMW_VOUCHER_RATE_INVALID";
  constructor(message: string) {
    super(409, message);
    this.name = "ZambiaVoucherRateError";
  }
}

/** Preserve existing USD and Mali CFA workflows; validate ZMW only. */
export async function assertApprovedZmwVoucherRate(
  companyId: number,
  voucherDate: string,
  currency: string | null | undefined,
  suppliedRate: string | number | null | undefined
): Promise<string | null> {
  const code = String(currency || "USD")
    .trim()
    .toUpperCase();
  if (code !== "ZMW") return suppliedRate == null || suppliedRate === "" ? null : String(suppliedRate);

  if (!Number.isSafeInteger(companyId) || companyId <= 0 || !companyRateDateSchema.safeParse(voucherDate).success) {
    throw new ZambiaVoucherRateError("A valid company and voucher date are required for ZMW accounting.");
  }
  const company = await storage.getCompanyById(companyId);
  if (
    !company ||
    String(company.baseCurrency).toUpperCase() !== "USD" ||
    String(company.displayCurrency).toUpperCase() !== "ZMW"
  ) {
    throw new ZambiaVoucherRateError("The active company must be configured USD base / ZMW display.");
  }
  if (voucherDate > (await companyBusinessDate(companyId))) {
    throw new ZambiaVoucherRateError("Cannot post a future-dated ZMW voucher.");
  }
  const approved = await storage.getExchangeRateForDate(companyId, "USD", "ZMW", voucherDate);
  if (!approved || !companyRateValueSchema.safeParse(String(approved.rate)).success) {
    throw new ZambiaVoucherRateError("An approved USD/ZMW rate is required on or before the voucher date.");
  }
  const entered = suppliedRate == null ? "" : String(suppliedRate).trim();
  if (
    !companyRateValueSchema.safeParse(entered).success ||
    !new Decimal(entered).eq(new Decimal(String(approved.rate)))
  ) {
    throw new ZambiaVoucherRateError(
      "The supplied USD/ZMW rate differs from the approved historical rate. Reload the date-specific rate."
    );
  }
  return new Decimal(String(approved.rate)).toFixed();
}

/**
 * A posted foreign-currency voucher has an immutable transaction date, currency
 * and historical rate. Changing them is a reversal/rebook, not a silent edit.
 * The caller must fetch the original voucher under the active company scope.
 */
export function assertLockedZmwVoucherEdit(
  original: { currency?: string | null; voucherDate: string; exchangeRate?: string | number | null },
  update: { currency?: unknown; voucherDate?: unknown; exchangeRate?: unknown }
): void {
  const wasZmw = String(original.currency ?? "USD").toUpperCase() === "ZMW";
  if (!wasZmw) {
    if (update.currency != null && String(update.currency).toUpperCase() === "ZMW") {
      throw new ZambiaVoucherRateError("Changing an existing voucher currency to ZMW requires reversal and rebooking.");
    }
    return;
  }
  if (update.currency != null && String(update.currency).toUpperCase() !== "ZMW") {
    throw new ZambiaVoucherRateError("Posted ZMW voucher currency is locked.");
  }
  if (
    update.voucherDate != null &&
    String(update.voucherDate).slice(0, 10) !== String(original.voucherDate).slice(0, 10)
  ) {
    throw new ZambiaVoucherRateError("Changing the date of a ZMW voucher requires reversal and rebooking.");
  }
  // Voucher storage can pad the approved 6dp company rate to 10 decimal
  // places. Validate a stored positive numeric value without applying the
  // *user-input* precision restriction to the database's string formatting.
  const originalText = String(original.exchangeRate ?? "");
  let lockedRate: Decimal;
  try {
    lockedRate = new Decimal(originalText);
  } catch {
    throw new ZambiaVoucherRateError("Original ZMW voucher has no valid locked rate.");
  }
  if (!lockedRate.isFinite() || lockedRate.lte(0)) {
    throw new ZambiaVoucherRateError("Original ZMW voucher has no valid locked rate.");
  }
  if (update.exchangeRate != null) {
    let proposed: Decimal;
    try {
      proposed = new Decimal(String(update.exchangeRate));
    } catch {
      throw new ZambiaVoucherRateError("Posted ZMW voucher exchange rate cannot be changed.");
    }
    if (!proposed.isFinite() || !proposed.eq(lockedRate)) {
      throw new ZambiaVoucherRateError("Posted ZMW voucher exchange rate cannot be changed.");
    }
  }
}

/**
 * Confirm that a posted ZMW voucher has recoverable original native amounts.
 * An engine-owned, USD-only base rounding line is a legitimate exception,
 * identified by BOTH the designated company ROUNDING account and the engine's
 * exact narration. An arbitrary USD line is NOT an exception.
 */
export async function assertResolvedZmwVoucherEntriesTx(
  tx: DbTransaction,
  companyId: number,
  entries: readonly {
    ledgerAccountId: number | null;
    narration: string | null;
    transactionCurrency: string | null;
    transactionDebitAmount: string | null;
    transactionCreditAmount: string | null;
    historicalExchangeRate: string | null;
  }[]
): Promise<void> {
  const [rounding] = await tx
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(and(eq(ledgerAccounts.companyId, companyId), eq(ledgerAccounts.code, ROUNDING_ACCOUNT_CODE)))
    .limit(1);
  let nativeEntries = 0;
  for (const entry of entries) {
    if (
      rounding &&
      entry.ledgerAccountId === rounding.id &&
      entry.narration === ENGINE_ROUNDING_NARRATION &&
      entry.transactionCurrency === "USD"
    ) {
      continue;
    }
    if (
      entry.transactionCurrency !== "ZMW" ||
      entry.transactionDebitAmount == null ||
      entry.transactionCreditAmount == null ||
      entry.historicalExchangeRate == null
    ) {
      throw new ZambiaVoucherRateError(
        "Original ZMW amounts/rate are unresolved. Reconcile the voucher before editing it."
      );
    }
    nativeEntries++;
  }
  if (nativeEntries === 0) {
    throw new ZambiaVoucherRateError("No native ZMW entries remain to edit.");
  }
}
