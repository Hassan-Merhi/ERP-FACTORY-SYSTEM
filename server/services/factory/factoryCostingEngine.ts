import Decimal from "decimal.js";

export const FACTORY_COST_PRECISION = {
  quantity: 3,
  rate: 6,
  lockedRate: 8,
  total: 6,
} as const;

export type FactoryCostInput = Decimal.Value | null | undefined;

export class FactoryCostingError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "FactoryCostingError";
  }
}

function parseDecimal(
  value: FactoryCostInput,
  field: string,
  options: { allowNegative?: boolean; allowZero?: boolean } = {}
): Decimal {
  let parsed: Decimal;
  try {
    parsed = new Decimal(value ?? 0);
  } catch {
    throw new FactoryCostingError("FACTORY_COST_VALUE_INVALID", `${field} is invalid`);
  }

  if (!parsed.isFinite()) {
    throw new FactoryCostingError("FACTORY_COST_VALUE_INVALID", `${field} must be finite`);
  }
  if (!options.allowNegative && parsed.isNegative()) {
    throw new FactoryCostingError("FACTORY_COST_VALUE_NEGATIVE", `${field} cannot be negative`);
  }
  if (options.allowZero === false && parsed.isZero()) {
    throw new FactoryCostingError("FACTORY_COST_VALUE_ZERO", `${field} must be positive`);
  }
  return parsed;
}

export function factoryCostDecimal(
  value: FactoryCostInput,
  field = "value",
  options: { allowNegative?: boolean; allowZero?: boolean } = {}
): Decimal {
  return parseDecimal(value, field, options);
}

export function formatFactoryQuantity(value: FactoryCostInput): string {
  return parseDecimal(value, "quantity")
    .toDecimalPlaces(FACTORY_COST_PRECISION.quantity)
    .toFixed(FACTORY_COST_PRECISION.quantity);
}

export function formatFactoryRate(value: FactoryCostInput): string {
  return parseDecimal(value, "rate").toDecimalPlaces(FACTORY_COST_PRECISION.rate).toFixed(FACTORY_COST_PRECISION.rate);
}

export function formatFactoryLockedRate(value: FactoryCostInput): string {
  return parseDecimal(value, "lockedRate")
    .toDecimalPlaces(FACTORY_COST_PRECISION.lockedRate)
    .toFixed(FACTORY_COST_PRECISION.lockedRate);
}

export function formatFactoryTotal(value: FactoryCostInput): string {
  return parseDecimal(value, "total")
    .toDecimalPlaces(FACTORY_COST_PRECISION.total)
    .toFixed(FACTORY_COST_PRECISION.total);
}

export function factoryRatesEqual(a: FactoryCostInput, b: FactoryCostInput): boolean {
  return parseDecimal(a, "leftRate")
    .toDecimalPlaces(FACTORY_COST_PRECISION.rate)
    .equals(parseDecimal(b, "rightRate").toDecimalPlaces(FACTORY_COST_PRECISION.rate));
}

export interface CostLineResult {
  quantityKg: Decimal;
  unitCostPerKg: Decimal;
  totalCost: Decimal;
}

export function calculateCostLine(quantityKg: FactoryCostInput, unitCostPerKg: FactoryCostInput): CostLineResult {
  const quantity = parseDecimal(quantityKg, "quantityKg");
  const unitCost = parseDecimal(unitCostPerKg, "unitCostPerKg");
  return {
    quantityKg: quantity,
    unitCostPerKg: unitCost,
    totalCost: quantity.times(unitCost),
  };
}

export interface WeightedCostSource {
  quantityKg: FactoryCostInput;
  unitCostPerKg?: FactoryCostInput;
  totalCost?: FactoryCostInput;
}

export interface WeightedCostResult {
  totalQuantityKg: Decimal;
  totalCost: Decimal;
  weightedUnitCostPerKg: Decimal;
  sourceMismatchCount: number;
}

/**
 * Canonical mix-batch aggregation. Persisted source totalCost is authoritative
 * when present; unitCostPerKg is only the fallback for legacy source rows.
 */
export function calculateWeightedAverageCost(sources: readonly WeightedCostSource[]): WeightedCostResult {
  let totalQuantityKg = new Decimal(0);
  let totalCost = new Decimal(0);
  let sourceMismatchCount = 0;

  for (const [index, source] of sources.entries()) {
    const quantity = parseDecimal(source.quantityKg, `sources[${index}].quantityKg`);
    const hasPersistedTotal = source.totalCost !== null && source.totalCost !== undefined;
    const hasUnitCost = source.unitCostPerKg !== null && source.unitCostPerKg !== undefined;
    if (!hasPersistedTotal && !hasUnitCost) {
      throw new FactoryCostingError(
        "FACTORY_COST_SOURCE_RATE_MISSING",
        `sources[${index}] must provide totalCost or unitCostPerKg`
      );
    }

    const persistedTotal = hasPersistedTotal ? parseDecimal(source.totalCost, `sources[${index}].totalCost`) : null;
    const calculatedTotal = hasUnitCost
      ? quantity.times(parseDecimal(source.unitCostPerKg, `sources[${index}].unitCostPerKg`))
      : null;
    const sourceTotal = persistedTotal ?? calculatedTotal ?? new Decimal(0);

    if (
      persistedTotal &&
      calculatedTotal &&
      !persistedTotal
        .toDecimalPlaces(FACTORY_COST_PRECISION.total)
        .equals(calculatedTotal.toDecimalPlaces(FACTORY_COST_PRECISION.total))
    ) {
      sourceMismatchCount += 1;
    }

    totalQuantityKg = totalQuantityKg.plus(quantity);
    totalCost = totalCost.plus(sourceTotal);
  }

  return {
    totalQuantityKg,
    totalCost,
    weightedUnitCostPerKg: totalQuantityKg.gt(0) ? totalCost.div(totalQuantityKg) : new Decimal(0),
    sourceMismatchCount,
  };
}

