import { formatMoneyDisplay } from "@/lib/moneyDisplay";
import { calculateZmwSaleAmounts, resolvePostedZmwUnitPrices, resolveZmwUnitPrice } from "@shared/posZmwMoney";

export interface PosZmwVoucherDisplay {
  currency?: string | null;
  exchangeRate?: string | null;
  totalAmount?: number | string;
  nativeZmwTotal?: number | string | null;
  entries?: Array<{
    transactionCurrency?: string | null;
    transactionDebitAmount?: string | number | null;
  }>;
}

function lockedZmwRate(voucher: PosZmwVoucherDisplay | null | undefined): number | null {
  const rate = Number(voucher?.exchangeRate);
  return voucher?.currency === "ZMW" && Number.isFinite(rate) && rate > 0 ? rate : null;
}

/** The Kwacha amount the sale actually posted, or null when the voucher does not carry it. */
export function recordedPosZmwAmount(voucher: PosZmwVoucherDisplay | null | undefined): number | null {
  if (voucher?.currency !== "ZMW") return null;
  const fromEntry = voucher.entries?.find(
    (entry) => entry.transactionCurrency === "ZMW" && Number(entry.transactionDebitAmount) > 0
  )?.transactionDebitAmount;
  const native = fromEntry ?? voucher.nativeZmwTotal;
  const numeric = native == null ? Number.NaN : Number(native);
  return Number.isFinite(numeric) ? numeric : null;
}

/**
 * Kwacha unit price of each sale line at the voucher's locked rate, checked
 * against the posted Kwacha total; null when the voucher is not a Kwacha sale.
 */
export function postedPosZmwUnitPrices(
  voucher: PosZmwVoucherDisplay | null | undefined,
  items: ReadonlyArray<{ quantity: string | number; sellingPrice: string | number }>
): number[] | null {
  const rate = lockedZmwRate(voucher);
  if (rate == null) return null;
  try {
    return resolvePostedZmwUnitPrices(
      items.map((item) => ({ quantity: item.quantity, rate: item.sellingPrice })),
      rate,
      recordedPosZmwAmount(voucher)
    ).map((unit) => unit.toNumber());
  } catch {
    return null; // a line that is not a valid sale line: the per-line formatters handle it
  }
}

/** Prefer the entry's actual native cash/receivable debit, never a current FX quote. */
export function postedPosZmwAmount(voucher: PosZmwVoucherDisplay | null | undefined): number | null {
  if (voucher?.currency !== "ZMW") return null;
  const recorded = recordedPosZmwAmount(voucher);
  if (recorded !== null) return recorded;
  const rate = lockedZmwRate(voucher);
  return rate == null ? null : Number(voucher?.totalAmount ?? 0) * rate;
}

export function formatPosVoucherAmount(
  voucher: PosZmwVoucherDisplay | null | undefined,
  baseFormatter: (value: number) => string
): string {
  const native = postedPosZmwAmount(voucher);
  if (native !== null) return formatMoneyDisplay(native, { currency: "ZMW" });
  return baseFormatter(Number(voucher?.totalAmount ?? 0));
}

export function formatPosZmwUnitPrice(
  voucher: PosZmwVoucherDisplay | null | undefined,
  usdUnit: string | number,
  baseFormatter: (value: number) => string,
  nativeUnit?: number
): string {
  const rate = lockedZmwRate(voucher);
  if (rate == null) return baseFormatter(Number(usdUnit));
  const native = nativeUnit ?? resolveZmwUnitPrice({ quantity: 1, rate: usdUnit }, rate, true).toNumber();
  return formatMoneyDisplay(native, { currency: "ZMW" });
}

export function formatPosZmwLineTotal(
  voucher: PosZmwVoucherDisplay | null | undefined,
  quantity: string | number,
  usdUnit: string | number,
  baseFormatter: (value: number) => string,
  nativeUnit?: number
): string {
  const rate = lockedZmwRate(voucher);
  if (rate == null) return baseFormatter(Number(quantity) * Number(usdUnit));
  const line =
    nativeUnit === undefined
      ? { quantity, rate: usdUnit }
      : { quantity, rate: usdUnit, originalCurrencyRate: nativeUnit.toFixed(2) };
  const total = calculateZmwSaleAmounts([line], rate, true);
  return formatMoneyDisplay(Number(total.nativeTotal), { currency: "ZMW" });
}
