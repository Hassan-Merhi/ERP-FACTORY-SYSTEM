import Decimal from "decimal.js";

export const HISTORICAL_SALES_COST_REPAIR_ALGORITHM_VERSION = "2026-10-01-v54-opening-era-observed-only";

export const ZERO = new Decimal(0);

export function hscrEngineError(code: string): Error {
  const error = new Error();
  error.message = code;
  return error;
}

export function decimal(value: Decimal.Value | null | undefined, field: string): Decimal {
  try {
    const parsed = new Decimal(value ?? 0);
    if (!parsed.isFinite()) throw new Error("not finite");
    return parsed;
  } catch {
    throw hscrEngineError(`HSCR_NON_FINITE_DECIMAL:${field}`);
  }
}

export function repairQuantity(value: Decimal.Value): Decimal {
  return new Decimal(decimal(value, "quantity").toFixed(3));
}

export function repairMoney(value: Decimal.Value): Decimal {
  return new Decimal(decimal(value, "money").toFixed(2));
}

export function repairRate(value: Decimal.Value): Decimal {
  return new Decimal(decimal(value, "rate").toFixed(2));
}

export type HistoricalInventoryState = {
  quantity: Decimal;
  averageRate: Decimal;
  totalValue: Decimal;
};

export type HistoricalForwardReplayState = {
  inventory: HistoricalInventoryState;
  negativeLayerQuantity: Decimal;
};

export type HistoricalSalesRepairMovement = {
  movementId: string;
  companyId: number;
  locationId: number;
  stockItemId: number;
  occurredAt: string;
  createdAt?: string;
  reversalOfMovementId?: number | null;
  sequence: number;
  quantityDelta: string;
  unitCost: string | null;
  exactValue?: string | null;
  valuationReset?: {
    beforeQuantity: string;
    beforeAverageRate: string;
    beforeTotalValue: string;
    afterQuantity: string;
    afterAverageRate: string;
    afterTotalValue: string;
  };
  sourceType: string;
  sourceId: string;
  evidence: "canonical" | "legacy";
  /**
   * Role of a canonical pos-sale row, derived from its immutable idempotency
   * key. Only "sale-issue" rows (lockAndDeductInventoryForSaleItem) journal the
   * locked live inventory average. Edit re-issues journal the preserved old
   * sale-line cost, and edit/delete reversals journal the old line cost while
   * production restored stock at the live stored rate.
   */
  canonicalPosRole?: CanonicalPosRole;
  idempotencyKey?: string | null;
  sale?: {
    salesItemId: number;
    voucherId: number;
    quantity: string;
    totalSales: string;
    originalCostPrice: string;
    originalTotalCost: string;
    originalProfit: string;
  };
};

const EXACT_VALUATION_RESET_SOURCE_TYPES = new Set(["inventory-valuation-wave6-reset", "inventory-valuation-override"]);

/** A recorded exact before/after valuation reset (Wave 6, or a stage-031 override). */
export function isExactValuationReset(
  movement: HistoricalSalesRepairMovement
): movement is HistoricalSalesRepairMovement & {
  valuationReset: NonNullable<HistoricalSalesRepairMovement["valuationReset"]>;
} {
  return EXACT_VALUATION_RESET_SOURCE_TYPES.has(movement.sourceType) && Boolean(movement.valuationReset);
}

/**
 * "dropped-line": a POS sale line that production issued at the live stored
 * rate but whose journal row was lost. From 2026-08-13 to 2026-09-26 the
 * original issue key was per stock item (pos-sale:V:rev0:ITEM), so a second
 * line of the same item collided and only the first line was journaled.
 * These rows are reconstructed by the dry-run, never loaded.
 */
export type CanonicalPosRole = "sale-issue" | "edit-issue" | "edit-reversal" | "dropped-line";

export function canonicalPosRoleFromIdempotencyKey(
  sourceType: string,
  idempotencyKey: string | null | undefined
): CanonicalPosRole | undefined {
  if (sourceType !== "pos-sale") return undefined;
  const key = idempotencyKey ?? "";
  // From 2026-09-26 the original issue carries an issue:...:line: suffix too.
  if (/^pos-sale:\d+:rev0:issue:/.test(key)) return "sale-issue";
  if (/^pos-sale:\d+:rev\d+:reverse:/.test(key)) return "edit-reversal";
  if (/^pos-sale:\d+:rev\d+:issue:/.test(key)) return "edit-issue";
  return "sale-issue";
}

