import Decimal from "decimal.js";

export const HISTORICAL_SALES_COST_REPAIR_ALGORITHM_VERSION = "2026-09-30-v21-canonical-rate-only-inverse";

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
  sourceType: string;
  sourceId: string;
  evidence: "canonical" | "legacy";
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
  if (INITIAL_OFFLOAD_SOURCE_TYPES.has(movement.sourceType)) {
    return applyInitialOffloadMovement(state, movement);
  }
  if (EXACT_OFFLOAD_REMOVAL_SOURCE_TYPES.has(movement.sourceType)) {
    return applyExactOffloadRemoval(state, movement);
  }
  return applyHistoricalInventoryMovement(state, {
    quantityDelta: movement.quantityDelta,
    unitCost: movement.unitCost,
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
    movement.sourceType === "pos-sale" &&
    movement.unitCost !== null &&
    movement.unitCost !== undefined
  ) {
    // Canonical POS issue unit_cost is the locked pre-sale inventory average
    // recorded in the same transaction as the deduction. Unlike transfer
    // issue rates, it is authoritative evidence of the pre-movement cost memory.
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

  const replayed = applyHistoricalSalesRepairMovement(stateBefore, movement);
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

export type HistoricalInventoryReverseResult =
  | {
      reversible: true;
      stateBefore: HistoricalInventoryState;
      recovery?: "CANONICAL_RATE_ONLY";
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
  if (input.unitCost !== null && input.unitCost !== undefined) {
    const recordedRate = repairRate(Decimal.max(decimal(input.unitCost, "movement unit cost"), ZERO));
    const beforeValue = repairMoney(stateAfter.totalValue.plus(issueQty.times(recordedRate)));
    const stateBefore = createHistoricalInventoryStateFromSnapshot(previousQty, recordedRate, beforeValue);
    const replayed = applyHistoricalInventoryMovement(stateBefore, {
      quantityDelta: delta,
      unitCost: recordedRate,
    });
    if (statesEqual(replayed, stateAfter)) {
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
      return statesEqual(applyHistoricalSalesRepairMovement(stateBefore, movement), stateAfter)
        ? { reversible: true, stateBefore }
        : { reversible: false, reason: "MOVEMENT_INVERSE_INVALID" };
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
    return statesEqual(applyHistoricalSalesRepairMovement(stateBefore, movement), stateAfter)
      ? { reversible: true, stateBefore }
      : { reversible: false, reason: "MOVEMENT_INVERSE_INVALID" };
  }

  const primary = reverseHistoricalInventoryMovement(stateAfter, {
    quantityDelta: movement.quantityDelta,
    // Positive POS reversal rows are locally ambiguous: production restored
    // quantity without passing the old line cost, while the canonical journal
    // still records that historical sale cost. Treating the row as unpriced
    // globally regressed previously proven checkpoint paths in V19. Preserve
    // the V18-priced inverse until an alternate unpriced branch is selected by
    // a full checkpoint proof rather than by one locally reversible movement.
    unitCost: movement.unitCost,
    priorCostMemoryRate: input?.priorCostMemoryRate,
  });
  if (primary.reversible || primary.reason !== "MOVEMENT_INVERSE_INVALID") {
    return primary;
  }

  return canonicalRateOnlyRecovery(stateAfter, movement) ?? primary;
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
