// Extracted from ./historicalSalesCostRepairEngineReverse.ts to keep that module under the source-size cap.
import Decimal from "decimal.js";
import {
  applyHistoricalInventoryMovement,
  decimal,
  HistoricalInventoryState,
  HistoricalSalesRepairMovement,
  rawHistoricalInventoryState,
  repairMoney,
  repairQuantity,
  repairRate,
  ZERO,
} from "./historicalSalesCostRepairEngine";

export function statesEqual(left: HistoricalInventoryState, right: HistoricalInventoryState): boolean {
  return (
    repairQuantity(left.quantity).eq(repairQuantity(right.quantity)) &&
    repairRate(left.averageRate).eq(repairRate(right.averageRate)) &&
    repairMoney(left.totalValue).eq(repairMoney(right.totalValue))
  );
}

export function statesEqualQuantityAndValue(left: HistoricalInventoryState, right: HistoricalInventoryState): boolean {
  return (
    repairQuantity(left.quantity).eq(repairQuantity(right.quantity)) &&
    repairMoney(left.totalValue).eq(repairMoney(right.totalValue))
  );
}

export function stateRateDisagreesWithValue(state: HistoricalInventoryState): boolean {
  const quantity = repairQuantity(state.quantity);
  if (!quantity.gt(ZERO)) return false;
  return !repairRate(state.totalValue.dividedBy(quantity)).eq(repairRate(state.averageRate));
}

export function candidateRatesAround(rate: Decimal): Decimal[] {
  const center = repairRate(Decimal.max(rate, ZERO));
  const values: Decimal[] = [];
  for (let cents = -10; cents <= 10; cents += 1) {
    const candidate = center.plus(new Decimal(cents).dividedBy(100));
    if (candidate.gte(ZERO)) values.push(repairRate(candidate));
  }
  return values;
}

export function derivedRateCandidateCenter(state: HistoricalInventoryState): Decimal | null {
  const quantity = repairQuantity(state.quantity);
  if (!quantity.gt(ZERO)) return null;
  return repairRate(Decimal.max(state.totalValue.dividedBy(quantity), ZERO));
}

export function legacyIssueRateOnlyRecovery(
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

export function canonicalAdjustmentEditApplyValueInverse(
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
