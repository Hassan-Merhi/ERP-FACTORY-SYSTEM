/**
 * Zambia POS exchange-rate protection.
 *
 * POS and sale_items store USD prices. The voucher has a foreign currency and
 * per-entry original amount using the historically approved rate for the SALE
 * DATE. Never use today's rate to post a backdated ZMW sale or edit.
 *
 * Existing Mali/CFA transactions are intentionally outside this Zambia-specific
 * guard until their current legacy policies are migrated separately.
 */
import Decimal from "decimal.js";
import { storage } from "../../storage";
import { companyBusinessDate } from "../accounting/companyBusinessDate";
import { companyRateDateSchema, companyRateValueSchema } from "@shared/companyRatePolicy";
import { calculateZmwSaleAmounts, type ZmwSaleLine } from "@shared/posZmwMoney";
import { exactCfaSaleAmounts } from "@shared/posCfaMoney";

export class PosZmwRateError extends Error {
  readonly statusCode = 409;
  readonly code = "POS_ZMW_RATE_REQUIRED";
  constructor(message: string) {
    super(message);
    this.name = "PosZmwRateError";
  }
}

export interface LockedPosCurrency {
  currency: string;
  exchangeRate: string | null;
}

export async function resolveLockedZmwPosCurrency(
  companyId: number,
  voucherDate: string,
  currency: string | null | undefined,
  suppliedRate: string | number | null | undefined
): Promise<LockedPosCurrency> {
  const code = String(currency || "USD").toUpperCase();
  const company = await storage.getCompanyById(companyId);
  // Preserve legacy other-company currency handling. Zambia only allows USD
  // or its configured Kwacha pair, preventing cross-company CFA rate use.
  if (company?.displayCurrency === "ZMW" && code !== "USD" && code !== "ZMW") {
    throw new PosZmwRateError("Zambia POS accepts only USD and ZMW.");
  }
  if (code !== "ZMW") return { currency: code, exchangeRate: suppliedRate == null ? null : String(suppliedRate) };
  if (!companyRateDateSchema.safeParse(voucherDate).success) {
    throw new PosZmwRateError("Enter a valid sale date before posting a Kwacha sale.");
  }
  // The effective-dated company rate may legitimately predate a sale, but
  // tomorrow's sale must never be booked today against an earlier rate.
  const currentBusinessDate = await companyBusinessDate(companyId);
  if (voucherDate > currentBusinessDate) {
    throw new PosZmwRateError(
      "Future-dated Kwacha sales/refunds are not allowed. Select a business date on or before today."
    );
  }
  if (!company || company.baseCurrency !== "USD" || company.displayCurrency !== "ZMW") {
    throw new PosZmwRateError("USD/ZMW must be configured for the active company before posting Kwacha sales.");
  }
  const today = await companyBusinessDate(companyId);
  if (voucherDate > today) {
    throw new PosZmwRateError("Cannot post a future-dated Kwacha sale or refund with a future exchange rate.");
  }
  const dated = await storage.getExchangeRateForDate(companyId, "USD", "ZMW", voucherDate);
  if (!dated || !companyRateValueSchema.safeParse(String(dated.rate)).success) {
    throw new PosZmwRateError("No approved USD/ZMW exchange rate exists on or before the sale date.");
  }
  const locked = new Decimal(String(dated.rate));
  const submitted =
    suppliedRate === undefined || suppliedRate === null || suppliedRate === "" ? null : String(suppliedRate);
  // An old browser tab or an intentionally backdated form must reload the rate
  // instead of posting USD lines calculated using a mismatched current rate.
  if (!submitted || !companyRateValueSchema.safeParse(submitted).success || !new Decimal(submitted).eq(locked)) {
    throw new PosZmwRateError(
      "The USD/ZMW rate for this sale date differs from the selected rate. Reload the date-specific rate and recalculate the prices."
    );
  }
  return { currency: "ZMW", exchangeRate: locked.toFixed() };
}

/**
 * An imported Kwacha sheet travels as converted USD unit prices, but must
 * include each original Kwacha price as well. Reject forged/inconsistent USD
 * values before stock or ledger posting (6dp USD price round-trip tolerance).
 */
export function assertZmwImportPrices(
  rows: readonly { rate: unknown; originalCurrencyRate?: unknown }[],
  lockedCurrency: LockedPosCurrency
): void {
  if (lockedCurrency.currency !== "ZMW") return;
  if (!lockedCurrency.exchangeRate) throw new PosZmwRateError("ZMW rate was not locked.");
  const rate = new Decimal(lockedCurrency.exchangeRate);
  for (const [index, row] of rows.entries()) {
    const usd = String(row.rate ?? "");
    const native = String(row.originalCurrencyRate ?? "");
    if (!/^\d+(?:\.\d{1,6})?$/.test(usd) || !/^\d+(?:\.\d{1,6})?$/.test(native)) {
      throw new PosZmwRateError(`Excel line ${index + 1}: include a valid converted USD rate and original ZMW rate.`);
    }
    const usdValue = new Decimal(usd);
    const kwachaValue = new Decimal(native);
    if (
      !usdValue.gt(0) ||
      !kwachaValue.gt(0) ||
      usdValue.times(rate).minus(kwachaValue).abs().gt(rate.times("0.00000051"))
    ) {
      throw new PosZmwRateError(
        `Excel line ${index + 1}: USD amount does not match the original Kwacha price at the locked rate.`
      );
    }
  }
}

export { calculateZmwSaleAmounts };

/**
 * The exact local-currency total a sale posts, with its USD value, or null
 * when the sale posts its USD total x rate as before. Kwacha sales always
 * carry their typed prices (throws otherwise). A CFA sale does when the
 * client sent them and they agree with the USD prices. `keepUsdPosting` holds
 * a CFA sale on the previous posting: supplier-partner companies split the
 * payable in USD, and a sale captured on the factory LAN is replayed to the
 * cloud from cent-rounded prices, so both sides must post the same way.
 */
export function posNativeSaleAmounts(
  lines: readonly ZmwSaleLine[],
  lockedCurrency: LockedPosCurrency,
  keepUsdPosting: boolean,
  allowZmwReconstruction = false
): { nativeTotal: string; usdTotal: number } | null {
  if (lockedCurrency.currency === "ZMW") {
    return calculateZmwSaleAmounts(lines, lockedCurrency.exchangeRate!, allowZmwReconstruction);
  }
  if (lockedCurrency.currency === "CFA" && !keepUsdPosting) {
    return exactCfaSaleAmounts(lines, lockedCurrency.exchangeRate);
  }
  return null;
}

/** A new sale: reject forged Kwacha prices first, then resolve what it posts. */
export function checkedPosNativeSaleAmounts(
  lines: readonly (ZmwSaleLine & { rate: unknown })[],
  lockedCurrency: LockedPosCurrency,
  keepUsdPosting: boolean
): { nativeTotal: string; usdTotal: number } | null {
  assertZmwImportPrices(lines, lockedCurrency);
  return posNativeSaleAmounts(lines, lockedCurrency, keepUsdPosting);
}
