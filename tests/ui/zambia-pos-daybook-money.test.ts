import { describe, expect, it } from "vitest";
import {
  formatPosVoucherAmount,
  formatPosZmwLineTotal,
  formatPosZmwUnitPrice,
  postedPosZmwAmount,
} from "../../client/src/pages/pos/posdaybook/zmwDisplay";

describe("Zambia POS Daybook historical money display", () => {
  const sale = {
    currency: "ZMW",
    exchangeRate: "26.5",
    totalAmount: "188.68",
    nativeZmwTotal: "5000.00",
  };
  const usd = (amount: number) => `$${amount.toFixed(2)}`;

  it("uses the saved original native payment, not rounded USD multiplied by a new rate", () => {
    expect(postedPosZmwAmount(sale)).toBe(5000);
    expect(formatPosVoucherAmount(sale, usd)).toContain("5,000.00");
    expect(formatPosVoucherAmount({ ...sale, nativeZmwTotal: undefined, entries: [
      { transactionCurrency: "ZMW", transactionDebitAmount: "5000.000000" },
    ] }, usd)).toContain("5,000.00");
  });

  it("recovers exact unit price and line totals from six-decimal USD sale items", () => {
    expect(formatPosZmwUnitPrice(sale, "188.679245", usd)).toContain("5,000.00");
    expect(formatPosZmwLineTotal(sale, 1, "188.679245", usd)).toContain("5,000.00");
  });

  it("leaves base-currency USD vouchers unchanged", () => {
    const usdSale = { currency: "USD", totalAmount: "20" };
    expect(formatPosVoucherAmount(usdSale, usd)).toBe("$20.00");
    expect(formatPosZmwUnitPrice(usdSale, 20, usd)).toBe("$20.00");
  });
});
