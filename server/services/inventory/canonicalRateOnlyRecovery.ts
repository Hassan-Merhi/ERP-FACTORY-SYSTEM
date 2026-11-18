// Extracted from ./historicalSalesCostRepairEngineReverse.ts to keep that module under the source-size cap.
import Decimal from "decimal.js";
import {
  applyHistoricalInventoryMovement,
  applyHistoricalSalesRepairMovement,
  decimal,
  EXACT_OFFLOAD_REMOVAL_SOURCE_TYPES,
  HistoricalInventoryState,
  HistoricalSalesRepairMovement,
  INITIAL_OFFLOAD_SOURCE_TYPES,
  movementSuppliesIncomingRate,
  posJournalCostIsNotInventoryRate,
  rawHistoricalInventoryState,
  repairMoney,
  repairQuantity,
  repairRate,
  ZERO,
} from "./historicalSalesCostRepairEngine";
import {
  candidateRatesAround,
  canonicalAdjustmentEditApplyValueInverse,
  derivedRateCandidateCenter,
  stateRateDisagreesWithValue,
  statesEqualQuantityAndValue,
  type HistoricalInventoryReverseResult,
} from "./historicalSalesCostRepairEngineReverseStatesEqual";

export function canonicalRateOnlyRecovery(
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

  let stateBefore: HistoricalInventoryState | null;

  const adjustmentEditRecovery = canonicalAdjustmentEditApplyValueInverse(stateAfter, movement);
  if (adjustmentEditRecovery) return adjustmentEditRecovery;

  if (
    INITIAL_OFFLOAD_SOURCE_TYPES.has(movement.sourceType) &&
    delta.gt(ZERO) &&
    movement.exactValue !== null &&
    movement.exactValue !== undefined
  ) {
    const beforeValue = repairMoney(stateAfter.totalValue.minus(repairMoney(movement.exactValue)));
    if (beforeValue.lt(ZERO)) return null;
    stateBefore = rawHistoricalInventoryState(previousQty, repairRate(beforeValue.dividedBy(previousQty)), beforeValue);
  } else if (
    EXACT_OFFLOAD_REMOVAL_SOURCE_TYPES.has(movement.sourceType) &&
    delta.lt(ZERO) &&
    movement.exactValue !== null &&
    movement.exactValue !== undefined
  ) {
    const beforeValue = repairMoney(stateAfter.totalValue.plus(repairMoney(movement.exactValue)));
    stateBefore = rawHistoricalInventoryState(previousQty, repairRate(beforeValue.dividedBy(previousQty)), beforeValue);
  } else if (delta.gt(ZERO) && movement.sourceType === "pos-sale") {
    // Historical POS edit/delete reversals restored quantity without passing
    // the old sale-line cost to the adjustInventory helper. V19 proved that replacing
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
        const beforeValue = repairMoney(stateAfter.totalValue.minus(delta.times(candidateRate)));
        if (beforeValue.lt(ZERO)) continue;
        const candidate = rawHistoricalInventoryState(previousQty, candidateRate, beforeValue);
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
  } else if (delta.gt(ZERO) && movement.sourceType !== "pos-sale" && movementSuppliesIncomingRate(movement)) {
    const incomingRate = Decimal.max(decimal(movement.unitCost, "canonical incoming movement cost"), ZERO);
    const beforeValue = repairMoney(stateAfter.totalValue.minus(delta.times(incomingRate)));
    if (beforeValue.lt(ZERO)) return null;
    stateBefore = rawHistoricalInventoryState(previousQty, repairRate(beforeValue.dividedBy(previousQty)), beforeValue);
  } else if (
    delta.lt(ZERO) &&
    (movement.sourceType === "stock-transfer" ||
      (movement.sourceType === "pos-sale" &&
        (movement.canonicalPosRole === "edit-issue" || movement.canonicalPosRole === "dropped-line")))
  ) {
    // A POS edit re-issue also consumed the live stored rate while journaling
    // the preserved old line cost, so it uses the same unique source-rate search.
    // The transfer document rate is recorded in the canonical journal, but the
    // source-side deduction in the adjustInventory helper consumes stock at the source
    // inventory average rate. When the reconstructed intermediate rate is stale,
    // recover only a UNIQUE self-consistent source-rate candidate whose issue
    // replay preserves quantity and total value exactly.
    const evaluateCandidates = (center: Decimal): HistoricalInventoryState[] => {
      const candidates: HistoricalInventoryState[] = [];
      for (const candidateRate of candidateRatesAround(center)) {
        const beforeValue = repairMoney(stateAfter.totalValue.plus(delta.abs().times(candidateRate)));
        const candidate = rawHistoricalInventoryState(previousQty, candidateRate, beforeValue);
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
    (movement.sourceType === "pos-sale" || movement.sourceType === "canonical-sale-lifecycle-correction") &&
    movement.unitCost !== null &&
    movement.unitCost !== undefined
  ) {
    // Canonical POS issue unit_cost is the locked pre-sale inventory average
    // recorded in the same transaction as the deduction. A negative lifecycle
    // correction is synthesized from latestNegativeRate, the quantity-weighted
    // canonical issue rate pinned to that sale's latest mutation. Both are
    // direct canonical evidence of the cost basis used for the missing issue.
    const recordedRate = repairRate(Decimal.max(decimal(movement.unitCost, "canonical POS issue cost"), ZERO));
    const beforeValue = repairMoney(stateAfter.totalValue.plus(delta.abs().times(recordedRate)));
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

export function legacyExactReceiptRateOnlyRecovery(
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

  const beforeValue = repairMoney(stateAfter.totalValue.minus(repairMoney(movement.exactValue)));
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
