// resolveLegacyTransactionAmounts fallbacks for legacy voucher_entries rows
// with missing amounts, a missing voucher currency, or unusable currencies/rates.
import { describe, expect, it } from "vitest";
import { resolveLegacyTransactionAmounts } from "../server/services/accounting/currencyAmounts";

const legacy = (overrides: Partial<Parameters<typeof resolveLegacyTransactionAmounts>[0]>) =>
  resolveLegacyTransactionAmounts({
    existingTransactionCurrency: null,
    voucherCurrency: "USD",
    baseCurrency: "USD",
    storedDebitAmount: "0",
    storedCreditAmount: "0",
    voucherExchangeRate: null,
    ...overrides,
  });

describe("resolveLegacyTransactionAmounts fallbacks", () => {
  it("treats missing stored amounts as zero", () => {
    expect(legacy({ storedDebitAmount: null, storedCreditAmount: undefined })).toMatchObject({
      transactionCurrency: "USD",
      transactionDebitAmount: "0.000000",
      transactionCreditAmount: "0.000000",
      baseDebitAmount: "0.000000",
      baseCreditAmount: "0.000000",
      historicalExchangeRate: "1.0000000000",
    });
  });

  it("uses the base currency when the voucher has no currency", () => {
    expect(legacy({ voucherCurrency: null, storedDebitAmount: "12.5" })).toMatchObject({
      transactionCurrency: "USD",
      transactionDebitAmount: "12.500000",
      baseDebitAmount: "12.500000",
    });
    expect(legacy({ voucherCurrency: "", storedCreditAmount: "3" })).toMatchObject({
      transactionCurrency: "USD",
      transactionCreditAmount: "3.000000",
    });
  });

  it("derives non-base amounts from missing stored amounts at the voucher rate", () => {
    expect(
      legacy({ voucherCurrency: "CFA", storedDebitAmount: null, storedCreditAmount: "2", voucherExchangeRate: "600" })
    ).toMatchObject({
      transactionDebitAmount: "0.000000",
      transactionCreditAmount: "1200.000000",
      baseCreditAmount: "2.000000",
    });
  });

  it("requires manual review for unknown currencies or an invalid rate", () => {
    expect(legacy({ voucherCurrency: "NOT-A-CURRENCY" })).toBeNull();
    expect(legacy({ voucherCurrency: null, baseCurrency: "NOT-A-CURRENCY" })).toBeNull();
    expect(legacy({ voucherCurrency: "CFA", voucherExchangeRate: "-1" })).toBeNull();
  });
});
