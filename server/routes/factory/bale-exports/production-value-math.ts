import Decimal from "decimal.js";

// Keep report arithmetic out of binary floating-point space until the API boundary.
export const BatchRateDecimal = Decimal.clone({ precision: 80, rounding: Decimal.ROUND_HALF_UP });

type BalanceWeightArgs = {
  isAllTime: boolean;
  allTimeMixWeightKg: Decimal.Value;
  allTimeBaleWeightKg: Decimal.Value;
  periodOnTableKg: Decimal.Value;
};

export function resolveProductionBalanceWeight({
  isAllTime,
  allTimeMixWeightKg,
  allTimeBaleWeightKg,
  periodOnTableKg,
}: BalanceWeightArgs) {
  if (isAllTime) {
    return BatchRateDecimal.max(
      0,
      new BatchRateDecimal(allTimeMixWeightKg).minus(new BatchRateDecimal(allTimeBaleWeightKg))
    );
  }

  return BatchRateDecimal.max(0, new BatchRateDecimal(periodOnTableKg));
}

type ProfitArgs = {
  sellingValue: Decimal.Value;
  batchCost: Decimal.Value;
  remainingMaterialValue: Decimal.Value;
};

export function calculateProductionProfit({
  sellingValue,
  batchCost,
  remainingMaterialValue,
}: ProfitArgs) {
  const sellingValueDecimal = new BatchRateDecimal(sellingValue);
  const batchCostDecimal = new BatchRateDecimal(batchCost);
  const remainingMaterialValueDecimal = BatchRateDecimal.max(
    0,
    BatchRateDecimal.min(batchCostDecimal, new BatchRateDecimal(remainingMaterialValue))
  );

  const consumedMaterialCostDecimal = BatchRateDecimal.max(
    0,
    batchCostDecimal.minus(remainingMaterialValueDecimal)
  );
  const profitValueDecimal = sellingValueDecimal.minus(consumedMaterialCostDecimal);
  const profitMarginPctDecimal = sellingValueDecimal.gt(0)
    ? profitValueDecimal.dividedBy(sellingValueDecimal).times(100)
    : new BatchRateDecimal(0);

  return {
    remainingMaterialValue: remainingMaterialValueDecimal.toDecimalPlaces(2).toNumber(),
    consumedMaterialCost: consumedMaterialCostDecimal.toDecimalPlaces(2).toNumber(),
    profitValue: profitValueDecimal.toDecimalPlaces(2).toNumber(),
    profitMarginPct: profitMarginPctDecimal.toNumber(),
  };
}
