import Decimal from "decimal.js";

// Keep report arithmetic out of binary floating-point space until the API boundary.
export const BatchRateDecimal = Decimal.clone({ precision: 80, rounding: Decimal.ROUND_HALF_UP });

type BalanceWeightArgs = {
  allTimeMixWeightKg: Decimal.Value;
  allTimeBaleWeightKg: Decimal.Value;
};

/**
 * Balance on Table is a factory-wide physical snapshot, not a period metric.
 * Date filters must never change it.
 */
export function resolveProductionBalanceWeight({
  allTimeMixWeightKg,
  allTimeBaleWeightKg,
}: BalanceWeightArgs) {
  return BatchRateDecimal.max(
    0,
    new BatchRateDecimal(allTimeMixWeightKg).minus(new BatchRateDecimal(allTimeBaleWeightKg))
  );
}

type WeightCostArgs = {
  producedWeightKg: Decimal.Value;
  batchRateCost: Decimal.Value;
};

/**
 * Weight Cost = bales produced weight × the frozen all-time batch rate.
 */
export function calculateProductionWeightCost({
  producedWeightKg,
  batchRateCost,
}: WeightCostArgs) {
  return new BatchRateDecimal(producedWeightKg).times(new BatchRateDecimal(batchRateCost));
}

type ProfitArgs = {
  sellingValue: Decimal.Value;
  weightCost: Decimal.Value;
};

export function calculateProductionProfit({
  sellingValue,
  weightCost,
}: ProfitArgs) {
  const sellingValueDecimal = new BatchRateDecimal(sellingValue);
  const weightCostDecimal = new BatchRateDecimal(weightCost);
  const profitValueDecimal = sellingValueDecimal.minus(weightCostDecimal);
  const profitMarginPctDecimal = sellingValueDecimal.gt(0)
    ? profitValueDecimal.dividedBy(sellingValueDecimal).times(100)
    : new BatchRateDecimal(0);

  return {
    weightCost: weightCostDecimal.toDecimalPlaces(2).toNumber(),
    profitValue: profitValueDecimal.toDecimalPlaces(2).toNumber(),
    profitMarginPct: profitMarginPctDecimal.toNumber(),
  };
}
