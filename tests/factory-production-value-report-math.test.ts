import { describe, expect, it } from "vitest";

import {
  BatchRateDecimal,
  calculateCumulativeBatchRate,
  calculateProductionProfit,
  calculateProductionWeightCost,
  calculateProducedBaleMaterialCost,
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

  it("costs selected-month production from the bales' recorded material costs, not historical blended rate", () => {
    const result = calculateProducedBaleMaterialCost([
      {
        weightKg: "100",
        totalCost: "60.12",
        costPerKg: "0.6012",
        linkedBatchCostPerKg: "0.6012",
      },
      {
        weightKg: "200",
        totalCost: "149.98",
        costPerKg: "0.7499",
        linkedBatchCostPerKg: "0.7499",
      },
    ]);
    expect(result.weightCost.toDecimalPlaces(2).toNumber()).toBe(210.1);
    expect(result.storedCostBales).toBe(2);
    expect(result.unresolvedBales).toBe(0);
    // The wrong cumulative method would cost these same bales at 0.6446/kg.
    expect(result.weightCost.toNumber()).not.toBeCloseTo(300 * 0.6446, 2);
  });

  it("uses a legacy bale rate or linked batch rate only when recorded total cost is missing", () => {
    const result = calculateProducedBaleMaterialCost([
      { weightKg: "100", totalCost: "0", costPerKg: "0.67", linkedBatchCostPerKg: "0.65" },
      { weightKg: "50", totalCost: null, costPerKg: null, linkedBatchCostPerKg: "0.72" },
    ]);
    expect(result.weightCost.toNumber()).toBe(103);
    expect(result.baleRateFallbackBales).toBe(1);
    expect(result.batchRateFallbackBales).toBe(1);
    expect(result.unresolvedBales).toBe(0);
  });

  it("flags unpriced legacy production instead of guessing a period or cumulative average", () => {
    const result = calculateProducedBaleMaterialCost([
      { weightKg: "120", totalCost: "0", costPerKg: "0", linkedBatchCostPerKg: null },
      { weightKg: "40", totalCost: "0", costPerKg: "0", linkedBatchCostPerKg: "0" },
      { weightKg: "10", totalCost: "7", costPerKg: "0.7" },
    ]);
    expect(result.weightCost.toNumber()).toBe(7);
    expect(result.unresolvedBales).toBe(1);
    expect(result.unresolvedKg).toBe(120);
    expect(result.confirmedZeroCostBales).toBe(1);
  });

  it("keeps decimal precision until the API boundary", () => {
    const weightCost = calculateProductionWeightCost({
      producedWeightKg: new BatchRateDecimal("3"),
      batchRateCost: new BatchRateDecimal("0.3333333333"),
    });

    expect(weightCost.toString()).toBe("0.9999999999");
  });
});
