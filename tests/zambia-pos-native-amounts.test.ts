import { describe, expect, it } from "vitest";
import { calculateZmwSaleAmounts, resolveZmwUnitPrice } from "../shared/posZmwMoney";
import { posSaleLines } from "../server/services/pos/saleAccountingLines";
import { buildErpVoucherEntries } from "../server/services/accounting/erpVoucherPosting";

const rate = "26.5";

describe("Zambia POS exact native Kwacha totals", () => {
  it("keeps K5,000.00 as K5,000.00 when converted to USD for the ledger", () => {
    const value = calculateZmwSaleAmounts(
      [{ quantity: "1", originalCurrencyRate: "5000.00", rate: "188.679245" }],
      rate
    );
    expect(value).toEqual({ nativeTotal: "5000.00", usdTotal: 188.68 });
    // USD-first revaluation would display K5,000.02 instead of K5,000.
    expect(value.usdTotal * Number(rate)).not.toBe(5000);
  });

  it("sums native ngwee with half-up rounding per line, including fractional quantities", () => {
    const lines = [
      { quantity: "1.5", originalCurrencyRate: "10.01" },
      { quantity: "2", originalCurrencyRate: "12.25" },
    ];
    expect(calculateZmwSaleAmounts(lines, rate)).toEqual({ nativeTotal: "39.52", usdTotal: 1.49 });
  });

  it("can reconstruct a prior six-decimal USD unit price at the saved voucher rate", () => {
    const item = { quantity: "1", sellingPrice: "188.679245" };
    expect(resolveZmwUnitPrice(item, rate, true).toFixed(2)).toBe("5000.00");
    expect(calculateZmwSaleAmounts([item], rate, true).nativeTotal).toBe("5000.00");
    expect(() => calculateZmwSaleAmounts([item], rate)).toThrow("original Kwacha unit price");
  });

  it("reads a legacy cent-rounded USD price back as the whole Kwacha the cashier typed", () => {
    // K2,000 at 20.8 was stored as $96.15; 96.15 x 20.8 is K1,999.92.
    const legacy = (usd: string) => resolveZmwUnitPrice({ quantity: 1, rate: usd }, "20.8", true).toFixed(2);
    expect(legacy("96.15")).toBe("2000.00");
    expect(legacy("144.230000")).toBe("3000.00");
    expect(legacy("139.42")).toBe("2900.00");
    expect(legacy("77.88")).toBe("1620.00");
    expect(calculateZmwSaleAmounts([{ quantity: 5, rate: "77.88" }], "20.8", true).nativeTotal).toBe("8100.00");
    // No whole Kwacha rounds to this cent, so the nearest ngwee stands.
    expect(legacy("96.13")).toBe("1999.50");
    // Six-decimal prices are exact and never snapped.
    expect(legacy("96.149519")).toBe("1999.91");
    expect(legacy("96.153846")).toBe("2000.00");
  });

  it("rejects invalid native unit precision and quantity, rather than silently truncating", () => {
    const wrongPrecision = () => calculateZmwSaleAmounts([{ quantity: "1", originalCurrencyRate: "10.001" }], rate);
    const missingQuantity = () => calculateZmwSaleAmounts([{ quantity: "0", originalCurrencyRate: "10.00" }], rate);
    const invalidRate = () => calculateZmwSaleAmounts([{ quantity: "1", originalCurrencyRate: "10.00" }], "0");
    expect(wrongPrecision).toThrow("at most two decimals");
    expect(missingQuantity).toThrow("Sale quantities must be positive");
    expect(invalidRate).toThrow("positive USD/ZMW rate");
  });

  it("posts exact K5,000 on both payment and revenue entries without drifting on USD conversion", () => {
    const amounts = calculateZmwSaleAmounts([{ quantity: 1, originalCurrencyRate: "5000.00" }], rate);
    const lines = posSaleLines({
      grandTotal: amounts.usdTotal,
      nativeZmwTotal: amounts.nativeTotal,
      payment: { ledgerAccountId: 7 },
      paymentNarration: "POS sale",
      revenue: { target: { ledgerAccountId: 8 }, narration: "Sales" },
      currency: "ZMW",
      exchangeRate: rate,
    });
    const entries = buildErpVoucherEntries(lines);
    expect(entries[0].transactionCurrency).toBe("ZMW");
    expect(entries[0].transactionDebitAmount).toBe("5000.000000");
    expect(entries[1].transactionCreditAmount).toBe("5000.000000");
    expect(entries[0].baseDebitAmount).toBe(entries[1].baseCreditAmount);
  });

  it("keeps USD and CFA accounting paths unchanged when no exact ZMW amount is specified", () => {
    const common = {
      grandTotal: "20",
      payment: { ledgerAccountId: 7 },
      paymentNarration: "Sale",
      revenue: { target: { ledgerAccountId: 8 }, narration: "Revenue" },
    };
    expect(posSaleLines({ ...common, currency: "USD" })[0].transaction).toBeNull();
    const cfa = posSaleLines({ ...common, currency: "CFA", exchangeRate: "600" });
    expect(String(cfa[0].transaction?.amount)).toBe("12000");
  });
});
