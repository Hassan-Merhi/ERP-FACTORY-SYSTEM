import type Decimal from "decimal.js";
import type { ErpVoucherLine } from "../accounting/erpVoucherPosting";
import { cents, signedPair } from "./tradeRevisionMath";

/**
 * An internal container moves at cost, so Properties must not retain revenue
 * or COGS from selling goods to itself. This is *not* a cash/stock adjustment.
 *
 * Positive amount: Dr internal Sales / Cr internal COGS
 * Negative amount: Cr internal Sales / Dr internal COGS
 * The external supplier and intercompany balances are unchanged.
 */
export function technicalProfitNettingLines(
  salesAccountId: number,
  costAccountId: number,
  signedAmount: Decimal.Value
): ErpVoucherLine[] {
  if (!Number.isSafeInteger(salesAccountId) || salesAccountId <= 0 ||
      !Number.isSafeInteger(costAccountId) || costAccountId <= 0 ||
      salesAccountId === costAccountId) {
    throw new Error("Internal sales and COGS must be distinct valid company ledger accounts");
  }
  return signedPair(
    { ledgerAccountId: salesAccountId },
    { ledgerAccountId: costAccountId },
    cents(signedAmount),
    "Neutralize technical internal sales and COGS at cost"
  );
}
