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

/**
 * Actual material cost of regular bales produced during a reporting period.
 *
 * A bale's persisted total cost is authoritative: it follows the historical
 * batch that produced the bale, including approved downstream cost cascades.
 * Legacy records without a usable total can fall back to their persisted bale
 * rate, and finally their linked batch rate. Never substitute the rate averaged
 * across OTHER batches or the all-time Balance on Table rate.
 *
 * A zero cost without a confirmed zero-cost source is unresolved, NOT free.
 * Callers must expose unresolved quantities before relying on profit.
 */
export type ProducedBaleMaterialCostRow = {
  weightKg: Decimal.Value;
  totalCost?: Decimal.Value | null;
  costPerKg?: Decimal.Value | null;
  linkedBatchCostPerKg?: Decimal.Value | null;
};

export function calculateProducedBaleMaterialCost(rows: readonly ProducedBaleMaterialCostRow[]) {
  const validMoney = (value: Decimal.Value | null | undefined) => {
    if (value == null || value === "") return null;
    const amount = new BatchRateDecimal(value);
    return amount.isFinite() && amount.gte(0) ? amount : null;
  };

  let weightCost = new BatchRateDecimal(0);
  let unresolvedKg = new BatchRateDecimal(0);
  let storedCostBales = 0;
  let baleRateFallbackBales = 0;
  let batchRateFallbackBales = 0;
  let confirmedZeroCostBales = 0;
  let unresolvedBales = 0;

  for (const bale of rows) {
    const weight = validMoney(bale.weightKg);
    if (!weight || !weight.gt(0)) continue;

    const total = validMoney(bale.totalCost);
    const baleRate = validMoney(bale.costPerKg);
    const batchRate = validMoney(bale.linkedBatchCostPerKg);

    if (total?.gt(0)) {
      weightCost = weightCost.plus(total);
      storedCostBales++;
    } else if (baleRate?.gt(0)) {
      weightCost = weightCost.plus(weight.times(baleRate));
      baleRateFallbackBales++;
    } else if (batchRate?.gt(0)) {
      weightCost = weightCost.plus(weight.times(batchRate));
      batchRateFallbackBales++;
    } else if (total?.eq(0) && batchRate?.eq(0)) {
      // A linked batch with an explicitly zero rate confirms a free source.
      confirmedZeroCostBales++;
    } else {
      // Do not silently count an unpriced/legacy bale as profit.
      unresolvedBales++;
      unresolvedKg = unresolvedKg.plus(weight);
    }
  }

  return {
    weightCost,
    storedCostBales,
    baleRateFallbackBales,
    batchRateFallbackBales,
    confirmedZeroCostBales,
    unresolvedBales,
    unresolvedKg: unresolvedKg.toNumber(),
  };
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