export interface MovingAverageRateInput {
  existingQuantityKg: FactoryCostInput;
  existingRatePerKg: FactoryCostInput;
  incomingQuantityKg: FactoryCostInput;
  incomingRatePerKg: FactoryCostInput;
}

/**
 * Remaining-stock moving average used only for a real receipt/offload event.
 * Already-consumed quantity must never be passed as existingQuantityKg.
 */
export function calculateMovingAverageRate(input: MovingAverageRateInput): Decimal {
  const existingQuantity = parseDecimal(input.existingQuantityKg, "existingQuantityKg");
  const existingRate = parseDecimal(input.existingRatePerKg, "existingRatePerKg");
  const incomingQuantity = parseDecimal(input.incomingQuantityKg, "incomingQuantityKg", {
    allowZero: false,
  });
  const incomingRate = parseDecimal(input.incomingRatePerKg, "incomingRatePerKg");
  const combinedQuantity = existingQuantity.plus(incomingQuantity);

  return existingQuantity.times(existingRate).plus(incomingQuantity.times(incomingRate)).div(combinedQuantity);
}

export interface InventoryValueDeltaInput {
  inventoryQuantityKg: FactoryCostInput;
  currentRatePerKg: FactoryCostInput;
  valueDelta: FactoryCostInput;
  fallbackRatePerKg: FactoryCostInput;
}

/**
 * Applies a value-only correction across the supplier's authoritative remaining
 * inventory. A zero-inventory supplier adopts the explicit fallback rate.
 */
export function calculateRateAfterInventoryValueDelta(input: InventoryValueDeltaInput): Decimal {
  const inventoryQuantity = parseDecimal(input.inventoryQuantityKg, "inventoryQuantityKg");
  const currentRate = parseDecimal(input.currentRatePerKg, "currentRatePerKg");
  const valueDelta = parseDecimal(input.valueDelta, "valueDelta", { allowNegative: true });
  const fallbackRate = parseDecimal(input.fallbackRatePerKg, "fallbackRatePerKg");

  const nextRate = inventoryQuantity.gt(0) ? currentRate.plus(valueDelta.div(inventoryQuantity)) : fallbackRate;
  return Decimal.max(0, nextRate);
}

export interface RemainingInventoryCorrectionInput {
  supplierRemainingKg: FactoryCostInput;
  currentLockedRatePerKg: FactoryCostInput;
  correctedContainerRemainingKg: FactoryCostInput;
  oldCorrectedContainerRemainingValue: FactoryCostInput;
  newContainerRatePerKg: FactoryCostInput;
}

/**
 * Converts a landed-cost correction into the exact value delta that still
 * belongs to inventory, then spreads that delta across supplier remaining kg.
 */
export function calculateRemainingInventoryCorrection(input: RemainingInventoryCorrectionInput): {
  valueDelta: Decimal;
  newLockedRatePerKg: Decimal;
} {
  const correctedRemainingKg = parseDecimal(input.correctedContainerRemainingKg, "correctedContainerRemainingKg");
  const oldRemainingValue = parseDecimal(
    input.oldCorrectedContainerRemainingValue,
    "oldCorrectedContainerRemainingValue"
  );
  const newContainerRate = parseDecimal(input.newContainerRatePerKg, "newContainerRatePerKg");
  const newRemainingValue = correctedRemainingKg.times(newContainerRate);
  const valueDelta = newRemainingValue.minus(oldRemainingValue);

  return {
    valueDelta,
    newLockedRatePerKg: calculateRateAfterInventoryValueDelta({
      inventoryQuantityKg: input.supplierRemainingKg,
      currentRatePerKg: input.currentLockedRatePerKg,
      valueDelta,
      fallbackRatePerKg: newContainerRate,
    }),
  };
}

export interface ProportionalInventoryDeltaInput {
  oldFullValue: FactoryCostInput;
  newFullValue: FactoryCostInput;
  remainingKg: FactoryCostInput;
  valuationKg: FactoryCostInput;
}

/**
 * Value delta for the still-unconsumed fraction of a container. Used by late
 * freight/commission/charge corrections so consumed production is not put back
 * into the supplier's current moving average.
 */
export function calculateProportionalInventoryValueDelta(input: ProportionalInventoryDeltaInput): Decimal {
  const oldFullValue = parseDecimal(input.oldFullValue, "oldFullValue");
  const newFullValue = parseDecimal(input.newFullValue, "newFullValue");
  const remainingKg = parseDecimal(input.remainingKg, "remainingKg");
  const valuationKg = parseDecimal(input.valuationKg, "valuationKg");
  if (valuationKg.isZero() || remainingKg.isZero()) return new Decimal(0);
  const remainingFraction = Decimal.min(1, remainingKg.div(valuationKg));
  return newFullValue.minus(oldFullValue).times(remainingFraction);
}
