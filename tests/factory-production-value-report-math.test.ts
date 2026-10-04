import { describe, expect, it } from "vitest";

import {
  BatchRateDecimal,
  calculateCumulativeBatchRate,
  calculateProductionProfit,
  calculateProductionWeightCost,
  resolveProductionBalanceWeight,
} from "../server/routes/factory/bale-exports/production-value-math";

describe("Factory production value report math", () => {
  it("calculates a cumulative weighted-average batch rate through the selected cutoff", () => {
    const throughYesterday = calculateCumulativeBatchRate({
      cumulativeMixCost: "500",
      cumulativeMixWeightKg: "1000",
    });
    const throughToday = calculateCumulativeBatchRate({
      cumulativeMixCost: "650",
      cumulativeMixWeightKg: "1200",
    });

    expect(throughYesterday.toString()).toBe("0.5");
    expect(throughToday.toString()).toBe("0.5416666667");
    expect(throughToday.eq(throughYesterday)).toBe(false);
  });

  it("returns zero batch rate when no mix weight exists through the cutoff", () => {
    const rate = calculateCumulativeBatchRate({
      cumulativeMixCost: "0",
      cumulativeMixWeightKg: "0",
    });

    expect(rate.toNumber()).toBe(0);
  });

  it("calculates the physical balance from cumulative totals through the cutoff", () => {
    const weight = resolveProductionBalanceWeight({
      cumulativeMixWeightKg: "1798074",
      cumulativeBaleWeightKg: "1703147.8",
    });

    expect(weight.toNumber()).toBeCloseTo(94926.2, 6);
  });

  it("clamps a negative historical physical balance to zero", () => {
    const weight = resolveProductionBalanceWeight({
      cumulativeMixWeightKg: "100",
      cumulativeBaleWeightKg: "125",
    });

    expect(weight.toNumber()).toBe(0);
  });

  it("calculates Weight Cost as produced bale weight times the applicable historical batch rate", () => {
    const weightCost = calculateProductionWeightCost({
      producedWeightKg: "13033",
      batchRateCost: "0.7767506504",
    });

    expect(weightCost.toDecimalPlaces(2).toNumber()).toBe(10123.39);
  });

  it("calculates cost-mode profit as cost value minus Weight Cost", () => {
    const weightCost = calculateProductionWeightCost({
      producedWeightKg: "13033",
      batchRateCost: "0.7767506504",
    });

    const result = calculateProductionProfit({
      productionValue: "9683.00",
      weightCost,
    });

    expect(result.weightCost).toBe(10123.39);
    expect(result.profitValue).toBe(-440.39);
    expect(result.profitMarginPct).toBeCloseTo(-4.5481, 4);
  });

  it("calculates selling-mode profit as selling value minus Weight Cost", () => {
    const weightCost = calculateProductionWeightCost({
      producedWeightKg: "13033",
      batchRateCost: "0.7767506504",
    });

    const result = calculateProductionProfit({
      productionValue: "11408.50",
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
