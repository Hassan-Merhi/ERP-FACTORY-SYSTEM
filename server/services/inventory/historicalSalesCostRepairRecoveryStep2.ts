// Extracted from ./historicalSalesCostRepairRecovery.ts: a stage of historicalSalesCostRepairRecovery.
import Decimal from "decimal.js";
import {
  createHistoricalInventoryStateFromSnapshot,
  repairMoney,
  repairQuantity,
  repairRate,
  type HistoricalInventoryState,
  type HistoricalSalesRepairProposal,
} from "./historicalSalesCostRepairEngine";
import {
  historicalSaleProposalFromState,
  historicalIssueInverseCandidates,
  isRecordedLiveRateObservation,
} from "./historicalSalesCostRepairEngineReplay";
import { reverseHistoricalSalesRepairMovement } from "./historicalSalesCostRepairEngineReverse";
import { MONEY_TOLERANCE, QTY_TOLERANCE, legacyInverseNotUniqueBlock } from "./historicalSalesCostRepairTypes";
import { compareMovementMutationDescending } from "./historicalSalesCostRepairEvidence";
import {
  stateForZeroOpening,
  historicalInventoryStatesEqual,
  replayMergedSourceLocationForward,
} from "./historicalSalesCostRepairRecoveryHelpers";
import type { HistoricalSalesRepairMovement } from "./historicalSalesCostRepairEngine";
import type { HistoricalMergeRow, RepairCheck, ValuationCheckpoint } from "./historicalSalesCostRepairTypes";
import type { buildPriorCanonicalCostMemoryRateHints } from "./historicalSalesCostRepairEvidence";
import type { historicalSalesCostRepairRecoveryStep } from "./historicalSalesCostRepairRecoveryStep";

