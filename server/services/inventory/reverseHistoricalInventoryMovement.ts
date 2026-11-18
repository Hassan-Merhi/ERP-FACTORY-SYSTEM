// Extracted from ./historicalSalesCostRepairEngineReverse.ts to keep that module under the source-size cap.
import Decimal from "decimal.js";
import {
  applyHistoricalInventoryMovement,
  createHistoricalInventoryState,
  createHistoricalInventoryStateFromSnapshot,
  decimal,
  HistoricalInventoryState,
  historicalStateRateMatchesValue,
  repairMoney,
  repairQuantity,
  repairRate,
  ZERO,
} from "./historicalSalesCostRepairEngine";
import {
  candidateRatesAround,
  statesEqual,
  statesEqualQuantityAndValue,
  type HistoricalInventoryReverseResult,
} from "./historicalSalesCostRepairEngineReverseStatesEqual";

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
