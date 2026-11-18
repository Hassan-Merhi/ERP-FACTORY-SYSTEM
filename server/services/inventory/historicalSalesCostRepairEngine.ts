import Decimal from "decimal.js";
import {
  EXACT_OFFLOAD_REMOVAL_SOURCE_TYPES,
  INITIAL_OFFLOAD_SOURCE_TYPES,
  INVENTORY_SAFETY_CLAMP_AT,
  NEGATIVE_LAYER_ENGINE_AT,
  OFFLOAD_NEGATIVE_CROSSING_RESET_AT,
  OFFLOAD_POSITIVE_VALUE_CLAMP_AT,
  STALE_LAYER_SETTLEMENT_FIX_AT,
  ZERO,
  addNegativeLayerQuantity,
  decimal,
  exactOffloadRate,
  historicalIncomingRate,
  isExactValuationReset,
  movementSuppliesIncomingRate,
  movementTimeMs,
  posJournalCostIsNotInventoryRate,
  rawHistoricalInventoryState,
  rawUnclampedHistoricalInventoryState,
  repairMoney,
  repairQuantity,
  repairRate,
  valuationResetState,
  valuationResetStateMatches,
  type HistoricalForwardReplayState,
  type HistoricalInventoryState,
  type HistoricalSalesRepairMovement,
} from "./historicalRateWithinEvidencedRange";
export {
  EXACT_OFFLOAD_REMOVAL_SOURCE_TYPES,
  HISTORICAL_SALES_COST_REPAIR_ALGORITHM_VERSION,
  INITIAL_OFFLOAD_SOURCE_TYPES,
  ZERO,
  canonicalPosRoleFromIdempotencyKey,
  createHistoricalInventoryState,
  createHistoricalInventoryStateFromSnapshot,
  createHistoricalSignedLocationImportState,
  decimal,
  historicalInventoryKey,
  historicalRateWithinEvidencedRange,
  historicalStateRateMatchesValue,
  hscrEngineError,
  isExactValuationReset,
  movementSuppliesIncomingRate,
  posJournalCostIsNotInventoryRate,
  rawHistoricalInventoryState,
  repairMoney,
  repairQuantity,
  repairRate,
  valuationResetState,
  valuationResetStateMatches,
} from "./historicalRateWithinEvidencedRange";
export type {
  CanonicalPosRole,
  HistoricalForwardReplayState,
  HistoricalInventoryState,
  HistoricalSalesRepairMovement,
  HistoricalSalesRepairOpening,
  HistoricalSalesRepairProposal,
  HistoricalSalesRepairReplayResult,
} from "./historicalRateWithinEvidencedRange";

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