/** A canonical POS row whose journal unit_cost is not the inventory rate production used. */
export function posJournalCostIsNotInventoryRate(movement: HistoricalSalesRepairMovement): boolean {
  return (
    movement.sourceType === "pos-sale" &&
    (movement.canonicalPosRole === "edit-issue" ||
      movement.canonicalPosRole === "edit-reversal" ||
      movement.canonicalPosRole === "dropped-line")
  );
}

/**
 * Production stores average_rate as the 2dp rounding of total_value/quantity.
 * Decimal writers round half-up; a few historical float writers rounded exact
 * half-cent ties down (16 such rows exist in the immutable Phase 3 checkpoint).
 * A reconstructed positive state outside both roundings never existed.
 */
export function historicalStateRateMatchesValue(state: HistoricalInventoryState): boolean {
  const quantity = repairQuantity(state.quantity);
  if (!quantity.gt(ZERO)) return true;
  const rate = repairRate(state.averageRate);
  const value = repairMoney(state.totalValue);
  if (repairRate(value.dividedBy(quantity)).eq(rate)) return true;
  const floatRate = new Decimal((value.toNumber() / quantity.toNumber()).toFixed(2));
  return floatRate.eq(rate);
}

const EVIDENCED_RATE_RANGE_TOLERANCE = new Decimal("0.01");

/**
 * A moving weighted average is a convex combination of the rates that fed it.
 * A reconstructed cost outside every evidenced rate (beyond 2dp rounding) is
 * impossible and proves the reconstruction chain wrong.
 */
export function historicalRateWithinEvidencedRange(
  rate: Decimal.Value,
  range: { low: Decimal.Value; high: Decimal.Value } | undefined
): boolean {
  if (!range) return false;
  const value = repairRate(rate);
  return (
    value.gte(decimal(range.low, "range low").minus(EVIDENCED_RATE_RANGE_TOLERANCE)) &&
    value.lte(decimal(range.high, "range high").plus(EVIDENCED_RATE_RANGE_TOLERANCE))
  );
}

export type HistoricalSalesRepairOpening = {
  companyId: number;
  locationId: number;
  stockItemId: number;
  quantity: string;
  averageRate: string;
};

export type HistoricalSalesRepairProposal = {
  salesItemId: number;
  voucherId: number;
  companyId: number;
  locationId: number;
  stockItemId: number;
  occurredAt: string;
  sourceType: string;
  sourceId: string;
  evidence: "canonical" | "legacy";
  originalCostPrice: string;
  originalTotalCost: string;
  originalProfit: string;
  proposedCostPrice: string;
  proposedTotalCost: string;
  proposedProfit: string;
  changed: boolean;
};

export type HistoricalSalesRepairReplayResult = {
  proposals: HistoricalSalesRepairProposal[];
  closingStates: Map<string, HistoricalInventoryState>;
};

export function historicalInventoryKey(companyId: number, locationId: number, stockItemId: number): string {
  return `${companyId}:${locationId}:${stockItemId}`;
}

export function createHistoricalInventoryState(
  quantityValue: Decimal.Value,
  rateValue: Decimal.Value
): HistoricalInventoryState {
  const quantity = repairQuantity(quantityValue);
  const averageRate = repairRate(Decimal.max(decimal(rateValue, "opening rate"), ZERO));
  const totalValue = quantity.gt(ZERO) ? repairMoney(quantity.times(averageRate)) : ZERO;
  return { quantity, averageRate, totalValue };
}

export function createHistoricalInventoryStateFromSnapshot(
  quantityValue: Decimal.Value,
  rateValue: Decimal.Value,
  totalValueInput: Decimal.Value
): HistoricalInventoryState {
  const quantity = repairQuantity(quantityValue);
  const averageRate = repairRate(Decimal.max(decimal(rateValue, "snapshot rate"), ZERO));
  const totalValue = quantity.gt(ZERO)
    ? repairMoney(Decimal.max(decimal(totalValueInput, "snapshot total value"), ZERO))
    : ZERO;
  return { quantity, averageRate, totalValue };
}

