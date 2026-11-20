import Decimal from "decimal.js";
import type { VoucherEntryInsertFields } from "./accountingTypes";

function present(value: unknown): boolean {
  return value != null && String(value).trim() !== "";
}

/**
 * A reversal line as the ledger stores it: a fully normalized multi-currency
 * line keeps its base amounts; a legacy line is mirrored as identity-rate USD.
 */
export function ledgerExactMirrorLine(entry: VoucherEntryInsertFields): VoucherEntryInsertFields {
  const normalized =
    present(entry.transactionCurrency) &&
    present(entry.transactionDebitAmount) &&
    present(entry.transactionCreditAmount) &&
    present(entry.baseDebitAmount) &&
    present(entry.baseCreditAmount) &&
    present(entry.historicalExchangeRate) &&
    present(entry.rateConvention);
  if (normalized) {
    return { ...entry, debitAmount: String(entry.baseDebitAmount), creditAmount: String(entry.baseCreditAmount) };
  }
  const debit = new Decimal(entry.debitAmount ?? "0");
  const credit = new Decimal(entry.creditAmount ?? "0");
  return {
    ...entry,
    debitAmount: debit.toFixed(2),
    creditAmount: credit.toFixed(2),
    transactionCurrency: "USD",
    transactionDebitAmount: debit.toFixed(6),
    transactionCreditAmount: credit.toFixed(6),
    baseDebitAmount: debit.toFixed(6),
    baseCreditAmount: credit.toFixed(6),
    historicalExchangeRate: "1.0000000000",
    rateConvention: "IDENTITY",
  };
}
