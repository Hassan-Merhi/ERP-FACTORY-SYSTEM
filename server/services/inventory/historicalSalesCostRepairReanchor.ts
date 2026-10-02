/** Forward cost-memory reset proofs and rewind branch/re-anchor resolution for the historical sales-cost repair dry run. */
import Decimal from "decimal.js";

import {
  applyHistoricalSalesRepairMovement,
  createHistoricalInventoryStateFromSnapshot,
  repairMoney,
  repairQuantity,
  posJournalCostIsNotInventoryRate,
  repairRate,
  type HistoricalInventoryState,
  type HistoricalSalesRepairMovement,
  type HistoricalSalesRepairProposal,
} from "./historicalSalesCostRepairEngine";
import {
  historicalSaleProposalFromState,
  reanchorHistoricalRewindAtRecordedRate,
} from "./historicalSalesCostRepairEngineReplay";
import {
  LegacyInverseAmbiguity,
  ReanchorRequest,
  RepairCheck,
  RewindAlternate,
  reanchorCodePrefix,
} from "./historicalSalesCostRepairTypes";
import { compareMovementMutationAscending, movementKey } from "./historicalSalesCostRepairEvidence";
import { historicalInventoryStatesEqual } from "./historicalSalesCostRepairRecovery";

/** Proves legacy sales after a priced receipt into empty or negative stock by replaying forward to the checkpoint. */
export function proveForwardCostMemoryResets({
  companyId,
  checks,
  proposalsBySaleId,
  checkpointStates,
  unavailableKeys,
  checkpointTargetKeys,
  forwardReplayResolvedKeys,
  movementsAscending,
}: {
  companyId: number;
  checks: RepairCheck[];
  proposalsBySaleId: Map<number, HistoricalSalesRepairProposal>;
  checkpointStates: Map<string, HistoricalInventoryState>;
  unavailableKeys: Set<string>;
  checkpointTargetKeys: Set<string>;
  forwardReplayResolvedKeys: Set<string>;
  movementsAscending: HistoricalSalesRepairMovement[];
}): { forwardResetProvenSaleIds: Set<number>; movementsByTargetKey: Map<string, HistoricalSalesRepairMovement[]> } {
  // A priced receipt that crosses an item/location from zero or negative
  // quantity to positive quantity resets cost memory: the post-receipt
  // valuation is determined entirely by the receipt rate and the positive
  // remainder. Derive quantities backwards from the immutable checkpoint,
  // then replay forward from each reset candidate. Accept the earliest
  // candidate that reproduces the checkpoint exactly, which proves every
  // target legacy sale after that reset without needing older cost memory.
  const forwardResetProvenSaleIds = new Set<number>();
  const movementsByTargetKey = new Map<string, HistoricalSalesRepairMovement[]>();
  for (const movement of movementsAscending) {
    const key = movementKey(movement);
    if (!checkpointTargetKeys.has(key) || unavailableKeys.has(key)) continue;
    const rows = movementsByTargetKey.get(key) ?? [];
    rows.push(movement);
    movementsByTargetKey.set(key, rows);
  }

  for (const key of checkpointTargetKeys) {
    if (unavailableKeys.has(key) || forwardReplayResolvedKeys.has(key)) continue;
    const checkpointState = checkpointStates.get(key);
    if (!checkpointState) continue;
    const movements = movementsByTargetKey.get(key) ?? [];
    if (movements.length === 0) continue;

    const quantityBefore = new Array<Decimal>(movements.length);
    let quantityAfter = repairQuantity(checkpointState.quantity);
    for (let index = movements.length - 1; index >= 0; index -= 1) {
      const delta = repairQuantity(movements[index].quantityDelta);
      const before = repairQuantity(quantityAfter.minus(delta));
      quantityBefore[index] = before;
      quantityAfter = before;
    }

    let accepted:
      | {
          anchor: HistoricalSalesRepairMovement;
          stateAtCheckpoint: HistoricalInventoryState;
          proposals: HistoricalSalesRepairProposal[];
        }
      | undefined;

    for (let anchorIndex = 0; anchorIndex < movements.length; anchorIndex += 1) {
      const anchor = movements[anchorIndex];
      const delta = repairQuantity(anchor.quantityDelta);
      const beforeQty = quantityBefore[anchorIndex];
      const afterQty = repairQuantity(beforeQty.plus(delta));
      if (
        !delta.gt(0) ||
        anchor.unitCost === null ||
        anchor.unitCost === undefined ||
        posJournalCostIsNotInventoryRate(anchor) ||
        beforeQty.gt(0) ||
        !afterQty.gt(0)
      ) {
        continue;
      }

      let state = applyHistoricalSalesRepairMovement(
        createHistoricalInventoryStateFromSnapshot(beforeQty, "0", "0"),
        anchor
      );
      const candidateProposals: HistoricalSalesRepairProposal[] = [];
      for (let index = anchorIndex + 1; index < movements.length; index += 1) {
        const movement = movements[index];
        if (movement.sale) {
          candidateProposals.push(historicalSaleProposalFromState(movement, state));
        }
        state = applyHistoricalSalesRepairMovement(state, movement);
      }

      if (!historicalInventoryStatesEqual(state, checkpointState)) continue;
      if (candidateProposals.length === 0) continue;

      accepted = {
        anchor,
        stateAtCheckpoint: state,
        proposals: candidateProposals,
      };
      break;
    }

    if (!accepted) continue;

    let provenCount = 0;
    for (const proposal of accepted.proposals) {
      proposalsBySaleId.set(proposal.salesItemId, proposal);
      forwardResetProvenSaleIds.add(proposal.salesItemId);
      provenCount += 1;
    }
    const [, locationIdText, stockItemIdText] = key.split(":");
    checks.push({
      companyId,
      locationId: Number(locationIdText),
      stockItemId: Number(stockItemIdText),
      code: "FORWARD_RESET_SEGMENT_PROVEN",
      status: "pass",
      expected: `${repairQuantity(checkpointState.quantity).toFixed(3)}|${repairMoney(
        checkpointState.totalValue
      ).toFixed(2)}|${repairRate(checkpointState.averageRate).toFixed(2)}`,
      actual: `${repairQuantity(accepted.stateAtCheckpoint.quantity).toFixed(3)}|${repairMoney(
        accepted.stateAtCheckpoint.totalValue
      ).toFixed(2)}|${repairRate(accepted.stateAtCheckpoint.averageRate).toFixed(2)}`,
      detail: `Reset anchor ${accepted.anchor.movementId} proves ${provenCount} later legacy sale(s) by exact checkpoint replay`,
    });
  }
  return { forwardResetProvenSaleIds, movementsByTargetKey };
}

