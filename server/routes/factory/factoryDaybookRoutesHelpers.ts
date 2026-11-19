// Extracted from ./factoryDaybookRoutes.ts: shared helpers.
import { toMoney } from "../../lib/money";

/**
 * A live voucher's daybook amounts: the voucher total, its rate (1 when unset
 * or zero) and the USD amount at cents. The USD amount was the whole float
 * product, so 1.13 at 1.5 showed 1.6949999999999998.
 */
export function liveVoucherAmounts(v: {
  currency: string | null;
  exchangeRate: string | null;
  totalAmount: string | null;
}) {
  const currency = v.currency || "USD";
  const rate = toMoney(v.exchangeRate || "1");
  const fxRate = rate.isZero() ? toMoney(1) : rate;
  const amtCurrency = toMoney(v.totalAmount);
  const amtUsd = currency === "USD" ? amtCurrency : amtCurrency.times(fxRate).toDecimalPlaces(2);
  return { currency, fxRate: fxRate.toString(), amtCurrency: amtCurrency.toString(), amtUsd: amtUsd.toString() };
}