const OFFLOAD_POSITIVE_VALUE_CLAMP_AT = Date.parse("2026-03-13T06:57:11.066958Z");
const OFFLOAD_NEGATIVE_CROSSING_RESET_AT = Date.parse("2026-03-14T07:19:07.816994Z");

export const INITIAL_OFFLOAD_SOURCE_TYPES = new Set(["container-offload", "legacy-container-offload"]);
export const EXACT_OFFLOAD_REMOVAL_SOURCE_TYPES = new Set([
  "offload_optional_suspend",
  "container-reverse-offload",
  "container-reverse-offload-legacy",
]);

export function rawHistoricalInventoryState(
  quantityValue: Decimal.Value,
  rateValue: Decimal.Value,
  totalValueInput: Decimal.Value
): HistoricalInventoryState {
  return {
    quantity: repairQuantity(quantityValue),
    averageRate: repairRate(Decimal.max(decimal(rateValue, "raw state rate"), ZERO)),
    totalValue: repairMoney(decimal(totalValueInput, "raw state total value")),
  };
}

export function valuationResetState(
  reset: NonNullable<HistoricalSalesRepairMovement["valuationReset"]>,
  side: "before" | "after"
): HistoricalInventoryState {
  return rawHistoricalInventoryState(
    side === "before" ? reset.beforeQuantity : reset.afterQuantity,
    side === "before" ? reset.beforeAverageRate : reset.afterAverageRate,
    side === "before" ? reset.beforeTotalValue : reset.afterTotalValue
  );
}

export function valuationResetStateMatches(
  state: HistoricalInventoryState,
  expected: HistoricalInventoryState
): boolean {
  return (
    repairQuantity(state.quantity).eq(repairQuantity(expected.quantity)) &&
    repairRate(state.averageRate).eq(repairRate(expected.averageRate)) &&
    repairMoney(state.totalValue).eq(repairMoney(expected.totalValue))
  );
}

function movementTimeMs(movement: HistoricalSalesRepairMovement): number {
  const parsed = Date.parse(movement.createdAt ?? movement.occurredAt);
  if (!Number.isFinite(parsed)) throw hscrEngineError("HSCR_MOVEMENT_TIMESTAMP_INVALID");
  return parsed;
}

function exactOffloadRate(movement: HistoricalSalesRepairMovement, delta: Decimal): Decimal {
  if (movement.exactValue !== null && movement.exactValue !== undefined && !delta.isZero()) {
    return Decimal.max(decimal(movement.exactValue, "offload exact value").dividedBy(delta.abs()), ZERO);
  }
  return Decimal.max(decimal(movement.unitCost ?? 0, "offload unit cost"), ZERO);
}

function applyInitialOffloadMovement(
  state: HistoricalInventoryState,
  movement: HistoricalSalesRepairMovement
): HistoricalInventoryState {
  const delta = repairQuantity(movement.quantityDelta);
  if (!delta.gt(ZERO) || movement.exactValue === null || movement.exactValue === undefined) {
    return applyHistoricalInventoryMovement(state, {
      quantityDelta: movement.quantityDelta,
      unitCost: movement.unitCost,
    });
  }

  const previousQty = repairQuantity(state.quantity);
  const previousValue = repairMoney(state.totalValue);
  const exactValue = repairMoney(movement.exactValue);
  const incomingRate = exactOffloadRate(movement, delta);
  const newQty = repairQuantity(previousQty.plus(delta));
  const mutationAt = movementTimeMs(movement);

  if (newQty.isZero()) {
    return rawHistoricalInventoryState(newQty, incomingRate, ZERO);
  }

  if (newQty.lt(ZERO)) {
    return rawHistoricalInventoryState(newQty, incomingRate, repairMoney(newQty.times(incomingRate)));
  }

  let newValue: Decimal;
  if (previousQty.lt(ZERO) && mutationAt >= OFFLOAD_NEGATIVE_CROSSING_RESET_AT) {
    newValue = repairMoney(newQty.times(incomingRate));
  } else {
    newValue = repairMoney(previousValue.plus(exactValue));
    if (mutationAt >= OFFLOAD_POSITIVE_VALUE_CLAMP_AT && newValue.lt(ZERO)) {
      newValue = repairMoney(newQty.times(incomingRate));
    }
  }

  return rawHistoricalInventoryState(newQty, newValue.dividedBy(newQty), newValue);
}

