/** Checkpoint rewind for the historical sales-cost repair dry run. */
import Decimal from "decimal.js";

import {
  repairMoney,
  repairQuantity,
  posJournalCostIsNotInventoryRate,
  isExactValuationReset,
  repairRate,
  type HistoricalInventoryState,
  type HistoricalSalesRepairMovement,
  type HistoricalSalesRepairProposal,
} from "./historicalSalesCostRepairEngine";
import {
  historicalSaleProposalFromState,
  isRecordedLiveRateObservation,
} from "./historicalSalesCostRepairEngineReplay";
import {
  CANONICAL_SALE_SOURCE_TYPES,
  LegacyInverseAmbiguity,
  ReanchorRequest,
  RepairCheck,
  RewindAlternate,
  RewindAmplification,
  d,
} from "./historicalSalesCostRepairTypes";
import { compareMovementMutationAscending } from "./historicalSalesCostRepairEvidence";
import { historicalSalesCostRepairRewindStep } from "./historicalSalesCostRepairRewindStep";
import { historicalSalesCostRepairRewindStep2 } from "./historicalSalesCostRepairRewindStep2";
import { historicalSalesCostRepairRewindStep3 } from "./historicalSalesCostRepairRewindStep3";

/** Rewinds the immutable checkpoint through every durable movement to price legacy sales, tracking alternate branches. */
export function rewindCheckpointToLegacySales({
  companyId,
  traceRewind,
  checks,
  proposalsBySaleId,
  unavailableKeys,
  checkpointTargetKeys,
  rewindStates,
  movementsInCheckpoint,
  priorCostMemoryRateHints,
  targetLegacySaleMovementsByKey,
  forwardReplayResolvedKeys,
  movementsAscending,
  forwardResetProvenSaleIds,
}: {
  companyId: number;
  traceRewind: (key: string, line: string) => void;
  checks: RepairCheck[];
  proposalsBySaleId: Map<number, HistoricalSalesRepairProposal>;
  unavailableKeys: Set<string>;
  checkpointTargetKeys: Set<string>;
  rewindStates: Map<string, HistoricalInventoryState>;
  movementsInCheckpoint: HistoricalSalesRepairMovement[];
  priorCostMemoryRateHints: Map<string, string>;
  targetLegacySaleMovementsByKey: Map<string, HistoricalSalesRepairMovement[]>;
  forwardReplayResolvedKeys: Set<string>;
  movementsAscending: HistoricalSalesRepairMovement[];
  forwardResetProvenSaleIds: Set<number>;
}): {
  reanchorRequests: ReanchorRequest[];
  rewindAlternates: Map<string, RewindAlternate[]>;
  finishedAlternates: Map<string, RewindAlternate[]>;
  primaryHistoryByKey: Map<string, Map<number, HistoricalSalesRepairProposal>>;
  branchOverflowKeys: Set<string>;
  legacyInverseAmbiguity: Map<string, LegacyInverseAmbiguity>;
  REWIND_AMPLIFICATION_LIMIT: Decimal;
  REANCHOR_MAX_CANDIDATES: Decimal;
  rewindAmplification: Map<string, RewindAmplification>;
} {
  const hrw1 = historicalSalesCostRepairRewindStep({ movementsAscending });
  const {
    nextMovementAtKey,
    UNRECORDED_REVALUATION_MIN_JUMP,
    rewindBoundaryReached,
    costMemoryResetByKey,
    reanchorRequests,
    rewindSensitivity,
    primaryHistoryByKey,
    rewindAmplification,
    REWIND_AMPLIFICATION_LIMIT,
    rewindAlternates,
    finishedAlternates,
    branchOverflowKeys,
    legacyInverseAmbiguity,
    REANCHOR_MAX_CANDIDATES,
  } = hrw1;

  const rewindMovement = (movement: HistoricalSalesRepairMovement): void => {
    const hrw2 = historicalSalesCostRepairRewindStep2({
      movement,
      checkpointTargetKeys,
      unavailableKeys,
      forwardReplayResolvedKeys,
      hrw1,
      rewindStates,
      priorCostMemoryRateHints,
      forwardResetProvenSaleIds,
      checks,
      companyId,
      proposalsBySaleId,
      traceRewind,
    });
    if (hrw2.done) return hrw2.value;
    const { stateAfter, key } = hrw2;
    const hrw3 = historicalSalesCostRepairRewindStep3({
      hrw2,
      priorCostMemoryRateHints,
      movement,
      checks,
      companyId,
      targetLegacySaleMovementsByKey,
      forwardResetProvenSaleIds,
      hrw1,
      proposalsBySaleId,
      movementsInCheckpoint,
    });
    if (hrw3.done) return hrw3.value;
    const { reversed } = hrw3;

    if (reversed.recovery === "LEGACY_RECEIPT_RATE_ONLY") {
      checks.push({
        companyId,
        locationId: movement.locationId,
        stockItemId: movement.stockItemId,
        code: "LEGACY_RECEIPT_RATE_ONLY_RECOVERED",
        status: "pass",
        expected: repairQuantity(stateAfter.quantity).toFixed(3) + "|" + repairMoney(stateAfter.totalValue).toFixed(2),
        actual: repairQuantity(stateAfter.quantity).toFixed(3) + "|" + repairMoney(stateAfter.totalValue).toFixed(2),
        detail:
          "Legacy offload boundary " +
          movement.movementId +
          " recovered from the exact stored offload total_value because replay reproduced quantity and total value exactly; only the reconstructed intermediate average-rate field disagreed. Prior rate=" +
          repairRate(reversed.stateBefore.averageRate).toFixed(2),
      });
    }

    // V33: only an original POS sale issue journals the locked live rate. An
    // edit re-issue journals the preserved old sale-line cost, so it is not
    // evidence about the inventory rate and must not be compared with it.
    if (
      movement.evidence === "canonical" &&
      CANONICAL_SALE_SOURCE_TYPES.has(movement.sourceType) &&
      !posJournalCostIsNotInventoryRate(movement) &&
      d(movement.quantityDelta).lt(0)
    ) {
      const recorded = repairRate(movement.unitCost ?? "0");
      const inferred = repairRate(reversed.stateBefore.averageRate);
      if (!recorded.eq(inferred)) {
        // V37 diagnostic: issues never move the average beyond rounding, so
        // when the very next movement at this key is another original sale
        // issue journaling a materially different locked live rate, the
        // inventory was revalued in between by a writer that left no
        // movement (cost-price import, direct location import). That
        // boundary cannot be crossed without evidence of the revaluation.
        // V47: outbound movements between two recorded live rates move the
        // stored rate by at most one cent of rounding each, so a larger gap
        // than 0.02 plus a cent per intervening issue cannot come from them.
        let nextMovement: HistoricalSalesRepairMovement | undefined = nextMovementAtKey(key, movement);
        let issuesBetween = 0;
        while (
          nextMovement &&
          !isRecordedLiveRateObservation(nextMovement) &&
          d(nextMovement.quantityDelta).lt(0) &&
          (nextMovement.exactValue === null || nextMovement.exactValue === undefined) &&
          !isExactValuationReset(nextMovement)
        ) {
          issuesBetween += 1;
          nextMovement = nextMovementAtKey(key, nextMovement);
        }
        let unrecordedRevaluation = false;
        if (
          nextMovement &&
          isRecordedLiveRateObservation(nextMovement) &&
          repairRate(nextMovement.unitCost!)
            .minus(recorded)
            .abs()
            .gt(UNRECORDED_REVALUATION_MIN_JUMP.plus(new Decimal(issuesBetween).times("0.01")))
        ) {
          checks.push({
            companyId,
            locationId: movement.locationId,
            stockItemId: movement.stockItemId,
            code: "UNRECORDED_REVALUATION_DETECTED",
            status: "warning",
            expected: recorded.toFixed(2),
            actual: repairRate(nextMovement.unitCost!).toFixed(2),
            detail: `Locked live rate moved from ${recorded.toFixed(2)} (${movement.movementId}, ${
              movement.createdAt ?? movement.occurredAt
            }) to ${repairRate(nextMovement.unitCost!).toFixed(2)} (${nextMovement.movementId}, ${
              nextMovement.createdAt ?? nextMovement.occurredAt
            }) with ${issuesBetween ? issuesBetween + " outbound movement(s)" : "no stock movement"} between them`,
          });
          unrecordedRevaluation = true;
        }
        const unresolvedSales = (targetLegacySaleMovementsByKey.get(key) ?? []).filter(
          (saleMovement) =>
            compareMovementMutationAscending(saleMovement, movement) < 0 &&
            !forwardResetProvenSaleIds.has(saleMovement.sale!.salesItemId)
        );
        rewindBoundaryReached.add(key);
        const costMemoryReset = costMemoryResetByKey.get(key);
        if ((unrecordedRevaluation || costMemoryReset) && unresolvedSales.length > 0) {
          // V39: try to re-anchor below the revaluation instead of blocking
          // outright; the blocks are emitted after the attempt if it fails.
          // V41: the same proof applies below a cost-memory reset, where the
          // disagreement is the rewind's guess of an erased rate, not a
          // contradiction between independent evidence.
          reanchorRequests.push({
            key: key,
            anchor: movement,
            beforeQuantity: repairQuantity(reversed.stateBefore.quantity),
            recorded,
            inferred,
            unresolvedSales,
            transition: unrecordedRevaluation ? "UNRECORDED_REVALUATION" : "COST_MEMORY_RESET",
            transitionMovementId: unrecordedRevaluation
              ? (nextMovement?.movementId ?? movement.movementId)
              : costMemoryReset!.movementId,
          });
          checks.push({
            companyId,
            locationId: movement.locationId,
            stockItemId: movement.stockItemId,
            code: "VALUATION_ERA_BOUNDARY",
            status: "warning",
            expected: recorded.toFixed(2),
            actual: inferred.toFixed(2),
            detail: `transition=${unrecordedRevaluation ? "UNRECORDED_REVALUATION" : "COST_MEMORY_RESET"} at ${
              unrecordedRevaluation ? (nextMovement?.movementId ?? movement.movementId) : costMemoryReset!.movementId
            }; anchor=${movement.movementId} recorded live rate ${recorded.toFixed(2)}, checkpoint rewind inferred ${inferred.toFixed(2)}`,
          });
        } else if (unresolvedSales.length === 0) {
          checks.push({
            companyId,
            locationId: movement.locationId,
            stockItemId: movement.stockItemId,
            code: "CANONICAL_SALE_COST_EVIDENCE_MISMATCH",
            status: "warning",
            expected: recorded.toFixed(2),
            actual: inferred.toFixed(2),
            detail: `Canonical movement ${movement.movementId} disagrees with checkpoint rewind after all target legacy sales were already reconstructed`,
          });
        } else {
          for (const saleMovement of unresolvedSales) {
            checks.push({
              companyId,
              locationId: saleMovement.locationId,
              stockItemId: saleMovement.stockItemId,
              salesItemId: saleMovement.sale!.salesItemId,
              code: "CANONICAL_SALE_COST_EVIDENCE_MISMATCH",
              status: "block",
              expected: recorded.toFixed(2),
              actual: inferred.toFixed(2),
              detail: `Sales item ${saleMovement.sale!.salesItemId} predates canonical cost boundary ${movement.movementId}`,
            });
          }
        }
        return;
      }
    }

    const afterQty = repairQuantity(stateAfter.quantity);
    const beforeQty = repairQuantity(reversed.stateBefore.quantity);
    let sensitivity =
      rewindSensitivity.get(key) ?? (afterQty.gt(0) ? new Decimal(1).dividedBy(afterQty) : new Decimal(1));
    if (d(movement.quantityDelta).gt(0) && afterQty.gt(0) && beforeQty.gt(0)) {
      sensitivity = Decimal.min(sensitivity.times(afterQty).dividedBy(beforeQty), new Decimal("1e15"));
    }
    rewindSensitivity.set(key, sensitivity);

    if (movement.sale && !forwardResetProvenSaleIds.has(movement.sale.salesItemId)) {
      const primaryProposal = historicalSaleProposalFromState(movement, reversed.stateBefore);
      proposalsBySaleId.set(movement.sale.salesItemId, primaryProposal);
      const primaryHistory = primaryHistoryByKey.get(key) ?? new Map<number, HistoricalSalesRepairProposal>();
      primaryHistory.set(movement.sale.salesItemId, primaryProposal);
      primaryHistoryByKey.set(key, primaryHistory);
      const amplification = rewindAmplification.get(key) ?? {
        max: new Decimal(0),
        maxSalesItemId: movement.sale.salesItemId,
        proposals: 0,
        over10: 0,
        over100: 0,
      };
      amplification.proposals += 1;
      if (sensitivity.gt(REWIND_AMPLIFICATION_LIMIT)) {
        // V35: a reconstruction this ill-conditioned is not proven even when
        // every local inverse replays exactly: one cent of model drift near
        // the checkpoint moves this sale's cost by more than a dollar.
        checks.push({
          companyId,
          locationId: movement.locationId,
          stockItemId: movement.stockItemId,
          salesItemId: movement.sale.salesItemId,
          code: "LEGACY_REWIND_ERROR_AMPLIFICATION_EXCEEDED",
          status: "block",
          expected: `<=${REWIND_AMPLIFICATION_LIMIT.toFixed(0)}`,
          actual: sensitivity.toFixed(2),
          detail: `Sales item ${movement.sale.salesItemId} rewound cost moves ${sensitivity.toFixed(
            2
          )} cents per cent of checkpoint-side model error`,
        });
      }
      if (sensitivity.gt(10)) amplification.over10 += 1;
      if (sensitivity.gt(100)) amplification.over100 += 1;
      if (sensitivity.gt(amplification.max)) {
        amplification.max = sensitivity;
        amplification.maxSalesItemId = movement.sale.salesItemId;
      }
      rewindAmplification.set(key, amplification);
    }
    if (
      isExactValuationReset(movement) ||
      (d(movement.quantityDelta).gt(0) &&
        movement.unitCost !== null &&
        movement.unitCost !== undefined &&
        !posJournalCostIsNotInventoryRate(movement) &&
        repairQuantity(reversed.stateBefore.quantity).lte(0))
    ) {
      costMemoryResetByKey.set(key, movement);
    }
    rewindStates.set(key, reversed.stateBefore);
  };
  for (const movement of movementsInCheckpoint) rewindMovement(movement);
  return {
    reanchorRequests: reanchorRequests,
    rewindAlternates: rewindAlternates,
    finishedAlternates: finishedAlternates,
    primaryHistoryByKey: primaryHistoryByKey,
    branchOverflowKeys: branchOverflowKeys,
    legacyInverseAmbiguity: legacyInverseAmbiguity,
    REWIND_AMPLIFICATION_LIMIT: REWIND_AMPLIFICATION_LIMIT,
    REANCHOR_MAX_CANDIDATES: REANCHOR_MAX_CANDIDATES,
    rewindAmplification: rewindAmplification,
  };
}
