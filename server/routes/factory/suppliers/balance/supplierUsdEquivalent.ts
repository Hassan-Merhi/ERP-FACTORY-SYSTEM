/**
 * Current-rate USD equivalent for a supplier's signed native-currency balances.
 *
 * Reporting only: never changes transaction currency, historical USD base, or the
 * accounting ledger. Cr-positive balances add; Dr/overpaid balances subtract.
 * A missing rate makes the total unavailable, not a misleading partial total.
 */
import { toMoney } from "../../../../lib/money";

export interface SupplierNativeForDisplay {
  currencyCode: string;
  balance: string | number;
}

export interface SupplierUsdEquivalent {
  usdEquivalentBalance: string | null;
  usdEquivalentMissingRates: string[];
}

export function supplierUsdEquivalent(
  balances: readonly SupplierNativeForDisplay[],
  rateToUsd: Readonly<Record<string, number>>,
  usdOpening: string | number = "0"
): SupplierUsdEquivalent {
  let total = toMoney(usdOpening);
  const missing = new Set<string>();

  for (const bucket of balances) {
    const amount = toMoney(bucket.balance);
    if (amount.abs().lte(0.005)) continue;
    const currency = String(bucket.currencyCode || "USD").toUpperCase();
    const rate = currency === "USD" ? 1 : rateToUsd[currency];
    if (rate === undefined || !Number.isFinite(rate) || rate <= 0) {
      missing.add(currency);
      continue;
    }
    total = total.plus(amount.times(rate));
  }

  return {
    usdEquivalentBalance: missing.size > 0 ? null : total.toFixed(2),
    usdEquivalentMissingRates: [...missing].sort(),
  };
}
