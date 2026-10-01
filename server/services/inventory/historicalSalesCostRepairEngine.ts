import Decimal from "decimal.js";

export const HISTORICAL_SALES_COST_REPAIR_ALGORITHM_VERSION = "2026-10-01-v42-dropped-lines-in-checkpoint-rewind";

const ZERO = new Decimal(0);

function hscrEngineError(code: string): Error {
  const error = new Error();
  error.message = code;
  return error;
}

function decimal(value: Decimal.Value | null | undefined, field: string): Decimal {
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

const EXACT_VALUATION_RESET_SOURCE_TYPES = new Set([
  "inventory-valuation-wave6-reset",
  "inventory-valuation-override",
]);

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

const INITIAL_OFFLOAD_SOURCE_TYPES = new Set(["container-offload", "legacy-container-offload"]);
const EXACT_OFFLOAD_REMOVAL_SOURCE_TYPES = new Set([
  "offload_optional_suspend",
  "container-reverse-offload",
  "container-reverse-offload-legacy",
]);

function rawHistoricalInventoryState(
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

function valuationResetState(
  reset: NonNullable<HistoricalSalesRepairMovement["valuationReset"]>,
  side: "before" | "after"
): HistoricalInventoryState {
  return rawHistoricalInventoryState(
    side === "before" ? reset.beforeQuantity : reset.afterQuantity,
    side === "before" ? reset.beforeAverageRate : reset.afterAverageRate,
    side === "before" ? reset.beforeTotalValue : reset.afterTotalValue
  );
}

function valuationResetStateMatches(
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
  if (
    !delta.gt(ZERO) ||
    movement.exactValue === null ||
    movement.exactValue === undefined
  ) {
    return applyHistoricalInventoryMovement(state, {
      quantityDelta: movement.quantityDelta,
      unitCost: movement.unitCost,
    });
  }

  const previousQty = repairQuantity(state.quantity);
  const previousRate = repairRate(Decimal.max(state.averageRate, ZERO));
  const previousValue = repairMoney(state.totalValue);
  const exactValue = repairMoney(movement.exactValue);
  const incomingRate = exactOffloadRate(movement, delta);
  const newQty = repairQuantity(previousQty.plus(delta));
  const mutationAt = movementTimeMs(movement);

  if (newQty.isZero()) {
    return rawHistoricalInventoryState(newQty, incomingRate, ZERO);
  }

  if (newQty.lt(ZERO)) {
    return rawHistoricalInventoryState(
      newQty,
      incomingRate,
      repairMoney(newQty.times(incomingRate))
    );
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
  if (
    !delta.lt(ZERO) ||
    movement.exactValue === null ||
    movement.exactValue === undefined
  ) {
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


function movementSuppliesIncomingRate(movement: HistoricalSalesRepairMovement): boolean {
  const delta = repairQuantity(movement.quantityDelta);
  if (!delta.gt(ZERO)) return false;
  // POS reversal/edit receipts historically restored quantity without passing
  // the old line cost into adjustInventory(). The canonical journal still
  // recorded that old cost, so treating unit_cost as an incoming receipt rate
  // would replay a valuation path production never used.
  if (movement.sourceType === "pos-sale") return false;
  return movement.unitCost !== null && movement.unitCost !== undefined;
}

function historicalIncomingRate(
  movement: HistoricalSalesRepairMovement,
  previousRate: Decimal
): Decimal {
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
    mutationAt < INCREMENTAL_SHORTAGE_FIX_AT
      ? newQty.abs()
      : incrementalShortageQuantity(previousQty, newQty);
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
    const newRate = newQty.gt(ZERO)
      ? repairRate(newValue.dividedBy(newQty))
      : repairRate(incomingRate);
    return rawUnclampedHistoricalInventoryState(newQty, newRate, newValue);
  }

  if (delta.lt(ZERO)) {
    const newValue = repairMoney(previousValue.minus(delta.abs().times(previousRate)));
    const newRate = newQty.gt(ZERO)
      ? repairRate(newValue.dividedBy(newQty))
      : previousRate;
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
    newRate = newQty.gt(ZERO)
      ? repairRate(newValue.dividedBy(newQty))
      : repairRate(incomingRate);
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
    inventory: rawUnclampedHistoricalInventoryState(
      inventory.quantity,
      inventory.averageRate,
      inventory.totalValue
    ),
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
      layerQty = addNegativeLayerQuantity(
        layerQty,
        previousQty,
        repairQuantity(inventory.quantity),
        mutationAt
      );
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
    const shouldSettleLayers =
      mutationAt < STALE_LAYER_SETTLEMENT_FIX_AT || previousQty.lt(ZERO);
    const settled = shouldSettleLayers
      ? Decimal.min(layerQty, delta)
      : ZERO;
    layerQty = repairQuantity(Decimal.max(layerQty.minus(settled), ZERO));
    const remaining = repairQuantity(delta.minus(settled));
    let newValue = repairMoney(
      Decimal.max(previousValue.plus(remaining.times(effectiveRate)), ZERO)
    );
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
      const newValue = repairMoney(
        Decimal.max(previousValue.minus(delta.abs().times(effectiveRate)), ZERO)
      );
      return {
        inventory: rawHistoricalInventoryState(
          newQty,
          repairRate(newValue.dividedBy(newQty)),
          newValue
        ),
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

function statesEqual(left: HistoricalInventoryState, right: HistoricalInventoryState): boolean {
  return (
    repairQuantity(left.quantity).eq(repairQuantity(right.quantity)) &&
    repairRate(left.averageRate).eq(repairRate(right.averageRate)) &&
    repairMoney(left.totalValue).eq(repairMoney(right.totalValue))
  );
}

function statesEqualQuantityAndValue(
  left: HistoricalInventoryState,
  right: HistoricalInventoryState
): boolean {
  return (
    repairQuantity(left.quantity).eq(repairQuantity(right.quantity)) &&
    repairMoney(left.totalValue).eq(repairMoney(right.totalValue))
  );
}

function stateRateDisagreesWithValue(state: HistoricalInventoryState): boolean {
  const quantity = repairQuantity(state.quantity);
  if (!quantity.gt(ZERO)) return false;
  return !repairRate(state.totalValue.dividedBy(quantity)).eq(repairRate(state.averageRate));
}

function canonicalRateOnlyRecovery(
  stateAfter: HistoricalInventoryState,
  movement: HistoricalSalesRepairMovement
): HistoricalInventoryReverseResult | null {
  if (movement.evidence !== "canonical") return null;
  if (!repairQuantity(stateAfter.quantity).gt(ZERO)) return null;
  if (!stateRateDisagreesWithValue(stateAfter)) return null;

  const delta = repairQuantity(movement.quantityDelta);
  if (delta.isZero()) return null;
  const previousQty = repairQuantity(stateAfter.quantity.minus(delta));
  if (!previousQty.gt(ZERO)) return null;

  let stateBefore: HistoricalInventoryState | null = null;

  const adjustmentEditRecovery = canonicalAdjustmentEditApplyValueInverse(
    stateAfter,
    movement
  );
  if (adjustmentEditRecovery) return adjustmentEditRecovery;

  if (
    INITIAL_OFFLOAD_SOURCE_TYPES.has(movement.sourceType) &&
    delta.gt(ZERO) &&
    movement.exactValue !== null &&
    movement.exactValue !== undefined
  ) {
    const beforeValue = repairMoney(stateAfter.totalValue.minus(repairMoney(movement.exactValue)));
    if (beforeValue.lt(ZERO)) return null;
    stateBefore = rawHistoricalInventoryState(
      previousQty,
      repairRate(beforeValue.dividedBy(previousQty)),
      beforeValue
    );
  } else if (
    EXACT_OFFLOAD_REMOVAL_SOURCE_TYPES.has(movement.sourceType) &&
    delta.lt(ZERO) &&
    movement.exactValue !== null &&
    movement.exactValue !== undefined
  ) {
    const beforeValue = repairMoney(
      stateAfter.totalValue.plus(repairMoney(movement.exactValue))
    );
    stateBefore = rawHistoricalInventoryState(
      previousQty,
      repairRate(beforeValue.dividedBy(previousQty)),
      beforeValue
    );
  } else if (
    delta.gt(ZERO) &&
    movement.sourceType === "pos-sale"
  ) {
    // Historical POS edit/delete reversals restored quantity without passing
    // the old sale-line cost to adjustInventory(). V19 proved that replacing
    // every POS receipt inverse globally is not monotonic, so V23 only reaches
    // this branch after the primary V22 inverse has already failed.
    //
    // Search the narrow 2dp rate neighborhood for a UNIQUE self-consistent
    // pre-state whose unpriced replay reproduces quantity and total value
    // exactly. The post-state average-rate field is allowed to disagree because
    // this helper is invoked only when stateRateDisagreesWithValue() already
    // proved that the reconstructed intermediate rate is stale.
    const evaluateCandidates = (center: Decimal): HistoricalInventoryState[] => {
      const candidates: HistoricalInventoryState[] = [];
      for (const candidateRate of candidateRatesAround(center)) {
        const beforeValue = repairMoney(
          stateAfter.totalValue.minus(delta.times(candidateRate))
        );
        if (beforeValue.lt(ZERO)) continue;
        const candidate = rawHistoricalInventoryState(
          previousQty,
          candidateRate,
          beforeValue
        );
        if (!repairRate(beforeValue.dividedBy(previousQty)).eq(candidateRate)) {
          continue;
        }
        const replayed = applyHistoricalInventoryMovement(candidate, {
          quantityDelta: delta,
          unitCost: null,
        });
        if (statesEqualQuantityAndValue(replayed, stateAfter)) {
          candidates.push(candidate);
        }
      }
      return candidates;
    };

    const primaryCandidates = evaluateCandidates(stateAfter.averageRate);
    if (primaryCandidates.length > 1) return null;
    if (primaryCandidates.length === 1) {
      stateBefore = primaryCandidates[0];
    } else {
      const derivedCenter = derivedRateCandidateCenter(stateAfter);
      if (!derivedCenter) return null;
      const derivedCandidates = evaluateCandidates(derivedCenter);
      if (derivedCandidates.length !== 1) return null;
      stateBefore = derivedCandidates[0];
    }
  } else if (
    delta.gt(ZERO) &&
    movement.sourceType !== "pos-sale" &&
    movementSuppliesIncomingRate(movement)
  ) {
    const incomingRate = Decimal.max(
      decimal(movement.unitCost, "canonical incoming movement cost"),
      ZERO
    );
    const beforeValue = repairMoney(stateAfter.totalValue.minus(delta.times(incomingRate)));
    if (beforeValue.lt(ZERO)) return null;
    stateBefore = rawHistoricalInventoryState(
      previousQty,
      repairRate(beforeValue.dividedBy(previousQty)),
      beforeValue
    );
  } else if (
    delta.lt(ZERO) &&
    (movement.sourceType === "stock-transfer" ||
      (movement.sourceType === "pos-sale" &&
        (movement.canonicalPosRole === "edit-issue" || movement.canonicalPosRole === "dropped-line")))
  ) {
    // A POS edit re-issue also consumed the live stored rate while journaling
    // the preserved old line cost, so it uses the same unique source-rate search.
    // The transfer document rate is recorded in the canonical journal, but the
    // source-side deduction in adjustInventory() consumes stock at the source
    // inventory average rate. When the reconstructed intermediate rate is stale,
    // recover only a UNIQUE self-consistent source-rate candidate whose issue
    // replay preserves quantity and total value exactly.
    const evaluateCandidates = (center: Decimal): HistoricalInventoryState[] => {
      const candidates: HistoricalInventoryState[] = [];
      for (const candidateRate of candidateRatesAround(center)) {
        const beforeValue = repairMoney(
          stateAfter.totalValue.plus(delta.abs().times(candidateRate))
        );
        const candidate = rawHistoricalInventoryState(
          previousQty,
          candidateRate,
          beforeValue
        );
        if (!repairRate(beforeValue.dividedBy(previousQty)).eq(candidateRate)) {
          continue;
        }
        const replayed = applyHistoricalInventoryMovement(candidate, {
          quantityDelta: delta,
          unitCost: movement.unitCost,
        });
        if (statesEqualQuantityAndValue(replayed, stateAfter)) {
          candidates.push(candidate);
        }
      }
      return candidates;
    };

    const primaryCandidates = evaluateCandidates(stateAfter.averageRate);
    if (primaryCandidates.length > 1) return null;
    if (primaryCandidates.length === 1) {
      stateBefore = primaryCandidates[0];
    } else {
      const derivedCenter = derivedRateCandidateCenter(stateAfter);
      if (!derivedCenter) return null;
      const derivedCandidates = evaluateCandidates(derivedCenter);
      if (derivedCandidates.length !== 1) return null;
      stateBefore = derivedCandidates[0];
    }
  } else if (
    delta.lt(ZERO) &&
    !posJournalCostIsNotInventoryRate(movement) &&
    (movement.sourceType === "pos-sale" ||
      movement.sourceType === "canonical-sale-lifecycle-correction") &&
    movement.unitCost !== null &&
    movement.unitCost !== undefined
  ) {
    // Canonical POS issue unit_cost is the locked pre-sale inventory average
    // recorded in the same transaction as the deduction. A negative lifecycle
    // correction is synthesized from latestNegativeRate, the quantity-weighted
    // canonical issue rate pinned to that sale's latest mutation. Both are
    // direct canonical evidence of the cost basis used for the missing issue.
    const recordedRate = repairRate(
      Decimal.max(decimal(movement.unitCost, "canonical POS issue cost"), ZERO)
    );
    const beforeValue = repairMoney(
      stateAfter.totalValue.plus(delta.abs().times(recordedRate))
    );
    stateBefore = rawHistoricalInventoryState(previousQty, recordedRate, beforeValue);
  } else {
    return null;
  }

  const replayed =
    movement.sourceType === "pos-sale" && delta.gt(ZERO)
      ? applyHistoricalInventoryMovement(stateBefore, {
          quantityDelta: movement.quantityDelta,
          unitCost: null,
        })
      : applyHistoricalSalesRepairMovement(stateBefore, movement);
  if (!statesEqualQuantityAndValue(replayed, stateAfter)) return null;
  if (repairRate(replayed.averageRate).eq(repairRate(stateAfter.averageRate))) return null;

  return {
    reversible: true,
    stateBefore,
    recovery: "CANONICAL_RATE_ONLY",
  };
}

function candidateRatesAround(rate: Decimal): Decimal[] {
  const center = repairRate(Decimal.max(rate, ZERO));
  const values: Decimal[] = [];
  for (let cents = -10; cents <= 10; cents += 1) {
    const candidate = center.plus(new Decimal(cents).dividedBy(100));
    if (candidate.gte(ZERO)) values.push(repairRate(candidate));
  }
  return values;
}

function derivedRateCandidateCenter(state: HistoricalInventoryState): Decimal | null {
  const quantity = repairQuantity(state.quantity);
  if (!quantity.gt(ZERO)) return null;
  return repairRate(Decimal.max(state.totalValue.dividedBy(quantity), ZERO));
}

function legacyIssueRateOnlyRecovery(
  stateAfter: HistoricalInventoryState,
  movement: HistoricalSalesRepairMovement
): HistoricalInventoryReverseResult | null {
  if (movement.evidence !== "legacy" || movement.sourceType !== "legacy-sale") {
    return null;
  }
  if (!stateRateDisagreesWithValue(stateAfter)) return null;

  const delta = repairQuantity(movement.quantityDelta);
  if (!delta.lt(ZERO)) return null;
  const previousQty = repairQuantity(stateAfter.quantity.minus(delta));
  if (!repairQuantity(stateAfter.quantity).gt(ZERO) || !previousQty.gt(ZERO)) {
    return null;
  }

  const evaluateCandidates = (center: Decimal): HistoricalInventoryState[] => {
    const candidates: HistoricalInventoryState[] = [];
    for (const candidateRate of candidateRatesAround(center)) {
      const beforeValue = repairMoney(
        stateAfter.totalValue.plus(delta.abs().times(candidateRate))
      );
      if (beforeValue.lt(ZERO)) continue;
      const candidate = rawHistoricalInventoryState(
        previousQty,
        candidateRate,
        beforeValue
      );
      if (!repairRate(beforeValue.dividedBy(previousQty)).eq(candidateRate)) {
        continue;
      }
      const replayed = applyHistoricalInventoryMovement(candidate, {
        quantityDelta: delta,
        unitCost: null,
      });
      if (statesEqualQuantityAndValue(replayed, stateAfter)) {
        candidates.push(candidate);
      }
    }
    return candidates;
  };

  const primaryCandidates = evaluateCandidates(stateAfter.averageRate);
  if (primaryCandidates.length > 1) return null;

  let stateBefore: HistoricalInventoryState;
  if (primaryCandidates.length === 1) {
    stateBefore = primaryCandidates[0];
  } else {
    const derivedCenter = derivedRateCandidateCenter(stateAfter);
    if (!derivedCenter) return null;
    const derivedCandidates = evaluateCandidates(derivedCenter);
    if (derivedCandidates.length !== 1) return null;
    stateBefore = derivedCandidates[0];
  }
  const replayed = applyHistoricalInventoryMovement(stateBefore, {
    quantityDelta: delta,
    unitCost: null,
  });
  if (!statesEqualQuantityAndValue(replayed, stateAfter)) return null;
  if (repairRate(replayed.averageRate).eq(repairRate(stateAfter.averageRate))) {
    return null;
  }

  return {
    reversible: true,
    stateBefore,
    recovery: "LEGACY_ISSUE_RATE_ONLY",
  };
}

function canonicalAdjustmentEditApplyValueInverse(
  stateAfter: HistoricalInventoryState,
  movement: HistoricalSalesRepairMovement
): HistoricalInventoryReverseResult | null {
  if (
    movement.evidence !== "canonical" ||
    movement.sourceType !== "stock_adjustment_edit_apply" ||
    movement.unitCost === null ||
    movement.unitCost === undefined
  ) {
    return null;
  }

  const delta = repairQuantity(movement.quantityDelta);
  if (!delta.lt(ZERO)) return null;

  const previousQty = repairQuantity(stateAfter.quantity.minus(delta));
  if (!previousQty.gt(ZERO)) return null;

  const exactIssueValue = repairMoney(
    delta.abs().times(decimal(movement.unitCost, "adjustment edit apply unit cost"))
  );
  const beforeValue = repairMoney(stateAfter.totalValue.plus(exactIssueValue));
  const beforeRate = repairRate(
    beforeValue.gt(ZERO)
      ? beforeValue.dividedBy(previousQty)
      : Decimal.max(decimal(movement.unitCost, "adjustment edit apply fallback rate"), ZERO)
  );
  const stateBefore = rawHistoricalInventoryState(previousQty, beforeRate, beforeValue);

  const replayQty = repairQuantity(previousQty.plus(delta));
  const replayValue = replayQty.gt(ZERO)
    ? repairMoney(Decimal.max(beforeValue.minus(exactIssueValue), ZERO))
    : ZERO;
  const replayRate =
    replayQty.gt(ZERO) && replayValue.gt(ZERO)
      ? repairRate(replayValue.dividedBy(replayQty))
      : repairRate(Decimal.max(decimal(movement.unitCost, "adjustment edit apply replay rate"), ZERO));
  const replayed = rawHistoricalInventoryState(replayQty, replayRate, replayValue);

  if (!statesEqualQuantityAndValue(replayed, stateAfter)) return null;

  return {
    reversible: true,
    stateBefore,
    recovery: "CANONICAL_ADJUSTMENT_EDIT_VALUE",
  };
}

function legacyExactReceiptRateOnlyRecovery(
  stateAfter: HistoricalInventoryState,
  movement: HistoricalSalesRepairMovement
): HistoricalInventoryReverseResult | null {
  if (
    movement.evidence !== "legacy" ||
    movement.sourceType !== "legacy-container-offload" ||
    movement.exactValue === null ||
    movement.exactValue === undefined
  ) {
    return null;
  }
  if (!stateRateDisagreesWithValue(stateAfter)) return null;

  const delta = repairQuantity(movement.quantityDelta);
  if (!delta.gt(ZERO)) return null;
  const previousQty = repairQuantity(stateAfter.quantity.minus(delta));
  if (!repairQuantity(stateAfter.quantity).gt(ZERO) || !previousQty.gt(ZERO)) {
    return null;
  }

  const beforeValue = repairMoney(
    stateAfter.totalValue.minus(repairMoney(movement.exactValue))
  );
  if (beforeValue.lt(ZERO)) return null;

  const stateBefore = rawHistoricalInventoryState(
    previousQty,
    repairRate(beforeValue.dividedBy(previousQty)),
    beforeValue
  );
  const replayed = applyHistoricalSalesRepairMovement(stateBefore, movement);
  if (!statesEqualQuantityAndValue(replayed, stateAfter)) return null;
  if (repairRate(replayed.averageRate).eq(repairRate(stateAfter.averageRate))) {
    return null;
  }

  return {
    reversible: true,
    stateBefore,
    recovery: "LEGACY_RECEIPT_RATE_ONLY",
  };
}

export type HistoricalInventoryReverseResult =
  | {
      reversible: true;
      stateBefore: HistoricalInventoryState;
      recovery?:
        | "CANONICAL_RATE_ONLY"
        | "CANONICAL_RECORDED_ISSUE_RATE"
        | "CANONICAL_ADJUSTMENT_EDIT_VALUE"
        | "LEGACY_ISSUE_RATE_ONLY"
        | "LEGACY_RECEIPT_RATE_ONLY";
    }
  | {
      reversible: false;
      reason: "COST_MEMORY_IRREVERSIBLE" | "MOVEMENT_INVERSE_NOT_UNIQUE" | "MOVEMENT_INVERSE_INVALID";
    };

/**
 * Inverts one inventory movement using the same rounded quantity/value/rate
 * semantics as applyHistoricalInventoryMovement().
 *
 * A priced receipt that starts at zero/negative stock overwrites the previous
 * cost-memory rate. That earlier rate is mathematically unrecoverable from the
 * post-receipt state alone, so callers must quarantine the key instead of
 * guessing.
 */
export function reverseHistoricalInventoryMovement(
  stateAfterInput: HistoricalInventoryState,
  input: {
    quantityDelta: Decimal.Value;
    unitCost?: Decimal.Value | null;
    priorCostMemoryRate?: Decimal.Value | null;
  }
): HistoricalInventoryReverseResult {
  const stateAfter = createHistoricalInventoryStateFromSnapshot(
    stateAfterInput.quantity,
    stateAfterInput.averageRate,
    stateAfterInput.totalValue
  );
  const delta = repairQuantity(input.quantityDelta);
  const previousQty = repairQuantity(stateAfter.quantity.minus(delta));

  if (delta.isZero()) {
    return { reversible: true, stateBefore: stateAfter };
  }

  if (delta.gt(ZERO)) {
    if (input.unitCost !== null && input.unitCost !== undefined && previousQty.lte(ZERO)) {
      if (input.priorCostMemoryRate !== null && input.priorCostMemoryRate !== undefined) {
        const priorRate = repairRate(
          Decimal.max(decimal(input.priorCostMemoryRate, "prior cost memory rate"), ZERO)
        );
        const stateBefore = createHistoricalInventoryStateFromSnapshot(previousQty, priorRate, ZERO);
        const replayed = applyHistoricalInventoryMovement(stateBefore, {
          quantityDelta: delta,
          unitCost: input.unitCost,
        });
        if (statesEqual(replayed, stateAfter)) {
          return { reversible: true, stateBefore };
        }
        return { reversible: false, reason: "MOVEMENT_INVERSE_INVALID" };
      }
      // V41: into exactly empty stock the receipt alone sets quantity, value
      // and rate, whatever the erased cost memory was. A rewound state that
      // disagrees proves the model above this point wrong.
      if (previousQty.isZero()) {
        const replayed = applyHistoricalInventoryMovement(
          createHistoricalInventoryStateFromSnapshot(ZERO, ZERO, ZERO),
          { quantityDelta: delta, unitCost: input.unitCost }
        );
        if (!statesEqualQuantityAndValue(replayed, stateAfter)) return { reversible: false, reason: "MOVEMENT_INVERSE_INVALID" };
      }
      return { reversible: false, reason: "COST_MEMORY_IRREVERSIBLE" };
    }

    if (input.unitCost !== null && input.unitCost !== undefined) {
      // Production multiplies receipt quantity by the full incoming cost
      // precision and only rounds the stored inventory value/rate afterwards.
      // Canonical movement unit_cost is 6dp, so do not round it to the 2dp
      // inventory-rate scale before reconstructing value.
      const incomingRate = Decimal.max(decimal(input.unitCost, "movement unit cost"), ZERO);
      if (previousQty.lte(ZERO)) {
        return { reversible: false, reason: "COST_MEMORY_IRREVERSIBLE" };
      }
      const beforeValue = repairMoney(stateAfter.totalValue.minus(delta.times(incomingRate)));
      if (beforeValue.lt(ZERO)) {
        return { reversible: false, reason: "MOVEMENT_INVERSE_INVALID" };
      }
      const beforeRate = repairRate(beforeValue.dividedBy(previousQty));
      const stateBefore = createHistoricalInventoryStateFromSnapshot(previousQty, beforeRate, beforeValue);
      const replayed = applyHistoricalInventoryMovement(stateBefore, {
        quantityDelta: delta,
        unitCost: input.unitCost,
      });
      return statesEqual(replayed, stateAfter)
        ? { reversible: true, stateBefore }
        : { reversible: false, reason: "MOVEMENT_INVERSE_INVALID" };
    }

    if (previousQty.lte(ZERO)) {
      const stateBefore = createHistoricalInventoryStateFromSnapshot(previousQty, stateAfter.averageRate, ZERO);
      const replayed = applyHistoricalInventoryMovement(stateBefore, { quantityDelta: delta, unitCost: null });
      return statesEqual(replayed, stateAfter)
        ? { reversible: true, stateBefore }
        : { reversible: false, reason: "MOVEMENT_INVERSE_INVALID" };
    }

    const candidates: HistoricalInventoryState[] = [];
    for (const candidateRate of candidateRatesAround(stateAfter.averageRate)) {
      const beforeValue = repairMoney(stateAfter.totalValue.minus(delta.times(candidateRate)));
      if (beforeValue.lt(ZERO)) continue;
      const stateBefore = createHistoricalInventoryStateFromSnapshot(previousQty, candidateRate, beforeValue);
      if (!repairRate(stateBefore.totalValue.dividedBy(previousQty)).eq(candidateRate)) continue;
      const replayed = applyHistoricalInventoryMovement(stateBefore, { quantityDelta: delta, unitCost: null });
      if (statesEqual(replayed, stateAfter)) candidates.push(stateBefore);
    }
    return candidates.length === 1
      ? { reversible: true, stateBefore: candidates[0] }
      : {
          reversible: false,
          reason: candidates.length === 0 ? "MOVEMENT_INVERSE_INVALID" : "MOVEMENT_INVERSE_NOT_UNIQUE",
        };
  }

  const issueQty = delta.abs();
  if (previousQty.lte(ZERO)) {
    return { reversible: false, reason: "MOVEMENT_INVERSE_INVALID" };
  }

  if (stateAfter.quantity.lte(ZERO)) {
    const stateBefore = createHistoricalInventoryState(previousQty, stateAfter.averageRate);
    const replayed = applyHistoricalInventoryMovement(stateBefore, {
      quantityDelta: delta,
      unitCost: input.unitCost,
    });
    return statesEqual(replayed, stateAfter)
      ? { reversible: true, stateBefore }
      : { reversible: false, reason: "MOVEMENT_INVERSE_INVALID" };
  }

  // Canonical issue rows carry the transaction-time cost. For an outbound
  // movement that leaves positive stock, that rate is the exact cost memory
  // used by applyHistoricalInventoryMovement(), so try it before any inference.
  // V31: a recorded rate is accepted only when it is a production-consistent
  // pre-issue state. A document rate that differs from the live average (old
  // POS line cost, caller-supplied transfer rate) yields a state production
  // could never have stored, so inference continues from the exact value.
  if (input.unitCost !== null && input.unitCost !== undefined) {
    const recordedRate = repairRate(Decimal.max(decimal(input.unitCost, "movement unit cost"), ZERO));
    const beforeValue = repairMoney(stateAfter.totalValue.plus(issueQty.times(recordedRate)));
    const stateBefore = createHistoricalInventoryStateFromSnapshot(previousQty, recordedRate, beforeValue);
    const replayed = applyHistoricalInventoryMovement(stateBefore, {
      quantityDelta: delta,
      unitCost: recordedRate,
    });
    if (statesEqual(replayed, stateAfter) && historicalStateRateMatchesValue(stateBefore)) {
      return { reversible: true, stateBefore };
    }
  }

  // Issues do not intentionally reprice inventory. In most legacy cases the
  // rounded post-issue average is therefore also the pre-issue average.
  const directRate = repairRate(stateAfter.averageRate);
  const directBeforeValue = repairMoney(stateAfter.totalValue.plus(issueQty.times(directRate)));
  const directStateBefore = createHistoricalInventoryStateFromSnapshot(
    previousQty,
    directRate,
    directBeforeValue
  );
  const directReplay = applyHistoricalInventoryMovement(directStateBefore, {
    quantityDelta: delta,
    unitCost: input.unitCost,
  });
  if (statesEqual(directReplay, stateAfter)) {
    return { reversible: true, stateBefore: directStateBefore };
  }

  const candidates: HistoricalInventoryState[] = [];
  for (const candidateRate of candidateRatesAround(stateAfter.averageRate)) {
    const beforeValue = repairMoney(stateAfter.totalValue.plus(issueQty.times(candidateRate)));
    const stateBefore = createHistoricalInventoryStateFromSnapshot(previousQty, candidateRate, beforeValue);
    if (!repairRate(stateBefore.totalValue.dividedBy(previousQty)).eq(candidateRate)) continue;
    const replayed = applyHistoricalInventoryMovement(stateBefore, {
      quantityDelta: delta,
      unitCost: input.unitCost,
    });
    if (statesEqual(replayed, stateAfter)) candidates.push(stateBefore);
  }

  return candidates.length === 1
    ? { reversible: true, stateBefore: candidates[0] }
    : {
        reversible: false,
        reason: candidates.length === 0 ? "MOVEMENT_INVERSE_INVALID" : "MOVEMENT_INVERSE_NOT_UNIQUE",
      };
}

export function reverseHistoricalSalesRepairMovement(
  stateAfterInput: HistoricalInventoryState,
  movement: HistoricalSalesRepairMovement,
  input?: { priorCostMemoryRate?: Decimal.Value | null }
): HistoricalInventoryReverseResult {
  const stateAfter = rawHistoricalInventoryState(
    stateAfterInput.quantity,
    stateAfterInput.averageRate,
    stateAfterInput.totalValue
  );
  const delta = repairQuantity(movement.quantityDelta);

  if (isExactValuationReset(movement)) {
    const expectedAfter = valuationResetState(movement.valuationReset, "after");
    if (!valuationResetStateMatches(stateAfter, expectedAfter)) {
      return { reversible: false, reason: "MOVEMENT_INVERSE_INVALID" };
    }
    return {
      reversible: true,
      stateBefore: valuationResetState(movement.valuationReset, "before"),
    };
  }

  if (
    INITIAL_OFFLOAD_SOURCE_TYPES.has(movement.sourceType) &&
    delta.gt(ZERO) &&
    movement.exactValue !== null &&
    movement.exactValue !== undefined
  ) {
    const previousQty = repairQuantity(stateAfter.quantity.minus(delta));
    const exactValue = repairMoney(movement.exactValue);

    if (previousQty.gt(ZERO)) {
      const beforeValue = repairMoney(stateAfter.totalValue.minus(exactValue));
      if (beforeValue.lt(ZERO)) {
        return { reversible: false, reason: "MOVEMENT_INVERSE_INVALID" };
      }
      const beforeRate = repairRate(beforeValue.dividedBy(previousQty));
      const stateBefore = rawHistoricalInventoryState(previousQty, beforeRate, beforeValue);
      if (statesEqual(applyHistoricalSalesRepairMovement(stateBefore, movement), stateAfter)) {
        return { reversible: true, stateBefore };
      }
      return (
        legacyExactReceiptRateOnlyRecovery(stateAfter, movement) ??
        canonicalRateOnlyRecovery(stateAfter, movement) ?? {
          reversible: false,
          reason: "MOVEMENT_INVERSE_INVALID",
        }
      );
    }

    if (input?.priorCostMemoryRate !== null && input?.priorCostMemoryRate !== undefined) {
      const priorRate = repairRate(
        Decimal.max(decimal(input.priorCostMemoryRate, "prior offload cost memory rate"), ZERO)
      );
      const stateBefore = rawHistoricalInventoryState(previousQty, priorRate, ZERO);
      return statesEqual(applyHistoricalSalesRepairMovement(stateBefore, movement), stateAfter)
        ? { reversible: true, stateBefore }
        : { reversible: false, reason: "MOVEMENT_INVERSE_INVALID" };
    }

    // V41: an exact-value offload into exactly empty stock fixes the after
    // state independently of the erased cost memory.
    if (
      previousQty.isZero() &&
      !statesEqualQuantityAndValue(
        applyHistoricalSalesRepairMovement(rawHistoricalInventoryState(ZERO, ZERO, ZERO), movement),
        stateAfter
      )
    ) {
      return { reversible: false, reason: "MOVEMENT_INVERSE_INVALID" };
    }
    return { reversible: false, reason: "COST_MEMORY_IRREVERSIBLE" };
  }

  if (
    EXACT_OFFLOAD_REMOVAL_SOURCE_TYPES.has(movement.sourceType) &&
    delta.lt(ZERO) &&
    movement.exactValue !== null &&
    movement.exactValue !== undefined
  ) {
    const previousQty = repairQuantity(stateAfter.quantity.plus(delta.abs()));
    if (!previousQty.gt(ZERO)) {
      return { reversible: false, reason: "COST_MEMORY_IRREVERSIBLE" };
    }
    const beforeValue = repairMoney(stateAfter.totalValue.plus(repairMoney(movement.exactValue)));
    const beforeRate = repairRate(beforeValue.dividedBy(previousQty));
    const stateBefore = rawHistoricalInventoryState(previousQty, beforeRate, beforeValue);
    if (statesEqual(applyHistoricalSalesRepairMovement(stateBefore, movement), stateAfter)) {
      return { reversible: true, stateBefore };
    }
    return (
      canonicalRateOnlyRecovery(stateAfter, movement) ?? {
        reversible: false,
        reason: "MOVEMENT_INVERSE_INVALID",
      }
    );
  }

  // V31: a POS edit is a reversal receipt followed by a re-issue, both executed
  // at the live stored rate (reverseOriginalSaleInventory / rebuildSaleItems,
  // before and after the 2026-09-11 hardening). The journal records the old
  // sale-line cost on both legs. V19 unpriced only the receipt leg, so the
  // re-issue still rewound at the old cost and the pair could not invert. When
  // the loader identifies the role from the idempotency key, invert both legs
  // with the production semantics; untagged rows keep the V18-V30 behaviour.
  const posJournalCostIgnored = posJournalCostIsNotInventoryRate(movement);
  const primary = reverseHistoricalInventoryMovement(stateAfter, {
    quantityDelta: movement.quantityDelta,
    // Positive POS reversal rows are locally ambiguous: production restored
    // quantity without passing the old line cost, while the canonical journal
    // still records that historical sale cost. Treating the row as unpriced
    // globally regressed previously proven checkpoint paths in V19. Preserve
    // the V18-priced inverse until an alternate unpriced branch is selected by
    // a full checkpoint proof rather than by one locally reversible movement.
    unitCost: posJournalCostIgnored ? null : movement.unitCost,
    priorCostMemoryRate: posJournalCostIgnored ? null : input?.priorCostMemoryRate,
  });

  if (
    primary.reversible &&
    movement.evidence === "canonical" &&
    !posJournalCostIgnored &&
    (movement.sourceType === "pos-sale" ||
      movement.sourceType === "canonical-sale-lifecycle-correction") &&
    delta.lt(ZERO) &&
    movement.unitCost !== null &&
    movement.unitCost !== undefined
  ) {
    const recordedRate = repairRate(
      Decimal.max(decimal(movement.unitCost, "canonical recorded sale issue rate"), ZERO)
    );
    const inferredRate = repairRate(primary.stateBefore.averageRate);
    if (!recordedRate.eq(inferredRate)) {
      const previousQty = repairQuantity(stateAfter.quantity.minus(delta));
      if (previousQty.gt(ZERO)) {
        const beforeValue = repairMoney(
          stateAfter.totalValue.plus(delta.abs().times(recordedRate))
        );
        const recordedStateBefore = rawHistoricalInventoryState(
          previousQty,
          recordedRate,
          beforeValue
        );
        const replayed = applyHistoricalInventoryMovement(recordedStateBefore, {
          quantityDelta: delta,
          unitCost: recordedRate,
        });
        if (
          statesEqualQuantityAndValue(replayed, stateAfter) &&
          historicalStateRateMatchesValue(recordedStateBefore)
        ) {
          return {
            reversible: true,
            stateBefore: recordedStateBefore,
            recovery: "CANONICAL_RECORDED_ISSUE_RATE",
          };
        }
      }
    }
  }

  if (primary.reversible || primary.reason !== "MOVEMENT_INVERSE_INVALID") {
    return primary;
  }

  return (
    legacyIssueRateOnlyRecovery(stateAfter, movement) ??
    canonicalRateOnlyRecovery(stateAfter, movement) ??
    primary
  );
}

export function historicalSaleProposalFromState(
  movement: HistoricalSalesRepairMovement,
  stateBefore: HistoricalInventoryState
): HistoricalSalesRepairProposal {
  if (!movement.sale) throw hscrEngineError("HSCR_SALE_PROPOSAL_REQUIRES_SALE_MOVEMENT");
  const saleQty = repairQuantity(movement.sale.quantity).abs();
  const proposedCostPrice = repairRate(stateBefore.averageRate);
  const proposedTotalCost = repairMoney(saleQty.times(proposedCostPrice));
  const proposedProfit = repairMoney(decimal(movement.sale.totalSales, "sale total").minus(proposedTotalCost));
  const originalCostPrice = repairRate(movement.sale.originalCostPrice);
  const originalTotalCost = repairMoney(movement.sale.originalTotalCost);
  const originalProfit = repairMoney(movement.sale.originalProfit);

  return {
    salesItemId: movement.sale.salesItemId,
    voucherId: movement.sale.voucherId,
    companyId: movement.companyId,
    locationId: movement.locationId,
    stockItemId: movement.stockItemId,
    occurredAt: movement.occurredAt,
    sourceType: movement.sourceType,
    sourceId: movement.sourceId,
    evidence: movement.evidence,
    originalCostPrice: originalCostPrice.toFixed(2),
    originalTotalCost: originalTotalCost.toFixed(2),
    originalProfit: originalProfit.toFixed(2),
    proposedCostPrice: proposedCostPrice.toFixed(2),
    proposedTotalCost: proposedTotalCost.toFixed(2),
    proposedProfit: proposedProfit.toFixed(2),
    changed:
      !originalCostPrice.eq(proposedCostPrice) ||
      !originalTotalCost.eq(proposedTotalCost) ||
      !originalProfit.eq(proposedProfit),
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
  // Match production adjustInventory(): receipt value uses the full
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

function compareMovements(a: HistoricalSalesRepairMovement, b: HistoricalSalesRepairMovement): number {
  const time = Date.parse(a.occurredAt) - Date.parse(b.occurredAt);
  if (time !== 0) return time;
  if (a.sequence !== b.sequence) return a.sequence - b.sequence;
  return a.movementId.localeCompare(b.movementId);
}

export function replayHistoricalSalesCosts(input: {
  openings: HistoricalSalesRepairOpening[];
  movements: HistoricalSalesRepairMovement[];
}): HistoricalSalesRepairReplayResult {
  const states = new Map<string, HistoricalInventoryState>();
  for (const opening of input.openings) {
    states.set(
      historicalInventoryKey(opening.companyId, opening.locationId, opening.stockItemId),
      createHistoricalInventoryState(opening.quantity, opening.averageRate)
    );
  }

  const proposals: HistoricalSalesRepairProposal[] = [];
  const movements = [...input.movements].sort(compareMovements);

  for (const movement of movements) {
    const key = historicalInventoryKey(movement.companyId, movement.locationId, movement.stockItemId);
    const current =
      states.get(key) ??
      createHistoricalInventoryState("0", movement.unitCost === null ? "0" : (movement.unitCost ?? "0"));

    if (movement.sale) {
      const saleQty = repairQuantity(movement.sale.quantity).abs();
      const proposedCostPrice = repairRate(current.averageRate);
      const proposedTotalCost = repairMoney(saleQty.times(proposedCostPrice));
      const proposedProfit = repairMoney(decimal(movement.sale.totalSales, "sale total").minus(proposedTotalCost));

      const originalCostPrice = repairRate(movement.sale.originalCostPrice);
      const originalTotalCost = repairMoney(movement.sale.originalTotalCost);
      const originalProfit = repairMoney(movement.sale.originalProfit);

      proposals.push({
        salesItemId: movement.sale.salesItemId,
        voucherId: movement.sale.voucherId,
        companyId: movement.companyId,
        locationId: movement.locationId,
        stockItemId: movement.stockItemId,
        occurredAt: movement.occurredAt,
        sourceType: movement.sourceType,
        sourceId: movement.sourceId,
        evidence: movement.evidence,
        originalCostPrice: originalCostPrice.toFixed(2),
        originalTotalCost: originalTotalCost.toFixed(2),
        originalProfit: originalProfit.toFixed(2),
        proposedCostPrice: proposedCostPrice.toFixed(2),
        proposedTotalCost: proposedTotalCost.toFixed(2),
        proposedProfit: proposedProfit.toFixed(2),
        changed:
          !originalCostPrice.eq(proposedCostPrice) ||
          !originalTotalCost.eq(proposedTotalCost) ||
          !originalProfit.eq(proposedProfit),
      });
    }

    states.set(
      key,
      applyHistoricalInventoryMovement(current, {
        quantityDelta: movement.quantityDelta,
        unitCost: movement.unitCost,
      })
    );
  }

  return { proposals, closingStates: states };
}

/**
 * True for a canonical original sale issue: its unit cost is the locked live
 * inventory rate at the moment of the sale, a persisted observation of the
 * stored average rate. Edit legs journal the old line cost and are excluded.
 */
export function isRecordedLiveRateObservation(movement: HistoricalSalesRepairMovement): boolean {
  return (
    movement.evidence === "canonical" &&
    (movement.sourceType === "pos-sale" ||
      movement.sourceType === "pos-import" ||
      movement.sourceType === "credit-sales-import") &&
    !posJournalCostIsNotInventoryRate(movement) &&
    decimal(movement.quantityDelta, "quantity delta").lt(0) &&
    movement.unitCost !== null &&
    movement.unitCost !== undefined
  );
}

export type HistoricalReanchorResult = {
  status: "proven" | "ambiguous" | "too-wide";
  candidateCount: number;
  survivorCount: number;
  distinctOutcomeCount: number;
  /** Reconstructed cost for each target sale reached by every survivor. */
  proposals: Map<number, HistoricalSalesRepairProposal>;
  /** Worst rewind amplification per target sale across all survivors. */
  sensitivity: Map<number, Decimal>;
  /** Movement where every survivor stopped at irreversible cost memory. */
  stoppedAt: string | null;
};

/**
 * Re-anchor a checkpoint rewind at a canonical original sale issue (V39/V41).
 *
 * At the anchor the locked live rate is journaled and the quantity is exact,
 * only the value is unknown: every 2dp value whose stored rate equals the
 * recorded rate is a candidate. Each candidate is rewound independently
 * through the earlier movements (newest first) and must survive every inverse
 * and agree with every earlier recorded live sale rate. The result is proven
 * only when at least one candidate survives and all survivors agree exactly on
 * every reconstructed target sale cost and on where the rewind stops, so the
 * unknown value cannot change any proposal.
 */
export function reanchorHistoricalRewindAtRecordedRate(input: {
  anchorQuantity: Decimal.Value;
  recordedRate: Decimal.Value;
  earlierMovementsDescending: HistoricalSalesRepairMovement[];
  targetSaleIds: Set<number>;
  priorCostMemoryRateHints?: Map<string, Decimal.Value>;
  maxCandidates?: number;
}): HistoricalReanchorResult {
  const quantity = repairQuantity(input.anchorQuantity);
  const recorded = repairRate(input.recordedRate);
  const maxCandidates = new Decimal(input.maxCandidates ?? 20000);
  const candidates: HistoricalInventoryState[] = [];
  if (!quantity.gt(0)) {
    candidates.push(createHistoricalInventoryStateFromSnapshot(quantity, recorded, "0"));
  } else {
    const lowCents = quantity.times(recorded.minus("0.006")).times(100).floor();
    const highCents = quantity.times(recorded.plus("0.006")).times(100).ceil();
    if (highCents.minus(lowCents).gt(maxCandidates)) {
      return {
        status: "too-wide",
        candidateCount: highCents.minus(lowCents).toNumber(),
        survivorCount: 0,
        distinctOutcomeCount: 0,
        proposals: new Map(),
        sensitivity: new Map(),
        stoppedAt: null,
      };
    }
    for (let cents = lowCents; cents.lte(highCents); cents = cents.plus(1)) {
      const candidate = { quantity, averageRate: recorded, totalValue: repairMoney(cents.dividedBy(100)) };
      if (historicalStateRateMatchesValue(candidate)) candidates.push(candidate);
    }
  }

  type Outcome = {
    proposals: Map<number, HistoricalSalesRepairProposal>;
    sensitivity: Map<number, Decimal>;
    stoppedAt: string | null;
  };
  const outcomes: Outcome[] = [];
  for (const start of candidates) {
    let state = start;
    let sensitivity = quantity.gt(0) ? new Decimal(1).dividedBy(quantity) : new Decimal(1);
    const outcome: Outcome = { proposals: new Map(), sensitivity: new Map(), stoppedAt: null };
    let survived = true;
    for (const movement of input.earlierMovementsDescending) {
      const reversed = reverseHistoricalSalesRepairMovement(state, movement, {
        priorCostMemoryRate: input.priorCostMemoryRateHints?.get(movement.movementId) ?? null,
      });
      if (!reversed.reversible) {
        if (reversed.reason === "COST_MEMORY_IRREVERSIBLE") outcome.stoppedAt = movement.movementId;
        else survived = false;
        break;
      }
      if (
        isRecordedLiveRateObservation(movement) &&
        !repairRate(movement.unitCost!).eq(repairRate(reversed.stateBefore.averageRate))
      ) {
        survived = false;
        break;
      }
      const afterQty = repairQuantity(state.quantity);
      const beforeQty = repairQuantity(reversed.stateBefore.quantity);
      if (decimal(movement.quantityDelta, "quantity delta").gt(0) && afterQty.gt(0) && beforeQty.gt(0)) {
        sensitivity = Decimal.min(sensitivity.times(afterQty).dividedBy(beforeQty), new Decimal("1e15"));
      }
      if (movement.sale && input.targetSaleIds.has(movement.sale.salesItemId)) {
        outcome.proposals.set(movement.sale.salesItemId, historicalSaleProposalFromState(movement, reversed.stateBefore));
        outcome.sensitivity.set(movement.sale.salesItemId, sensitivity);
      }
      state = reversed.stateBefore;
    }
    if (survived) outcomes.push(outcome);
  }

  const signature = (outcome: Outcome) =>
    `${outcome.stoppedAt ?? ""}|` +
    [...outcome.proposals.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([salesItemId, proposal]) => `${salesItemId}=${proposal.proposedCostPrice}`)
      .join(",");
  const distinct = new Set(outcomes.map(signature));
  const proven = outcomes.length > 0 && distinct.size === 1 && outcomes[0].proposals.size > 0;
  const sensitivity = new Map<number, Decimal>();
  if (proven) {
    for (const salesItemId of outcomes[0].proposals.keys()) {
      sensitivity.set(
        salesItemId,
        Decimal.max(...outcomes.map((outcome) => outcome.sensitivity.get(salesItemId) ?? new Decimal(0)))
      );
    }
  }
  return {
    status: proven ? "proven" : "ambiguous",
    candidateCount: candidates.length,
    survivorCount: outcomes.length,
    distinctOutcomeCount: distinct.size,
    proposals: proven ? outcomes[0].proposals : new Map(),
    sensitivity,
    stoppedAt: proven ? outcomes[0].stoppedAt : null,
  };
}
