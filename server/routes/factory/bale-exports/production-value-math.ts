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
 * Value only the material that remains in each individual mix batch.
 *
 * Carry-forward batches are separate physical pools: the parent is CLOSED
 * with used_kg == total_kg and the child carries the leftover. Therefore
 * include both (unlike the "Original Batches" input KPI) without duplicating kg.
 *
 * The stored batch total is preferred over rounded rate × input kg. This keeps
 * cost allocation precise after landed-cost corrections and top-ups.
 */
export type BatchRemainingCostRow = {
  id: number;
  totalWeightKg: Decimal.Value;
  totalCost: Decimal.Value;
  usedKg: Decimal.Value;
};

export function calculateBatchRemainingValuation(rows: readonly BatchRemainingCostRow[]) {
  let remainingWeight = new BatchRateDecimal(0);
  let remainingValue = new BatchRateDecimal(0);
  let negativeOrOverusedBatches = 0;
  let invalidCostBatches = 0;
  const batches: Array<{
    id: number;
    remainingKg: number;
    batchRate: number;
    remainingValue: number;
  }> = [];

  for (const row of rows) {
    const kg = new BatchRateDecimal(row.totalWeightKg);
    const cost = new BatchRateDecimal(row.totalCost);
    const used = new BatchRateDecimal(row.usedKg);
    if (!kg.isFinite() || !kg.gt(0) || !used.isFinite() || used.lt(0) || used.gt(kg.plus("0.001"))) {
      negativeOrOverusedBatches++;
      continue;
    }
    const left = BatchRateDecimal.max(0, kg.minus(used));
    if (left.isZero()) continue;
    if (!cost.isFinite() || cost.lt(0)) {
      invalidCostBatches++;
      continue;
    }
    const rate = cost.dividedBy(kg);
    const value = left.times(rate);
    remainingWeight = remainingWeight.plus(left);
    remainingValue = remainingValue.plus(value);
    batches.push({
      id: row.id,
      remainingKg: left.toNumber(),
      batchRate: rate.toDecimalPlaces(10).toNumber(),
      remainingValue: value.toDecimalPlaces(2).toNumber(),
    });
  }

  const rate = remainingWeight.gt(0)
    ? remainingValue.dividedBy(remainingWeight).toDecimalPlaces(10)
    : new BatchRateDecimal(0);
  return {
    remainingWeight,
    remainingValue,
    weightedRate: rate,
    negativeOrOverusedBatches,
    invalidCostBatches,
    batches,
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
