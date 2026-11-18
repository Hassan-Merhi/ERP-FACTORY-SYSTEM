import { describe, expect, it } from "vitest";
import { exactCfaSaleAmounts, resolvePostedCfaUnitPrices } from "../shared/posCfaMoney";
import { posSaleLines } from "../server/services/pos/saleAccountingLines";
import { buildErpVoucherEntries } from "../server/services/accounting/erpVoucherPosting";
import { posNativeSaleAmounts } from "../server/services/pos/posZmwRatePolicy";

const usd = (cfa: number, rate: number) => (cfa / rate).toFixed(6);

describe("Mali POS exact CFA totals", () => {
  it("posts the CFA the cashier typed, not the rounded USD total times the rate", () => {
    // 13 lines at 613 used to post 4,839,996.67 CFA for a 4,840,000 CFA sale.
    const lines = [
      { quantity: "40", rate: usd(40000, 613), originalCurrencyRate: "40000.00" },
      { quantity: "52", rate: usd(40000, 613), originalCurrencyRate: "40000.00" },
      { quantity: "5", rate: usd(60000, 613), originalCurrencyRate: "60000.00" },
      { quantity: "4", rate: usd(55000, 613), originalCurrencyRate: "55000.00" },
      { quantity: "2", rate: usd(75000, 613), originalCurrencyRate: "75000.00" },
    ];
    const amounts = exactCfaSaleAmounts(lines, "613");
    expect(amounts).toEqual({ nativeTotal: "4350000.00", usdTotal: 7096.25 });
    expect(amounts!.usdTotal * 613).not.toBe(4350000);

    const entries = buildErpVoucherEntries(
      posSaleLines({
        grandTotal: amounts!.usdTotal,
        nativeZmwTotal: amounts!.nativeTotal,
        payment: { ledgerAccountId: 7 },
        paymentNarration: "POS sale",
        revenue: { target: { ledgerAccountId: 8 }, narration: "Sales" },
        currency: "CFA",
        exchangeRate: "613",
      })
    );
    expect(entries[0].transactionCurrency).toBe("CFA");
    expect(entries[0].transactionDebitAmount).toBe("4350000.000000");
    expect(entries[1].transactionCreditAmount).toBe("4350000.000000");
    expect(entries[0].baseDebitAmount).toBe(entries[1].baseCreditAmount);
  });

  it("keeps the previous posting when a sale does not carry trustworthy CFA prices", () => {
    const good = { quantity: "1", rate: usd(40000, 605), originalCurrencyRate: "40000" };
    // Older clients and USD-priced edits send no CFA price.
    expect(exactCfaSaleAmounts([good, { quantity: "1", rate: "66.12" }], "605")).toBeNull();
    // A CFA price that disagrees with the USD price it travelled with is ignored, never posted.
    expect(exactCfaSaleAmounts([{ quantity: "1", rate: "66.12", originalCurrencyRate: "400000" }], "605")).toBeNull();
    expect(exactCfaSaleAmounts([{ quantity: "1", rate: "66.12", originalCurrencyRate: "40000" }], "605")).toBeNull();
    expect(exactCfaSaleAmounts([good], "0")).toBeNull();
    expect(exactCfaSaleAmounts([good], null)).toBeNull();
    expect(exactCfaSaleAmounts([{ ...good, quantity: "0" }], "605")).toBeNull();
    expect(exactCfaSaleAmounts([], "605")).toBeNull();
    expect(exactCfaSaleAmounts([good], "605")).toEqual({ nativeTotal: "40000.00", usdTotal: 66.12 });
  });

  it("resolves native amounts per company currency and leaves supplier-partner CFA sales on the USD posting", () => {
    const cfa = [{ quantity: "2", rate: usd(45000, 605), originalCurrencyRate: "45000" }];
    const locked = { currency: "CFA", exchangeRate: "605" };
    expect(posNativeSaleAmounts(cfa, locked, false)).toEqual({ nativeTotal: "90000.00", usdTotal: 148.76 });
    expect(posNativeSaleAmounts(cfa, locked, true)).toBeNull();
    expect(posNativeSaleAmounts(cfa, { currency: "USD", exchangeRate: null }, false)).toBeNull();
    const zmw = [{ quantity: "1", rate: "96.153846", originalCurrencyRate: "2000.00" }];
    expect(posNativeSaleAmounts(zmw, { currency: "ZMW", exchangeRate: "20.8" }, false)).toEqual({
      nativeTotal: "2000.00",
      usdTotal: 96.15,
    });
  });
});

describe("Mali POS reading a posted sale back in CFA", () => {
  const prices = (lines: { quantity: number; sellingPrice: string }[], rate: string, posted: string | null) =>
    resolvePostedCfaUnitPrices(lines, rate, posted)!.map((unit) => unit.toFixed(0));

  // A real legacy sale: cent-rounded USD prices at 605, posted as 700,003.15 CFA.
  const legacy = [
    { quantity: 2, sellingPrice: "74.380000" },
    { quantity: 5, sellingPrice: "90.910000" },
    { quantity: 2, sellingPrice: "115.700000" },
    { quantity: 3, sellingPrice: "66.120000" },
    { quantity: 1, sellingPrice: "57.850000" },
    { quantity: 1, sellingPrice: "66.120000" },
  ];

  it("reads cent-rounded legacy prices back as the round CFA prices that were typed", () => {
    expect(prices(legacy, "605", "700003.150000")).toEqual(["45000", "55000", "70000", "40000", "35000", "40000"]);
    // 42,997.35 can only be 43,000; 42,501.25 can only be 42,500.
    expect(prices([{ quantity: 1, sellingPrice: "71.07" }], "605", null)).toEqual(["43000"]);
    expect(prices([{ quantity: 93, sellingPrice: "70.25" }], "605", null)).toEqual(["42500"]);
  });

  it("keeps the nearest franc when the round reading does not fit the posted total", () => {
    expect(prices(legacy, "605", "650000.00")).toEqual(["45000", "55001", "69999", "40003", "34999", "40003"]);
    // A sale that posted an exact, non-round total is exactly that.
    expect(prices([{ quantity: 1, sellingPrice: "66.12" }], "605", "40003.00")).toEqual(["40003"]);
  });

  it("leaves six-decimal prices and supplied CFA prices exactly as they are", () => {
    expect(prices([{ quantity: 40, sellingPrice: "65.252855" }], "613", "1600000.00")).toEqual(["40000"]);
    expect(prices([{ quantity: 1, sellingPrice: "65.257749" }], "613", null)).toEqual(["40003"]);
    const typed = [{ quantity: 1, sellingPrice: "66.12", originalCurrencyRate: "40001" }];
    expect(resolvePostedCfaUnitPrices(typed, "605", null)![0].toFixed(0)).toBe("40001");
  });

  it("refuses an unusable rate or price instead of guessing", () => {
    expect(resolvePostedCfaUnitPrices(legacy, "0", null)).toBeNull();
    expect(resolvePostedCfaUnitPrices([{ quantity: 1, sellingPrice: "abc" }], "605", null)).toBeNull();
  });
});
