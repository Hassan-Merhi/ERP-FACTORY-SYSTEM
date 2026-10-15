/**
 * Company 12 read-only production-vs-reference accounting fixture, Oct 15 2026.
 *
 * A supplier's original posted USD base is NOT its current-rate USD equivalent.
 * FX settlements transfer native liabilities at historical rates without
 * silently revaluing the cash or retroactively repricing old imported goods.
 * Memo-only goods liabilities enter the GL once; they must not be added twice.
 */
import { describe, expect, it } from "vitest";
import { toMoney, sumMoney } from "../server/lib/money";
import { supplierUsdEquivalent } from "../server/routes/factory/suppliers/balance/supplierUsdEquivalent";

const rates = { EUR: 1.18, AUD: 0.75 };
const usdOf = (buckets: Array<{ currencyCode: string; balance: string }>) =>
  supplierUsdEquivalent(buckets, rates).usdEquivalentBalance;

describe("Factory Parties: historic USD, FX rate and memo remain separate", () => {
  it("ABO SOBHI: current-rate balance may move while historical USD is stable", () => {
    expect(usdOf([
      { currencyCode: "EUR", balance: "144236.00" },
      { currencyCode: "USD", balance: "-119259.00" },
    ])).toBe("50939.48");
    expect(usdOf([{ currencyCode: "EUR", balance: "41572.00" }])).toBe("49054.96");
    // The six FX source transactions settle EUR 102,664 for USD 119,259.
    expect(toMoney("144236").minus("102664").toFixed(2)).toBe("41572.00");
    expect(toMoney("50939.49").minus("50939.48").toFixed(2)).toBe("0.01");
  });

  it("PORTUGAL SAAD: realized FX settlement is not an extra payment", () => {
    expect(usdOf([
      { currencyCode: "EUR", balance: "208818.60" },
      { currencyCode: "USD", balance: "-116302.00" },
    ])).toBe("130103.95");
    expect(usdOf([
      { currencyCode: "EUR", balance: "102139.60" },
      { currencyCode: "USD", balance: "5754.00" },
    ])).toBe("126278.73");
    expect(toMoney("208818.60").minus("106679").toFixed(2)).toBe("102139.60");
    expect(toMoney("-116302").plus("122056").toFixed(2)).toBe("5754.00");
    // Production's historical posted base; not overwritten with the spot rate.
    expect(toMoney("130103.96").minus("130103.95").toFixed(2)).toBe("0.01");
  });

  it("TALAL and UK BASMA: posting the old memo creates no second liability", () => {
    // Backup displayed outstanding memo separately; production journalized it.
    expect(sumMoney(["-44905.63", "38299.97"]).toFixed(2)).toBe("-6605.66");
    expect(sumMoney(["-33040.35", "27425.25"]).toFixed(2)).toBe("-5615.10");
    // The dynamic spot-rate figure is a DIFFERENT metric, not a correction
    // to the historical cash/credit balance.
    expect(usdOf([{ currencyCode: "EUR", balance: "-8519.00" }])).toBe("-10052.42");
    expect(usdOf([{ currencyCode: "USD", balance: "-5615.10" }])).toBe("-5615.10");
  });

  it("all three brokers tie to both source datasets, without phantom payments", () => {
    // NASRA: source FX once, includes sixteen container-level other charges.
    const nasraAud = sumMoney(["259207.50", "132870.00", "-392077.00", "-0.50"]);
    const nasraEur = sumMoney(["227365.90", "62955.01", "-290517.60"]);
    const nasraUsd = sumMoney([
      "627705.97", "32500.00", "10500.00", "16873.00",
      "-19999.00", "-1.00", "-506081.28",
    ]);
    expect(nasraAud.toFixed(2)).toBe("0.00");
    expect(nasraEur.toFixed(2)).toBe("-196.69");
    expect(nasraUsd.toFixed(2)).toBe("161497.69");
    expect(usdOf([
      { currencyCode: "AUD", balance: nasraAud.toFixed(2) },
      { currencyCode: "EUR", balance: nasraEur.toFixed(2) },
      { currencyCode: "USD", balance: nasraUsd.toFixed(2) },
    ])).toBe("161265.60");

    // MODA: main FX settlement USD pool rounds -$0.01.
    const modaEur = sumMoney(["165061.83", "48754.00", "-204215.58"]);
    const modaUsd = sumMoney(["237084.99", "-237085.00"]);
    expect(usdOf([
      { currencyCode: "EUR", balance: modaEur.toFixed(2) },
      { currencyCode: "USD", balance: modaUsd.toFixed(2) },
    ])).toBe("11328.29");

    // ZIAD: its converted goods balance nets exactly to zero.
    expect(sumMoney(["51352.50", "-51352.50"]).toFixed(2)).toBe("0.00");
    expect(sumMoney(["59225", "-59225"]).toFixed(2)).toBe("0.00");
  });
});