function applyExactOffloadRemoval(
  state: HistoricalInventoryState,
  movement: HistoricalSalesRepairMovement
): HistoricalInventoryState {
  const delta = repairQuantity(movement.quantityDelta);
  if (!delta.lt(ZERO) || movement.exactValue === null || movement.exactValue === undefined) {
    return applyHistoricalInventoryMovement(state, {
      quantityDelta: movement.quantityDelta,
      unitCost: movement.unitCost,
    });
  }

  const previousQty = repairQuantity(state.quantity);
  const previousRate = repairRate(Decimal.max(state.averageRate, ZERO));
  const previousValue = repairMoney(state.totalValue);
  const removalQty = delta.abs();
  const exactValue = repairMoney(movement.exactValue);
  const newQty = repairQuantity(previousQty.minus(removalQty));
  let newValue = repairMoney(previousValue.minus(exactValue));

  if (newQty.gt(ZERO)) {
    newValue = repairMoney(Decimal.max(newValue, ZERO));
    return rawHistoricalInventoryState(newQty, newValue.dividedBy(newQty), newValue);
  }

  return rawHistoricalInventoryState(newQty, previousRate, ZERO);
}

export function applyHistoricalSalesRepairMovement(
  state: HistoricalInventoryState,
  movement: HistoricalSalesRepairMovement
): HistoricalInventoryState {
  if (isExactValuationReset(movement)) {
    const before = valuationResetState(movement.valuationReset, "before");
    return valuationResetStateMatches(state, before)
      ? valuationResetState(movement.valuationReset, "after")
      : rawHistoricalInventoryState(state.quantity, state.averageRate, state.totalValue);
  }
  if (INITIAL_OFFLOAD_SOURCE_TYPES.has(movement.sourceType)) {
    return applyInitialOffloadMovement(state, movement);
  }
  if (EXACT_OFFLOAD_REMOVAL_SOURCE_TYPES.has(movement.sourceType)) {
    return applyExactOffloadRemoval(state, movement);
  }
  return applyHistoricalInventoryMovement(state, {
    quantityDelta: movement.quantityDelta,
    // Identified POS edit/delete reversals restored stock at the live stored
    // rate in every era; their journal cost is the old sale-line cost.
    unitCost:
      movement.canonicalPosRole === "edit-reversal" && posJournalCostIsNotInventoryRate(movement)
        ? null
        : movement.unitCost,
  });
}

const INVENTORY_SAFETY_CLAMP_AT = Date.parse("2026-03-13T06:57:11.066958Z");
const NEGATIVE_LAYER_ENGINE_AT = Date.parse("2026-03-14T08:23:03.665494Z");
const INCREMENTAL_SHORTAGE_FIX_AT = Date.parse("2026-07-12T18:27:04.885046Z");
const STALE_LAYER_SETTLEMENT_FIX_AT = Date.parse("2026-09-11T19:58:31.453168Z");

function rawUnclampedHistoricalInventoryState(
  quantityValue: Decimal.Value,
  rateValue: Decimal.Value,
  totalValueInput: Decimal.Value
): HistoricalInventoryState {
  return {
    quantity: repairQuantity(quantityValue),
    averageRate: repairRate(decimal(rateValue, "legacy raw state rate")),
    totalValue: repairMoney(decimal(totalValueInput, "legacy raw state total value")),
  };
}

/**
 * Historical location imports wrote the uploaded quantity/rate/value directly,
 * including signed quantity/value before the later inventory safety clamps.
 * V15 uses the endpoint's default value shape (quantity × pinned rate) only as
 * a checkpoint-gated candidate; it is never accepted without an exact replay.
 */