/** Settles rewind branches and re-anchors keys below unrecorded revaluations or cost-memory resets. */
export function resolveRewindBranchesAndReanchor({
  companyId,
  checks,
  proposalsBySaleId,
  movementsInCheckpoint,
  priorCostMemoryRateHints,
  forwardResetProvenSaleIds,
  reanchorRequests,
  rewindAlternates,
  finishedAlternates,
  primaryHistoryByKey,
  branchOverflowKeys,
  legacyInverseAmbiguity,
  REWIND_AMPLIFICATION_LIMIT,
  REANCHOR_MAX_CANDIDATES,
}: {
  companyId: number;
  checks: RepairCheck[];
  proposalsBySaleId: Map<number, HistoricalSalesRepairProposal>;
  movementsInCheckpoint: HistoricalSalesRepairMovement[];
  priorCostMemoryRateHints: Map<string, string>;
  forwardResetProvenSaleIds: Set<number>;
  reanchorRequests: ReanchorRequest[];
  rewindAlternates: Map<string, RewindAlternate[]>;
  finishedAlternates: Map<string, RewindAlternate[]>;
  primaryHistoryByKey: Map<string, Map<number, HistoricalSalesRepairProposal>>;
  branchOverflowKeys: Set<string>;
  legacyInverseAmbiguity: Map<string, LegacyInverseAmbiguity>;
  REWIND_AMPLIFICATION_LIMIT: Decimal;
  REANCHOR_MAX_CANDIDATES: Decimal;
}): void {
  for (const [key, entry] of legacyInverseAmbiguity) {
    const [, locationIdText, stockItemIdText] = key.split(":");
    checks.push({
      companyId,
      locationId: Number(locationIdText),
      stockItemId: Number(stockItemIdText),
      code: "LEGACY_SALE_INVERSE_AMBIGUITY_SUMMARY",
      status: "warning",
      expected: String(entry.sales),
      actual: entry.maxSpread.toFixed(2),
      detail: `${entry.sales} legacy sale inverse(s) admit another exact pre-issue rate (largest gap ${entry.maxSpread.toFixed(2)}); blocked as LEGACY_SALE_INVERSE_NOT_UNIQUE`,
    });
  }

  // V45: a legacy sale rewound on the primary path is priced only when every
  // surviving branch reached the same cost for it.
  for (const [key, primaryHistory] of primaryHistoryByKey) {
    const alternates = [...(rewindAlternates.get(key) ?? []), ...(finishedAlternates.get(key) ?? [])];
    const overflow = branchOverflowKeys.has(key);
    if (alternates.length === 0 && !overflow) continue;
    const [, locationIdText, stockItemIdText] = key.split(":");
    let blocked = 0;
    for (const [salesItemId, proposal] of primaryHistory) {
      if (forwardResetProvenSaleIds.has(salesItemId)) continue;
      const disagreeing = alternates.find(
        (alternate) => alternate.history.get(salesItemId)?.proposedCostPrice !== proposal.proposedCostPrice
      );
      if (!overflow && !disagreeing) continue;
      blocked += 1;
      checks.push({
        companyId,
        locationId: Number(locationIdText),
        stockItemId: Number(stockItemIdText),
        salesItemId,
        code: "CHECKPOINT_REWIND_COST_NOT_UNIQUE",
        status: "block",
        expected: proposal.proposedCostPrice,
        actual: overflow ? "branch limit" : (disagreeing!.history.get(salesItemId)?.proposedCostPrice ?? "unreached"),
        detail: `Sales item ${salesItemId} has a different cost on another exact rewind branch`,
      });
    }
    checks.push({
      companyId,
      locationId: Number(locationIdText),
      stockItemId: Number(stockItemIdText),
      code: "REWIND_BRANCH_CONSENSUS",
      status: "warning",
      expected: String(primaryHistory.size),
      actual: String(primaryHistory.size - blocked),
      detail: `${alternates.length} surviving alternate branch(es)${overflow ? " (branch limit exceeded)" : ""}; ${blocked} of ${primaryHistory.size} rewound legacy sale(s) not unique`,
    });
  }

  // V39: re-anchor below an unrecorded revaluation. At the pre-revaluation
  // original sale the locked live rate (journaled) and the quantity (the
  // quantity chain is unaffected by a valuation overwrite) are exact; only
  // the value is unknown. Every value whose stored 2dp rate equals the
  // recorded rate is a candidate. Each candidate is rewound independently
  // through the key's earlier history and must survive every inverse and
  // every earlier recorded live sale rate. Proposals are accepted only when
  // at least one candidate survives and all survivors agree exactly on every
  // reconstructed sale cost and on where the rewind stops.
  for (const request of reanchorRequests) {
    const [, locationIdText, stockItemIdText] = request.key.split(":");
    const locationId = Number(locationIdText);
    const stockItemId = Number(stockItemIdText);
    const blockUnresolved = (sales: HistoricalSalesRepairMovement[]) => {
      for (const saleMovement of sales) {
        checks.push({
          companyId,
          locationId: saleMovement.locationId,
          stockItemId: saleMovement.stockItemId,
          salesItemId: saleMovement.sale!.salesItemId,
          code: "CANONICAL_SALE_COST_EVIDENCE_MISMATCH",
          status: "block",
          expected: request.recorded.toFixed(2),
          actual: request.inferred.toFixed(2),
          detail: `Sales item ${saleMovement.sale!.salesItemId} predates canonical cost boundary ${request.anchor.movementId}`,
        });
      }
    };

    const earlier = movementsInCheckpoint.filter(
      (candidateMovement) =>
        movementKey(candidateMovement) === request.key &&
        compareMovementMutationAscending(candidateMovement, request.anchor) < 0
    );
    const result = reanchorHistoricalRewindAtRecordedRate({
      anchorQuantity: request.beforeQuantity,
      recordedRate: request.recorded,
      earlierMovementsDescending: earlier,
      targetSaleIds: new Set(request.unresolvedSales.map((sale) => sale.sale!.salesItemId)),
      priorCostMemoryRateHints,
      maxCandidates: REANCHOR_MAX_CANDIDATES.toNumber(),
    });
    if (result.status !== "proven") {
      checks.push({
        companyId,
        locationId,
        stockItemId,
        code: `${reanchorCodePrefix(request.transition)}_REANCHOR_AMBIGUOUS`,
        status: "warning",
        expected: "1 agreeing outcome",
        actual:
          result.status === "too-wide"
            ? `${result.candidateCount} cent values to enumerate`
            : `${result.survivorCount} surviving of ${result.candidateCount} candidates, ${result.distinctOutcomeCount} distinct outcomes`,
        detail: `Re-anchor at ${request.anchor.movementId} below ${request.transition} ${request.transitionMovementId} is not unique`,
      });
      blockUnresolved(request.unresolvedSales);
      continue;
    }

    let proven = 0;
    for (const saleMovement of request.unresolvedSales) {
      const salesItemId = saleMovement.sale!.salesItemId;
      const proposal = result.proposals.get(salesItemId);
      if (!proposal) {
        if (result.stoppedAt) {
          // Every survivor stopped at the same irreversible cost-memory
          // boundary above this sale: that, not the anchor, blocks it.
          checks.push({
            companyId,
            locationId: saleMovement.locationId,
            stockItemId: saleMovement.stockItemId,
            salesItemId,
            code: "LEGACY_REWIND_COST_MEMORY_IRREVERSIBLE",
            status: "block",
            detail: `Sales item ${salesItemId} predates irreversible valuation boundary ${result.stoppedAt} below re-anchor ${request.anchor.movementId}`,
          });
        } else {
          blockUnresolved([saleMovement]);
        }
        continue;
      }
      if (result.notUniqueSaleIds.has(salesItemId)) {
        checks.push({
          companyId,
          locationId: saleMovement.locationId,
          stockItemId: saleMovement.stockItemId,
          salesItemId,
          code: "LEGACY_SALE_INVERSE_NOT_UNIQUE",
          status: "block",
          detail: `Sales item ${salesItemId}: the re-anchored rewind at ${request.anchor.movementId} admits more than one exact pre-sale rate, so its cost is not uniquely proven`,
        });
        continue;
      }
      const saleSensitivity = result.sensitivity.get(salesItemId) ?? new Decimal(0);
      if (saleSensitivity.gt(REWIND_AMPLIFICATION_LIMIT)) {
        checks.push({
          companyId,
          locationId,
          stockItemId,
          salesItemId,
          code: "LEGACY_REWIND_ERROR_AMPLIFICATION_EXCEEDED",
          status: "block",
          expected: `<=${REWIND_AMPLIFICATION_LIMIT.toFixed(0)}`,
          actual: saleSensitivity.toFixed(2),
          detail: `Sales item ${salesItemId} re-anchored cost moves ${saleSensitivity.toFixed(
            2
          )} cents per cent of model error`,
        });
        continue;
      }
      proposalsBySaleId.set(salesItemId, proposal);
      proven += 1;
    }
    checks.push({
      companyId,
      locationId,
      stockItemId,
      code: `${reanchorCodePrefix(request.transition)}_REANCHOR_PROVEN`,
      status: "pass",
      expected: String(request.unresolvedSales.length),
      actual: String(proven),
      detail: `${result.survivorCount} of ${result.candidateCount} value candidates at ${request.anchor.movementId} (recorded ${request.recorded.toFixed(2)}, below ${request.transition} ${request.transitionMovementId}) survived and agree on every reconstructed sale cost${
        result.stoppedAt ? `; rewind stops at ${result.stoppedAt}` : ""
      }`,
    });
  }
}
