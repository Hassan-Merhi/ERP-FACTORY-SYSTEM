import { describe, expect, it } from "vitest";
import { supplierUsdEquivalent } from "../server/routes/factory/suppliers/balance/supplierUsdEquivalent";

const rates = { EUR: 1.18, AUD: 0.75, GBP: 1.33 };

describe("supplier current-rate USD equivalent (report only)", () => {
  it("uses USD opening exactly once and leaves USD-only balances unchanged", () => {
    expect(supplierUsdEquivalent([{ currencyCode: "USD", balance: "12.15" }], rates, "3.40"))
      .toEqual({ usdEquivalentBalance: "15.55", usdEquivalentMissingRates: [] });
    expect(supplierUsdEquivalent([], rates, "25.00").usdEquivalentBalance).toBe("25.00");
  });

  it("converts each mixed-currency signed net at Factory Settings rates", () => {
    expect(
      supplierUsdEquivalent(
        [
          { currencyCode: "USD", balance: "100" },
          { currencyCode: "AUD", balance: "-20" },
          { currencyCode: "EUR", balance: "50" },
          { currencyCode: "GBP", balance: "10" },
        ],
        rates
      )
    ).toEqual({ usdEquivalentBalance: "157.30", usdEquivalentMissingRates: [] });
  });

  it("does not require other currencies for USD + EUR or USD + AUD", () => {
    expect(supplierUsdEquivalent([
      { currencyCode: "USD", balance: "100" },
      { currencyCode: "EUR", balance: "50" },
    ], rates).usdEquivalentBalance).toBe("159.00");
    expect(supplierUsdEquivalent([
      { currencyCode: "USD", balance: "100" },
      { currencyCode: "AUD", balance: "20" },
    ], rates).usdEquivalentBalance).toBe("115.00");
  });

  it("subtracts overpayments without absolute-valuing or changing signs", () => {
    expect(supplierUsdEquivalent([
      { currencyCode: "USD", balance: "-10" },
      { currencyCode: "AUD", balance: "-10" },
    ], rates).usdEquivalentBalance).toBe("-17.50");
  });

  it("marks nonzero unpriced balances unresolved, never returns a partial USD amount", () => {
    expect(supplierUsdEquivalent([
      { currencyCode: "USD", balance: "200" },
      { currencyCode: "CAD", balance: "75" },
      { currencyCode: "JPY", balance: "-10" },
    ], rates)).toEqual({
      usdEquivalentBalance: null,
      usdEquivalentMissingRates: ["CAD", "JPY"],
    });
    expect(supplierUsdEquivalent([
      { currencyCode: "USD", balance: "200" },
      { currencyCode: "CAD", balance: "0" },
    ], rates).usdEquivalentBalance).toBe("200.00");
  });

  it("converts the broker's own signed pools without adding linked suppliers", () => {
    expect(supplierUsdEquivalent([
      { currencyCode: "EUR", balance: "27932.85" },
      { currencyCode: "USD", balance: "-0.01" },
    ], rates).usdEquivalentBalance).toBe("32960.75");
  });
});