export function createHistoricalSignedLocationImportState(
  quantityValue: Decimal.Value,
  rateValue: Decimal.Value
): HistoricalInventoryState {
  const quantity = repairQuantity(quantityValue);
  const averageRate = repairRate(Decimal.max(decimal(rateValue, "signed import rate"), ZERO));
  const totalValue = repairMoney(quantity.times(averageRate));
  return rawUnclampedHistoricalInventoryState(quantity, averageRate, totalValue);
}

export function movementSuppliesIncomingRate(movement: HistoricalSalesRepairMovement): boolean {
  const delta = repairQuantity(movement.quantityDelta);
  if (!delta.gt(ZERO)) return false;
  // POS reversal/edit receipts historically restored quantity without passing
  // the old line cost into the adjustInventory helper. The canonical journal still
  // recorded that old cost, so treating unit_cost as an incoming receipt rate
  // would replay a valuation path production never used.
  if (movement.sourceType === "pos-sale") return false;
  return movement.unitCost !== null && movement.unitCost !== undefined;
}

function historicalIncomingRate(movement: HistoricalSalesRepairMovement, previousRate: Decimal): Decimal {
  if (!movementSuppliesIncomingRate(movement)) return previousRate;
  return Decimal.max(decimal(movement.unitCost, "historical incoming rate"), ZERO);
}

function incrementalShortageQuantity(previousQty: Decimal, newQty: Decimal): Decimal {
  const previousShortage = previousQty.lt(ZERO) ? previousQty.abs() : ZERO;
  const newShortage = newQty.lt(ZERO) ? newQty.abs() : ZERO;
  return repairQuantity(Decimal.max(newShortage.minus(previousShortage), ZERO));
}

function addNegativeLayerQuantity(
  layerQty: Decimal,
  previousQty: Decimal,
  newQty: Decimal,
  mutationAt: number
): Decimal {
  if (!newQty.lt(ZERO)) return repairQuantity(layerQty);
  const created =
    mutationAt < INCREMENTAL_SHORTAGE_FIX_AT ? newQty.abs() : incrementalShortageQuantity(previousQty, newQty);
  return repairQuantity(layerQty.plus(created));
}

function applyPreSafetyInventoryMovement(
  state: HistoricalInventoryState,
  movement: HistoricalSalesRepairMovement
): HistoricalInventoryState {
  const delta = repairQuantity(movement.quantityDelta);
  const previousQty = repairQuantity(state.quantity);
  const previousRate = repairRate(state.averageRate);
  const previousValue = repairMoney(state.totalValue);
  const newQty = repairQuantity(previousQty.plus(delta));

  if (delta.gt(ZERO) && movementSuppliesIncomingRate(movement)) {
    const incomingRate = historicalIncomingRate(movement, previousRate);
    const newValue = repairMoney(previousValue.plus(delta.times(incomingRate)));
    const newRate = newQty.gt(ZERO) ? repairRate(newValue.dividedBy(newQty)) : repairRate(incomingRate);
    return rawUnclampedHistoricalInventoryState(newQty, newRate, newValue);
  }

  if (delta.lt(ZERO)) {
    const newValue = repairMoney(previousValue.minus(delta.abs().times(previousRate)));
    const newRate = newQty.gt(ZERO) ? repairRate(newValue.dividedBy(newQty)) : previousRate;
    return rawUnclampedHistoricalInventoryState(newQty, newRate, newValue);
  }

  return rawUnclampedHistoricalInventoryState(newQty, previousRate, previousValue);
}

