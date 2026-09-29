import { describe, expect, it } from "vitest";

import {
  BatchRateDecimal,
  calculateProductionProfit,
  resolveProductionBalanceWeight,
} from "../server/routes/factory/bale-exports/production-value-math";

describe("Factory production value report math", () => {
  it("uses period on-table weight for a filtered report instead of the global balance", () => {
    const weight = resolveProductionBalanceWeight({
      isAllTime: false,
      allTimeMixWeightKg: "1798074",
      allTimeBaleWeightKg: "1703147.8",
      periodOnTableKg: "1573",
    });

    expect(weight.toNumber()).toBe(1573);
  });

  it("keeps the global physical balance for All Time", () => {
    const weight = resolveProductionBalanceWeight({
      isAllTime: true,
      allTimeMixWeightKg: "1798074",
      allTimeBaleWeightKg: "1703147.8",
      periodOnTableKg: "1573",
    });

    expect(weight.toNumber()).toBeCloseTo(94926.2, 6);
  });

  it("does not turn a daily 11k batch into a 73k profit", () => {
    const batchCost = new BatchRateDecimal("11353.11");
    const batchWeight = new BatchRateDecimal("14606");
    const remainingWeight = new BatchRateDecimal("1573");
    const rate = batchCost.dividedBy(batchWeight);
    const remainingValue = remainingWeight.times(rate);

    const result = calculateProductionProfit({
      sellingValue: "11408.50",
      batchCost,
      remainingMaterialValue: remainingValue,
    });

    expect(result.remainingMaterialValue).toBeCloseTo(1222.68, 2);
    expect(result.consumedMaterialCost).toBeCloseTo(10130.43, 2);
    expect(result.profitValue).toBeCloseTo(1278.07, 2);
    expect(result.profitMarginPct).toBeCloseTo(11.2028, 4);
  });
});
