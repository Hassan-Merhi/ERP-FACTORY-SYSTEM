import { describe, expect, it } from "vitest";

import { normFactoryEntry } from "../server/routes/factory/containers/_helpers";
import { RateConvention } from "../server/services/accounting/currencyAmounts";

describe("factory container voucher FX normalization", () => {
  it("uses the saved AUD factory fxRateToUsd without the general ERP currency whitelist", () => {
    const entry = normFactoryEntry("AUD", "15907.50", "0", "0.71255");

    expect(entry).toEqual({
      transactionCurrency: "AUD",
      transactionDebitAmount: "15907.500000",
      transactionCreditAmount: "0.000000",
      baseDebitAmount: "11334.889125",
      baseCreditAmount: "0.000000",
      historicalExchangeRate: "1.4034102870",
      rateConvention: RateConvention.TRANSACTION_PER_BASE,
      debitAmount: "11334.889125",
      creditAmount: "0.000000",
    });
  });

  it("preserves other factory currencies while applying their stored FX rate", () => {
    const entry = normFactoryEntry("LBP", "0", "895000", "0.0000112");

    expect(entry.transactionCurrency).toBe("LBP");
    expect(entry.baseCreditAmount).toBe("10.024000");
    expect(entry.rateConvention).toBe(RateConvention.TRANSACTION_PER_BASE);
  });

  it("keeps USD entries at identity rate", () => {
    const entry = normFactoryEntry("USD", "500", "0", null);

    expect(entry.baseDebitAmount).toBe("500.000000");
    expect(entry.historicalExchangeRate).toBe("1.0000000000");
    expect(entry.rateConvention).toBe(RateConvention.IDENTITY);
  });

  it("refuses to invent a rate for a foreign-currency factory voucher", () => {
    expect(() => normFactoryEntry("AUD", "500", "0", null)).toThrow("Factory fxRateToUsd for AUD is required");
  });
});