function applySafetyClampInventoryMovement(
  state: HistoricalInventoryState,
  movement: HistoricalSalesRepairMovement
): HistoricalInventoryState {
  const delta = repairQuantity(movement.quantityDelta);
  const previousQty = repairQuantity(state.quantity);
  const previousRate = repairRate(state.averageRate);
  const previousValue = repairMoney(state.totalValue);
  const newQty = repairQuantity(previousQty.plus(delta));

  let newValue = previousValue;
  let newRate = previousRate;

  if (delta.gt(ZERO) && movementSuppliesIncomingRate(movement)) {
    const incomingRate = historicalIncomingRate(movement, previousRate);
    newValue = repairMoney(previousValue.plus(delta.times(incomingRate)));
    newRate = newQty.gt(ZERO) ? repairRate(newValue.dividedBy(newQty)) : repairRate(incomingRate);
  } else if (delta.lt(ZERO)) {
    const effectiveRate = repairRate(Decimal.max(previousRate, ZERO));
    newValue = repairMoney(previousValue.minus(delta.abs().times(effectiveRate)));
    if (newQty.gt(ZERO)) {
      if (newValue.lt(ZERO)) newValue = ZERO;
      newRate = repairRate(newValue.dividedBy(newQty));
    } else {
      newValue = ZERO;
      newRate = ZERO;
    }
  }

  if (newQty.gt(ZERO) && newValue.lt(ZERO)) {
    newValue = ZERO;
    newRate = ZERO;
  } else if (newQty.lte(ZERO)) {
    newValue = ZERO;
  }
  if (newRate.lt(ZERO)) newRate = ZERO;

  return rawUnclampedHistoricalInventoryState(newQty, newRate, newValue);
}

export function createHistoricalForwardReplayState(
  inventory: HistoricalInventoryState,
  negativeLayerQuantity: Decimal.Value = 0
): HistoricalForwardReplayState {
  return {
    inventory: rawUnclampedHistoricalInventoryState(inventory.quantity, inventory.averageRate, inventory.totalValue),
    negativeLayerQuantity: repairQuantity(Decimal.max(decimal(negativeLayerQuantity, "negative layer quantity"), ZERO)),
  };
}

export function applyHistoricalForwardReplayMovement(
  state: HistoricalForwardReplayState,
  movement: HistoricalSalesRepairMovement
): HistoricalForwardReplayState {
  if (isExactValuationReset(movement)) {
    return {
      inventory: applyHistoricalSalesRepairMovement(state.inventory, movement),
      negativeLayerQuantity: repairQuantity(state.negativeLayerQuantity),
    };
  }

  const mutationAt = movementTimeMs(movement);
  const delta = repairQuantity(movement.quantityDelta);
  const previousQty = repairQuantity(state.inventory.quantity);
  let layerQty = repairQuantity(state.negativeLayerQuantity);

  if (INITIAL_OFFLOAD_SOURCE_TYPES.has(movement.sourceType)) {
    return {
      inventory: applyHistoricalSalesRepairMovement(state.inventory, movement),
      // Initial container offloads always used their own valuation path. After
      // negative layers were introduced they also bypassed layer settlement,
      // which is how stale layers could survive after stock crossed positive.
      negativeLayerQuantity: layerQty,
    };
  }

  if (EXACT_OFFLOAD_REMOVAL_SOURCE_TYPES.has(movement.sourceType)) {
    const inventory = applyHistoricalSalesRepairMovement(state.inventory, movement);
    if (mutationAt >= NEGATIVE_LAYER_ENGINE_AT && delta.lt(ZERO)) {
      layerQty = addNegativeLayerQuantity(layerQty, previousQty, repairQuantity(inventory.quantity), mutationAt);
    }
    return { inventory, negativeLayerQuantity: layerQty };
  }

  if (mutationAt < INVENTORY_SAFETY_CLAMP_AT) {
    return {
      inventory: applyPreSafetyInventoryMovement(state.inventory, movement),
      negativeLayerQuantity: layerQty,
    };
  }

  if (mutationAt < NEGATIVE_LAYER_ENGINE_AT) {
    return {
      inventory: applySafetyClampInventoryMovement(state.inventory, movement),
      negativeLayerQuantity: layerQty,
    };
  }

  const previousRate = repairRate(Decimal.max(state.inventory.averageRate, ZERO));
  const previousValue = repairMoney(Decimal.max(state.inventory.totalValue, ZERO));
  const newQty = repairQuantity(previousQty.plus(delta));

  if (delta.gt(ZERO)) {
    const effectiveRate = historicalIncomingRate(movement, previousRate);
    const shouldSettleLayers = mutationAt < STALE_LAYER_SETTLEMENT_FIX_AT || previousQty.lt(ZERO);
    const settled = shouldSettleLayers ? Decimal.min(layerQty, delta) : ZERO;
    layerQty = repairQuantity(Decimal.max(layerQty.minus(settled), ZERO));
    const remaining = repairQuantity(delta.minus(settled));
    let newValue = repairMoney(Decimal.max(previousValue.plus(remaining.times(effectiveRate)), ZERO));
    let newRate: Decimal;
    if (newQty.gt(ZERO)) {
      newRate = repairRate(newValue.dividedBy(newQty));
    } else {
      newValue = ZERO;
      newRate = repairRate(effectiveRate);
    }
    return {
      inventory: rawHistoricalInventoryState(newQty, newRate, newValue),
      negativeLayerQuantity: layerQty,
    };
  }

  if (delta.lt(ZERO)) {
    const effectiveRate = repairRate(Decimal.max(previousRate, ZERO));
    if (newQty.gt(ZERO)) {
      const newValue = repairMoney(Decimal.max(previousValue.minus(delta.abs().times(effectiveRate)), ZERO));
      return {
        inventory: rawHistoricalInventoryState(newQty, repairRate(newValue.dividedBy(newQty)), newValue),
        negativeLayerQuantity: layerQty,
      };
    }

    layerQty = addNegativeLayerQuantity(layerQty, previousQty, newQty, mutationAt);
    return {
      inventory: rawHistoricalInventoryState(newQty, effectiveRate, ZERO),
      negativeLayerQuantity: layerQty,
    };
  }

  return {
    inventory: rawHistoricalInventoryState(previousQty, previousRate, previousValue),
    negativeLayerQuantity: layerQty,
  };
}

