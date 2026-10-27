import Decimal from "decimal.js";

// Keep report arithmetic out of binary floating-point space until the API boundary.
export const BatchRateDecimal = Decimal.clone({ precision: 80, rounding: Decimal.ROUND_HALF_UP });

type CumulativeBatchRateArgs = {
  cumulativeMixCost: Decimal.Value;
  cumulativeMixWeightKg: Decimal.Value;
};

/**
 * Historical weighted-average batch rate through a caller-supplied cutoff date.
 * The route is responsible for supplying cumulative totals from factory history
 * through that cutoff; with no cutoff this naturally becomes All Time.
 */
export function calculateCumulativeBatchRate({
  cumulativeMixCost,
  cumulativeMixWeightKg,
}: CumulativeBatchRateArgs) {
  const weight = new BatchRateDecimal(cumulativeMixWeightKg);
  if (!weight.gt(0)) return new BatchRateDecimal(0);
  return new BatchRateDecimal(cumulativeMixCost).dividedBy(weight).toDecimalPlaces(10);
}

type BalanceWeightArgs = {
  cumulativeMixWeightKg: Decimal.Value;
  cumulativeBaleWeightKg: Decimal.Value;
};

/**
 * Balance on Table is an as-of physical snapshot:
 * cumulative mixed weight minus cumulative produced-bale weight through the cutoff.
 */
export function resolveProductionBalanceWeight({
  cumulativeMixWeightKg,
  cumulativeBaleWeightKg,
}: BalanceWeightArgs) {
  return BatchRateDecimal.max(
    0,
    new BatchRateDecimal(cumulativeMixWeightKg).minus(new BatchRateDecimal(cumulativeBaleWeightKg))
  );
}

/**
 * Selected-period on-table movement, from two authoritative physical snapshots.
 *
 * Most factory "original" mix batches are deliberately COMPLETED/fully used when
 * created, so current batch.used_kg / status cannot reconstruct historical table
 * kilograms. Subtract the snapshot immediately before the selected range from
 * the as-of-end snapshot instead; this includes carries and non-bale output the
 * same way as the existing overall KPI. Report the magnitude AND the direction:
 * a net drawdown must never be misrepresented as additional material on hand.
 *
 * The monetary rate is the selected period's ORIGINAL batch weighted-average;
 * the production cost/profit uses its existing cumulative rate independently.
 */
type PeriodTableBalanceArgs = {
  weightAtEndKg: Decimal.Value;
  weightBeforePeriodKg: Decimal.Value;
  mixedPeriodWeightKg: Decimal.Value;
  mixedPeriodCost: Decimal.Value;
};

export function calculatePeriodTableBalance({
  weightAtEndKg,
  weightBeforePeriodKg,
  mixedPeriodWeightKg,
  mixedPeriodCost,
}: PeriodTableBalanceArgs) {
  const netChangeKg = new BatchRateDecimal(weightAtEndKg).minus(weightBeforePeriodKg);
  const weight = netChangeKg.abs();
  const periodRate = calculateCumulativeBatchRate({
    cumulativeMixWeightKg: mixedPeriodWeightKg,
    cumulativeMixCost: mixedPeriodCost,
  });
  return {
    weightKg: weight.toNumber(),
    netChangeKg: netChangeKg.toNumber(),
    direction: netChangeKg.gt(0) ? "increase" as const : netChangeKg.lt(0) ? "decrease" as const : "unchanged" as const,
    costPerKg: periodRate.toNumber(),
    value: weight.times(periodRate).toDecimalPlaces(2).toNumber(),
  };
}

type WeightCostArgs = {
  producedWeightKg: Decimal.Value;
  batchRateCost: Decimal.Value;
};

/**
 * Weight Cost = bales produced weight × the applicable historical batch rate.
 */
export function calculateProductionWeightCost({
  producedWeightKg,
  batchRateCost,
}: WeightCostArgs) {
  return new BatchRateDecimal(producedWeightKg).times(new BatchRateDecimal(batchRateCost));
}

type ProfitArgs = {
  productionValue: Decimal.Value;
  weightCost: Decimal.Value;
};

export function calculateProductionProfit({
  productionValue,
  weightCost,
}: ProfitArgs) {
  const productionValueDecimal = new BatchRateDecimal(productionValue);
  const weightCostDecimal = new BatchRateDecimal(weightCost);
  const profitValueDecimal = productionValueDecimal.minus(weightCostDecimal);
  const profitMarginPctDecimal = productionValueDecimal.gt(0)
    ? profitValueDecimal.dividedBy(productionValueDecimal).times(100)
    : new BatchRateDecimal(0);

  return {
    weightCost: weightCostDecimal.toDecimalPlaces(2).toNumber(),
    profitValue: profitValueDecimal.toDecimalPlaces(2).toNumber(),
    profitMarginPct: profitMarginPctDecimal.toNumber(),
  };
}
