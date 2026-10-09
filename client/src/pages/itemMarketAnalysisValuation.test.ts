import { describe, expect, it } from "vitest";
import { valueMarketRow } from "./itemMarketAnalysisValuation";
import type { MarketRow } from "./itemMarketAnalysisParts";

function makeRow(overrides: Partial<MarketRow> = {}): MarketRow {
  return {
    companyId: 1,
    companyCode: "HMD",
    companyName: "HADI L'SHI",
    stockItemId: 20,
    code: "HM0001",
    name: "Test bale",
    stockGroupId: null,
    stockGroupName: null,
    importCount: 3,
    importedQty: 19,
    purchaseValue: 2280,
    weightedPurchaseCost: 120,
    purchaseValueWithOffloading: 3252.8,
    weightedPurchaseCostWithOffloading: 171.2,
    purchaseCurrencies: ["USD"],
    soldQty: 14,
    revenue: 2710,
    historicalCost: 2393.53,
    profit: 316.47,
    avgSellingPrice: 2710 / 14,
    profitPerUnit: 316.47 / 14,
    marginPct: (316.47 / 2710) * 100,
    marketStatus: "watch",
    ...overrides,
  };
}

describe("Item Market Analysis purchase cost modes", () => {
  it("revalues all modeled profit fields using the selected cost, leaving posted history untouched", () => {
    const row = makeRow();
    const base = valueMarketRow(row, false);
    const landed = valueMarketRow(row, true);

    expect(base.profit).toBeCloseTo(1030, 2);
    expect(base.profitPerUnit).toBeCloseTo(1030 / 14, 6);
    expect(base.marginPct).toBeCloseTo((1030 / 2710) * 100, 6);
    expect(base.marketStatus).toBe("strong");

    expect(landed.profit).toBeCloseTo(313.2, 2);
    expect(landed.profitPerUnit).toBeCloseTo(313.2 / 14, 6);
    expect(landed.marginPct).toBeCloseTo((313.2 / 2710) * 100, 6);
    expect(landed.marketStatus).toBe("watch");

    // No mutation, rounding, or retroactive adjustment to posted sales.
    expect(row.profit).toBe(316.47);
    expect(base.historicalCost).toBe(2393.53);
    expect(landed.historicalCost).toBe(2393.53);
    expect(landed.revenue).toBe(2710);
  });

  it("includes net customer returns rather than using gross sales quantity", () => {
    const row = makeRow({ soldQty: 8, revenue: 160, weightedPurchaseCost: 10, weightedPurchaseCostWithOffloading: 12 });
    expect(valueMarketRow(row, false).profit).toBeCloseTo(80, 4);
    expect(valueMarketRow(row, true).profit).toBeCloseTo(64, 4);
  });

  it("revalues net-negative return periods using either selected purchase rate", () => {
    const row = makeRow({
      soldQty: -4,
      revenue: -160,
      weightedPurchaseCost: 10,
      weightedPurchaseCostWithOffloading: 12,
    });

    const base = valueMarketRow(row, false);
    const landed = valueMarketRow(row, true);
    expect(base.profit).toBeCloseTo(-120, 4);
    expect(landed.profit).toBeCloseTo(-112, 4);
    expect(base.profitPerUnit).toBeCloseTo(30, 4);
    expect(landed.profitPerUnit).toBeCloseTo(28, 4);
    expect(base.marketStatus).toBe("losing");
    expect(landed.marketStatus).toBe("losing");
    expect(row.profit).toBe(316.47);
  });

  it("changes losing and gaining classifications when offloading crosses break-even", () => {
    const row = makeRow({
      soldQty: 10,
      revenue: 140,
      weightedPurchaseCost: 10,
      weightedPurchaseCostWithOffloading: 15,
    });
    expect(valueMarketRow(row, false).marketStatus).toBe("strong");
    expect(valueMarketRow(row, false).profit).toBe(40);
    expect(valueMarketRow(row, true).marketStatus).toBe("losing");
    expect(valueMarketRow(row, true).profit).toBe(-10);
  });

  it("does not fabricate estimated profit for non-USD, mixed-currency or missing purchase rates", () => {
    const row = makeRow();
    expect(valueMarketRow({ ...row, purchaseCurrencies: ["CDF"] }, true)).toEqual({
      ...row,
      purchaseCurrencies: ["CDF"],
    });
    expect(valueMarketRow({ ...row, purchaseCurrencies: ["USD", "CDF"] }, false).profit).toBe(316.47);
    expect(valueMarketRow({ ...row, weightedPurchaseCostWithOffloading: null }, true).profit).toBe(316.47);
    expect(valueMarketRow({ ...row, importedQty: 0 }, true).profit).toBe(316.47);
  });

  it("keeps no-sale item profits and statuses from recorded activity", () => {
    const row = makeRow({ soldQty: 0, revenue: 0, profit: 0, marketStatus: "no_sales" });
    expect(valueMarketRow(row, false)).toBe(row);
    expect(valueMarketRow(row, true)).toBe(row);
  });

  it("permits identical values only when the reported offloading increment is zero", () => {
    const row = makeRow({ weightedPurchaseCostWithOffloading: 120 });
    expect(valueMarketRow(row, true).profit).toBeCloseTo(valueMarketRow(row, false).profit, 6);
  });
});
