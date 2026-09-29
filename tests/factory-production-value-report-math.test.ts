import { describe, expect, it } from "vitest";

import {
  BatchRateDecimal,
  calculateProductionProfit,
  calculateProductionWeightCost,
  resolveProductionBalanceWeight,
} from "../server/routes/factory/bale-exports/production-value-math";

describe("Factory production value report math", () => {
  it("keeps the global physical balance even when a date filter is active", () => {
    const weight = resolveProductionBalanceWeight({
      allTimeMixWeightKg: "1798074",
      allTimeBaleWeightKg: "1703147.8",
    });

    expect(weight.toNumber()).toBeCloseTo(94926.2, 6);
  });

  it("clamps a negative global physical balance to zero", () => {
    const weight = resolveProductionBalanceWeight({
      allTimeMixWeightKg: "100",
      allTimeBaleWeightKg: "125",
    });

    expect(weight.toNumber()).toBe(0);
  });

  it("calculates Weight Cost as produced bale weight times the frozen batch rate", () => {
    const weightCost = calculateProductionWeightCost({
      producedWeightKg: "13033",
      batchRateCost: "0.7767506504",
    });

    expect(weightCost.toDecimalPlaces(2).toNumber()).toBe(10123.39);
  });

  it("calculates profit from selling value minus Weight Cost", () => {
    const weightCost = calculateProductionWeightCost({
      producedWeightKg: "13033",
      batchRateCost: "0.7767506504",
    });

    const result = calculateProductionProfit({
      sellingValue: "11408.50",
      weightCost,
    });

    expect(result.weightCost).toBe(10123.39);
    expect(result.profitValue).toBe(1285.11);
    expect(result.profitMarginPct).toBeCloseTo(11.2645, 4);
  });

  it("keeps decimal precision until the API boundary", () => {
    const weightCost = calculateProductionWeightCost({
      producedWeightKg: new BatchRateDecimal("3"),
      batchRateCost: new BatchRateDecimal("0.3333333333"),
    });

    expect(weightCost.toString()).toBe("0.9999999999");
  });
});
