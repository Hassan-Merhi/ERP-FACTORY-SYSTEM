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
  decimal,
  historicalStateRateMatchesValue,
  isExactValuationReset,
  posJournalCostIsNotInventoryRate,
  rawHistoricalInventoryState,
  repairMoney,
  repairQuantity,
  repairRate,
  valuationResetState,
  valuationResetStateMatches,
} from "./historicalSalesCostRepairEngine";
import {
  legacyIssueRateOnlyRecovery,
  statesEqual,
  statesEqualQuantityAndValue,
  type HistoricalInventoryReverseResult,
} from "./historicalSalesCostRepairEngineReverseStatesEqual";
import { canonicalRateOnlyRecovery, legacyExactReceiptRateOnlyRecovery } from "./canonicalRateOnlyRecovery";
import { reverseHistoricalInventoryMovement } from "./reverseHistoricalInventoryMovement";
export { statesEqual } from "./historicalSalesCostRepairEngineReverseStatesEqual";
export type { HistoricalInventoryReverseResult } from "./historicalSalesCostRepairEngineReverseStatesEqual";
export { reverseHistoricalInventoryMovement } from "./reverseHistoricalInventoryMovement";

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
