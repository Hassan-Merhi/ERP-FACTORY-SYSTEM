/** Reverse replay of historical inventory movements and the rate-only recoveries the rewind relies on. */
import Decimal from "decimal.js";
import {
  EXACT_OFFLOAD_REMOVAL_SOURCE_TYPES,
  HistoricalInventoryState,
  HistoricalSalesRepairMovement,
  INITIAL_OFFLOAD_SOURCE_TYPES,
  ZERO,
  applyHistoricalInventoryMovement,
  applyHistoricalSalesRepairMovement,
  createHistoricalInventoryState,
  createHistoricalInventoryStateFromSnapshot,
  decimal,
  historicalStateRateMatchesValue,
  isExactValuationReset,
  movementSuppliesIncomingRate,
  posJournalCostIsNotInventoryRate,
  rawHistoricalInventoryState,
  repairMoney,
  repairQuantity,
  repairRate,
  valuationResetState,
  valuationResetStateMatches,
} from "./historicalSalesCostRepairEngine";

export function statesEqual(left: HistoricalInventoryState, right: HistoricalInventoryState): boolean {
  return (
    repairQuantity(left.quantity).eq(repairQuantity(right.quantity)) &&
    repairRate(left.averageRate).eq(repairRate(right.averageRate)) &&
    repairMoney(left.totalValue).eq(repairMoney(right.totalValue))
  );
}

function statesEqualQuantityAndValue(left: HistoricalInventoryState, right: HistoricalInventoryState): boolean {
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
      const beforeValue = repairMoney(stateAfter.totalValue.plus(delta.abs().times(candidateRate)));
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

  const exactIssueValue = repairMoney(delta.abs().times(decimal(movement.unitCost, "adjustment edit apply unit cost")));
  const beforeValue = repairMoney(stateAfter.totalValue.plus(exactIssueValue));
  const beforeRate = repairRate(
    beforeValue.gt(ZERO)
      ? beforeValue.dividedBy(previousQty)
      : Decimal.max(decimal(movement.unitCost, "adjustment edit apply fallback rate"), ZERO)
  );
  const stateBefore = rawHistoricalInventoryState(previousQty, beforeRate, beforeValue);

  const replayQty = repairQuantity(previousQty.plus(delta));
  const replayValue = replayQty.gt(ZERO) ? repairMoney(Decimal.max(beforeValue.minus(exactIssueValue), ZERO)) : ZERO;
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
        const priorRate = repairRate(Decimal.max(decimal(input.priorCostMemoryRate, "prior cost memory rate"), ZERO));
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
        if (!statesEqualQuantityAndValue(replayed, stateAfter))
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
  const directStateBefore = createHistoricalInventoryStateFromSnapshot(previousQty, directRate, directBeforeValue);
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
    (movement.sourceType === "pos-sale" || movement.sourceType === "canonical-sale-lifecycle-correction") &&
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
        const beforeValue = repairMoney(stateAfter.totalValue.plus(delta.abs().times(recordedRate)));
        const recordedStateBefore = rawHistoricalInventoryState(previousQty, recordedRate, beforeValue);
        const replayed = applyHistoricalInventoryMovement(recordedStateBefore, {
          quantityDelta: delta,
          unitCost: recordedRate,
        });
        if (statesEqualQuantityAndValue(replayed, stateAfter) && historicalStateRateMatchesValue(recordedStateBefore)) {
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
    legacyIssueRateOnlyRecovery(stateAfter, movement) ?? canonicalRateOnlyRecovery(stateAfter, movement) ?? primary
  );
}