/**
 * Replays the inventory value rules used by the production inventory valuation path:
 * - receipts into positive stock are weighted average,
 * - a receipt first fills a negative shortage before carrying asset value,
 * - issues leave the average rate unchanged and consume at the pre-issue rate,
 * - negative/zero on-hand carries zero asset value but keeps cost memory.
 *
 * When unitCost is null (legacy manual add / credit-note stock return), the
 * existing average is used, matching the production valuation behavior when no incoming rate
 * was supplied.
 */
export function applyHistoricalInventoryMovement(
  state: HistoricalInventoryState,
  input: { quantityDelta: Decimal.Value; unitCost?: Decimal.Value | null }
): HistoricalInventoryState {
  const delta = repairQuantity(input.quantityDelta);
  const previousQty = repairQuantity(state.quantity);
  const previousRate = repairRate(Decimal.max(state.averageRate, ZERO));
  const previousValue = repairMoney(Decimal.max(state.totalValue, ZERO));
  // Match the production adjustInventory helper: receipt value uses the full
  // transaction-time incoming rate (canonical unit_cost is 6dp). Only the
  // persisted inventory average is rounded to RATE_DP/2dp.
  const incomingRate =
    input.unitCost === null || input.unitCost === undefined
      ? previousRate
      : Decimal.max(decimal(input.unitCost, "movement unit cost"), ZERO);
  const newQty = repairQuantity(previousQty.plus(delta));

  if (delta.gt(ZERO)) {
    const valueBearingQty = previousQty.isNegative() ? Decimal.max(delta.minus(previousQty.abs()), ZERO) : delta;
    if (newQty.lte(ZERO)) {
      return {
        quantity: newQty,
        averageRate: repairRate(incomingRate),
        totalValue: ZERO,
      };
    }

    const newValue = repairMoney(Decimal.max(previousValue.plus(valueBearingQty.times(incomingRate)), ZERO));
    return {
      quantity: newQty,
      averageRate: repairRate(newValue.dividedBy(newQty)),
      totalValue: newValue,
    };
  }

  if (delta.lt(ZERO)) {
    if (newQty.gt(ZERO)) {
      const newValue = repairMoney(Decimal.max(previousValue.minus(delta.abs().times(previousRate)), ZERO));
      return {
        quantity: newQty,
        averageRate: repairRate(newValue.dividedBy(newQty)),
        totalValue: newValue,
      };
    }

    return {
      quantity: newQty,
      averageRate: previousRate,
      totalValue: ZERO,
    };
  }

  return {
    quantity: previousQty,
    averageRate: previousRate,
    totalValue: previousValue,
  };
}