export function historicalSalesCostRepairRecoveryStep2({
  hrr1,
  priorCostMemoryRateHints,
  input,
  sourceItemId,
  allMovements,
  blockSourceKeys,
  checks,
}: {
  hrr1: Extract<ReturnType<typeof historicalSalesCostRepairRecoveryStep>, { done: false }>;
  priorCostMemoryRateHints: ReturnType<typeof buildPriorCanonicalCostMemoryRateHints>;
  input: {
    companyId: number;
    targetKeys: Set<string>;
    checkpoint: ValuationCheckpoint;
    checkpointStates: Map<string, HistoricalInventoryState>;
    historicalMerges: HistoricalMergeRow[];
    canonical: HistoricalSalesRepairMovement[];
    legacyMovements: HistoricalSalesRepairMovement[];
  };
  sourceItemId: number;
  allMovements: HistoricalSalesRepairMovement[];
  blockSourceKeys: (sourceItemId: number, code: string, detail: string) => void;
  checks: RepairCheck[];
}) {
  const {
    combinedAtMergeByLocation,
    keptPostMovements,
    relevantLocations,
    sourceOpeningQty,
    sourceOpeningValue,
    keptBeforeByLocation,
    merge,
    sourceOpeningRate,
    mergeAtMs,
    sourcePreMovements,
    sourceTargetLocations,
  } = hrr1;

  if (!hrr1.keptRewindFailure) {
    // V47: rewind the kept item as a set of exact branches (as the
    // checkpoint rewind does); recorded live rates prune, and the merge
    // split needs exactly one surviving state per location.
    const keptCandidates = new Map<number, HistoricalInventoryState[]>(
      [...combinedAtMergeByLocation.entries()].map(([locationId, state]) => [locationId, [state]])
    );
    for (const movement of keptPostMovements) {
      if (!relevantLocations.has(movement.locationId)) continue;
      const current = keptCandidates.get(movement.locationId);
      if (!current) continue;
      const next: HistoricalInventoryState[] = [];
      let lastReason = "";
      for (const stateAfter of current) {
        const befores: HistoricalInventoryState[] = [];
        const reversed = reverseHistoricalSalesRepairMovement(stateAfter, movement, {
          priorCostMemoryRate: priorCostMemoryRateHints.get(movement.movementId) ?? null,
        });
        if (reversed.reversible) befores.push(reversed.stateBefore);
        else lastReason = reversed.reason;
        if (movement.evidence === "canonical") befores.push(...historicalIssueInverseCandidates(stateAfter, movement));
        for (const before of befores) {
          if (
            isRecordedLiveRateObservation(movement) &&
            !repairRate(movement.unitCost!).eq(repairRate(before.averageRate))
          ) {
            continue;
          }
          if (!next.some((existing) => historicalInventoryStatesEqual(existing, before))) next.push(before);
        }
      }
      if (next.length === 0) {
        hrr1.keptRewindFailure = {
          locationId: movement.locationId,
          detail: lastReason
            ? `Cannot rewind kept item movement ${movement.movementId}: ${lastReason}`
            : `Canonical kept-item sale ${movement.movementId} disagrees with every exact checkpoint rewind branch`,
        };
        break;
      }
      if (next.length > 64) {
        hrr1.keptRewindFailure = {
          locationId: movement.locationId,
          detail: `Kept item rewind exceeded the branch limit at ${movement.movementId}`,
        };
        break;
      }
      keptCandidates.set(movement.locationId, next);
    }
    if (!hrr1.keptRewindFailure) {
      for (const [locationId, states] of keptCandidates) {
        if (states.length > 1 && sourceOpeningQty.isZero() && sourceOpeningValue.isZero()) {
          // A source with an exact zero opening has a forward-determined
          // contribution at the merge, so the combined state must equal the
          // kept item's pre-merge state plus that contribution.
          const keptBefore = keptBeforeByLocation.get(locationId) ?? stateForZeroOpening(merge.kept_opening_rate);
          const contribution = replayMergedSourceLocationForward({
            companyId: input.companyId,
            sourceItemId,
            locationId,
            opening: stateForZeroOpening(sourceOpeningRate),
            movements: allMovements,
            mergeAtMs: mergeAtMs,
          }).stateAtMerge;
          const expectedQty = repairQuantity(keptBefore.quantity.plus(contribution.quantity));
          const expectedValue = repairMoney(keptBefore.totalValue.plus(contribution.totalValue));
          const matching = states.filter(
            (state) => repairQuantity(state.quantity).eq(expectedQty) && repairMoney(state.totalValue).eq(expectedValue)
          );
          if (matching.length === 1) {
            keptCandidates.set(locationId, matching);
            combinedAtMergeByLocation.set(locationId, matching[0]);
            continue;
          }
        }
        if (states.length !== 1) {
          hrr1.keptRewindFailure = {
            locationId,
            detail: `Kept item rewind has ${states.length} exact states at the merge`,
          };
          break;
        }
        combinedAtMergeByLocation.set(locationId, states[0]);
      }
    }
  }

  if (hrr1.keptRewindFailure) {
    blockSourceKeys(sourceItemId, "MERGED_ITEM_KEPT_REWIND_FAILED", hrr1.keptRewindFailure.detail);
    return { done: true as const, value: undefined };
  }

  const sourceAtMergeByLocation = new Map<number, HistoricalInventoryState>();
  let subtractionFailure: { locationId: number; detail: string } | null = null;
  for (const locationId of relevantLocations) {
    const combined = combinedAtMergeByLocation.get(locationId)!;
    const keptBefore = keptBeforeByLocation.get(locationId) ?? stateForZeroOpening(merge.kept_opening_rate);
    const sourceQty = repairQuantity(combined.quantity.minus(keptBefore.quantity));
    const sourceValue = repairMoney(combined.totalValue.minus(keptBefore.totalValue));
    if (sourceValue.lt(MONEY_TOLERANCE.negated())) {
      subtractionFailure = {
        locationId,
        detail: `Merge subtraction produced negative source value ${sourceValue.toFixed(2)}`,
      };
      break;
    }
    const normalizedValue = sourceValue.abs().lte(MONEY_TOLERANCE) ? new Decimal(0) : sourceValue;
    const sourceRate = sourceQty.gt(0) ? repairRate(normalizedValue.dividedBy(sourceQty)) : sourceOpeningRate;
    const sourceState = createHistoricalInventoryStateFromSnapshot(sourceQty, sourceRate, normalizedValue);

    const combinedQty = repairQuantity(keptBefore.quantity.plus(sourceState.quantity));
    const combinedValue = repairMoney(keptBefore.totalValue.plus(sourceState.totalValue));
    const combinedRate = combinedQty.gt(0) ? repairRate(combinedValue.dividedBy(combinedQty)) : new Decimal(0);
    if (
      !combinedQty.eq(repairQuantity(combined.quantity)) ||
      !combinedValue.eq(repairMoney(combined.totalValue)) ||
      !combinedRate.eq(repairRate(combined.averageRate))
    ) {
      subtractionFailure = {
        locationId,
        detail: "Source/kept split does not replay the exact post-merge checkpoint-rewound state",
      };
      break;
    }
    sourceAtMergeByLocation.set(locationId, sourceState);
  }

  if (subtractionFailure) {
    blockSourceKeys(sourceItemId, "MERGED_ITEM_VALUE_SPLIT_FAILED", subtractionFailure.detail);
    return { done: true as const, value: undefined };
  }

  const tempProposals: HistoricalSalesRepairProposal[] = [];
  const openingByLocation = new Map<number, HistoricalInventoryState>();
  const unresolvedLocations: number[] = [];
  let sourceRewindFailure: { locationId: number; detail: string } | null = null;

  for (const locationId of relevantLocations) {
    const sourceAtMerge = sourceAtMergeByLocation.get(locationId)!;
    const movements = sourcePreMovements
      .filter((movement) => movement.locationId === locationId)
      .sort(compareMovementMutationDescending);

    if (sourceAtMerge.quantity.lte(0)) {
      unresolvedLocations.push(locationId);
      continue;
    }

    let stateAfter = sourceAtMerge;
    const locationProposals: HistoricalSalesRepairProposal[] = [];
    for (const movement of movements) {
      const reversed = reverseHistoricalSalesRepairMovement(stateAfter, movement, {
        priorCostMemoryRate: priorCostMemoryRateHints.get(movement.movementId) ?? null,
      });
      if (!reversed.reversible) {
        sourceRewindFailure = {
          locationId,
          detail: `Cannot rewind source movement ${movement.movementId}: ${reversed.reason}`,
        };
        break;
      }
      if (movement.sale) {
        locationProposals.push(historicalSaleProposalFromState(movement, reversed.stateBefore));
        const primaryBefore = reversed.stateBefore;
        const alternatives = historicalIssueInverseCandidates(stateAfter, movement).filter(
          (candidate) => !historicalInventoryStatesEqual(candidate, primaryBefore)
        );
        if (alternatives.length > 0) {
          checks.push(
            legacyInverseNotUniqueBlock(input.companyId, movement, primaryBefore, alternatives, "merged source rewind")
          );
        }
      }
      stateAfter = reversed.stateBefore;
    }
    if (sourceRewindFailure) break;
    openingByLocation.set(locationId, stateAfter);
    tempProposals.push(...locationProposals);
  }

  if (sourceRewindFailure) {
    blockSourceKeys(sourceItemId, "MERGED_ITEM_SOURCE_REWIND_FAILED", sourceRewindFailure.detail);
    return { done: true as const, value: undefined };
  }

  let recoveredOpeningQty = new Decimal(0);
  let recoveredOpeningValue = new Decimal(0);
  for (const opening of openingByLocation.values()) {
    recoveredOpeningQty = repairQuantity(recoveredOpeningQty.plus(opening.quantity));
    recoveredOpeningValue = repairMoney(recoveredOpeningValue.plus(opening.totalValue));
  }
  const remainingOpeningQty = repairQuantity(sourceOpeningQty.minus(recoveredOpeningQty));
  const remainingOpeningValue = repairMoney(sourceOpeningValue.minus(recoveredOpeningValue));

  if (remainingOpeningQty.lt(QTY_TOLERANCE.negated()) || remainingOpeningValue.lt(MONEY_TOLERANCE.negated())) {
    blockSourceKeys(
      sourceItemId,
      "MERGED_ITEM_OPENING_RECONCILIATION_FAILED",
      `Rewind exceeded source opening: remaining ${remainingOpeningQty.toFixed(3)} / ${remainingOpeningValue.toFixed(2)}`
    );
    return { done: true as const, value: undefined };
  }

  const unresolvedWithActivity = unresolvedLocations.filter(
    (locationId) =>
      sourcePreMovements.some((movement) => movement.locationId === locationId) ||
      sourceTargetLocations.includes(locationId)
  );

  return {
    done: false as const,
    sourceAtMergeByLocation,
    tempProposals,
    openingByLocation,
    remainingOpeningQty,
    remainingOpeningValue,
    unresolvedWithActivity,
  };
}
