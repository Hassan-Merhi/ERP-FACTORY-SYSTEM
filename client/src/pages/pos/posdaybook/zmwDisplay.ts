import { formatMoneyDisplay } from "@/lib/moneyDisplay";
import { calculateZmwSaleAmounts, resolveZmwUnitPrice } from "@shared/posZmwMoney";

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

/** Prefer the entry's actual native cash/receivable debit, never a current FX quote. */
export function postedPosZmwAmount(voucher: PosZmwVoucherDisplay | null | undefined): number | null {
  if (voucher?.currency !== "ZMW") return null;
  const fromEntry = voucher.entries?.find(
    (entry) => entry.transactionCurrency === "ZMW" && Number(entry.transactionDebitAmount) > 0
  )?.transactionDebitAmount;
  const native = fromEntry ?? voucher.nativeZmwTotal;
  const numeric = native == null ? Number.NaN : Number(native);
  if (Number.isFinite(numeric)) return numeric;
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
  baseFormatter: (value: number) => string
): string {
  const rate = lockedZmwRate(voucher);
  if (rate == null) return baseFormatter(Number(usdUnit));
  const native = resolveZmwUnitPrice({ quantity: 1, rate: usdUnit }, rate, true);
  return formatMoneyDisplay(native.toNumber(), { currency: "ZMW" });
}

export function formatPosZmwLineTotal(
  voucher: PosZmwVoucherDisplay | null | undefined,
  quantity: string | number,
  usdUnit: string | number,
  baseFormatter: (value: number) => string
): string {
  const rate = lockedZmwRate(voucher);
  if (rate == null) return baseFormatter(Number(quantity) * Number(usdUnit));
  const total = calculateZmwSaleAmounts([{ quantity, rate: usdUnit }], rate, true);
  return formatMoneyDisplay(Number(total.nativeTotal), { currency: "ZMW" });
}
