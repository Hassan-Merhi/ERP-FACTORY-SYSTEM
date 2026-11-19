// Extracted from ./historicalSalesCostRepairRewind.ts: a stage of historicalSalesCostRepairRewind.
import Decimal from "decimal.js";
import {
  repairQuantity,
  repairRate,
  type HistoricalInventoryState,
  type HistoricalSalesRepairProposal,
} from "./historicalSalesCostRepairEngine";
import {
  historicalSaleProposalFromState,
  historicalIssueInverseCandidates,
  isLiveRateIssueWithUnpinnedRate,
  isRecordedLiveRateObservation,
} from "./historicalSalesCostRepairEngineReplay";
import { reverseHistoricalSalesRepairMovement } from "./historicalSalesCostRepairEngineReverse";
import { RewindAlternate, legacyInverseNotUniqueBlock, traceState } from "./historicalSalesCostRepairTypes";
import { movementKey } from "./historicalSalesCostRepairEvidence";
import { historicalInventoryStatesEqual } from "./historicalSalesCostRepairRecovery";
import type { HistoricalSalesRepairMovement } from "./historicalSalesCostRepairEngine";
import type { RepairCheck } from "./historicalSalesCostRepairTypes";
import type { historicalSalesCostRepairRewindStep } from "./historicalSalesCostRepairRewindStep";

export function historicalSalesCostRepairRewindStep2({
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
}: {
  movement: HistoricalSalesRepairMovement;
  checkpointTargetKeys: {
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
  }["checkpointTargetKeys"];
  unavailableKeys: {
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
  }["unavailableKeys"];
  forwardReplayResolvedKeys: {
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
  }["forwardReplayResolvedKeys"];
  hrw1: ReturnType<typeof historicalSalesCostRepairRewindStep>;
  rewindStates: {
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
  }["rewindStates"];
  priorCostMemoryRateHints: {
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
  }["priorCostMemoryRateHints"];
  forwardResetProvenSaleIds: {
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
  }["forwardResetProvenSaleIds"];
  checks: {
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
  }["checks"];
  companyId: {
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
  }["companyId"];
  proposalsBySaleId: {
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
  }["proposalsBySaleId"];
  traceRewind: {
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
  }["traceRewind"];
}) {
  const {
    rewindBoundaryReached,
    legacyInverseAmbiguity,
    rewindAlternates,
    branchOverflowKeys,
    primaryHistoryByKey,
    finishedAlternates,
    branchSignature,
    REWIND_BRANCH_LIMIT,
  } = hrw1;
  const key = movementKey(movement);
  if (
    !checkpointTargetKeys.has(key) ||
    unavailableKeys.has(key) ||
    forwardReplayResolvedKeys.has(key) ||
    rewindBoundaryReached.has(key)
  ) {
    return { done: true as const, value: undefined };
  }
  const stateAfter = rewindStates.get(key);
  if (!stateAfter) return { done: true as const, value: undefined };
  let reversed = reverseHistoricalSalesRepairMovement(stateAfter, movement, {
    priorCostMemoryRate: priorCostMemoryRateHints.get(movement.movementId) ?? null,
  });

  // V49 measurement: a legacy sale whose own inverse has several exact
  // pre-issue rates is priced on the primary choice (rate unchanged across
  // the issue); count them so the residual uncertainty is reported.
  if (
    movement.evidence === "legacy" &&
    movement.sale &&
    reversed.reversible &&
    isLiveRateIssueWithUnpinnedRate(movement)
  ) {
    const primaryBefore = reversed.stateBefore;
    const alternatives = historicalIssueInverseCandidates(stateAfter, movement).filter(
      (candidate) => !historicalInventoryStatesEqual(candidate, primaryBefore)
    );
    if (alternatives.length > 0) {
      const spread = Decimal.max(
        ...alternatives.map((candidate) =>
          repairRate(candidate.averageRate).minus(repairRate(primaryBefore.averageRate)).abs()
        )
      );
      const entry = legacyInverseAmbiguity.get(key) ?? { sales: 0, maxSpread: new Decimal(0) };
      entry.sales += 1;
      if (spread.gt(entry.maxSpread)) entry.maxSpread = spread;
      legacyInverseAmbiguity.set(key, entry);
      // V50 strict proof: the sale's own cost is not uniquely determined.
      if (!forwardResetProvenSaleIds.has(movement.sale.salesItemId)) {
        checks.push(legacyInverseNotUniqueBlock(companyId, movement, primaryBefore, alternatives, "checkpoint rewind"));
      }
    }
  }

  // V45: advance and branch the alternates, then let recorded evidence
  // prune them or replace a contradicted primary.
  const branchable = movement.evidence === "canonical" && isLiveRateIssueWithUnpinnedRate(movement);
  const currentAlternates = rewindAlternates.get(key) ?? [];
  if ((branchable || currentAlternates.length > 0) && !branchOverflowKeys.has(key)) {
    const primaryHistory = primaryHistoryByKey.get(key) ?? new Map<number, HistoricalSalesRepairProposal>();
    const withSale = (history: Map<number, HistoricalSalesRepairProposal>, state: HistoricalInventoryState) => {
      if (!movement.sale || forwardResetProvenSaleIds.has(movement.sale.salesItemId)) return history;
      const copy = new Map(history);
      copy.set(movement.sale.salesItemId, historicalSaleProposalFromState(movement, state));
      return copy;
    };
    const next: RewindAlternate[] = [];
    const finished = finishedAlternates.get(key) ?? [];
    if (branchable) {
      for (const candidate of historicalIssueInverseCandidates(stateAfter, movement)) {
        if (reversed.reversible && historicalInventoryStatesEqual(candidate, reversed.stateBefore)) continue;
        next.push({ state: candidate, history: withSale(primaryHistory, candidate) });
      }
    }
    for (const alternate of currentAlternates) {
      const alternateReversed = reverseHistoricalSalesRepairMovement(alternate.state, movement, {
        priorCostMemoryRate: priorCostMemoryRateHints.get(movement.movementId) ?? null,
      });
      const befores: HistoricalInventoryState[] = [];
      if (alternateReversed.reversible) befores.push(alternateReversed.stateBefore);
      else if (alternateReversed.reason === "COST_MEMORY_IRREVERSIBLE") finished.push(alternate);
      if (branchable) {
        for (const candidate of historicalIssueInverseCandidates(alternate.state, movement)) {
          if (!befores.some((before) => historicalInventoryStatesEqual(before, candidate))) befores.push(candidate);
        }
      }
      for (const before of befores) next.push({ state: before, history: withSale(alternate.history, before) });
    }

    let surviving = next;
    let promotedBy: string | null = null;
    if (isRecordedLiveRateObservation(movement)) {
      const recorded = repairRate(movement.unitCost!);
      surviving = next.filter((alternate) => repairRate(alternate.state.averageRate).eq(recorded));
      const primaryAgrees = reversed.reversible && repairRate(reversed.stateBefore.averageRate).eq(recorded);
      if (!primaryAgrees && surviving.length > 0) promotedBy = "recorded live rate " + recorded.toFixed(2);
    } else if (!reversed.reversible && reversed.reason === "MOVEMENT_INVERSE_INVALID" && surviving.length > 0) {
      promotedBy = "exact inverse";
    }
    if (promotedBy) {
      const promoted = surviving.shift()!;
      reversed = { reversible: true, stateBefore: promoted.state };
      const promotedHistory = new Map(promoted.history);
      if (movement.sale) promotedHistory.delete(movement.sale.salesItemId);
      for (const [salesItemId, proposal] of promotedHistory) proposalsBySaleId.set(salesItemId, proposal);
      primaryHistoryByKey.set(key, promotedHistory);
      checks.push({
        companyId,
        locationId: movement.locationId,
        stockItemId: movement.stockItemId,
        code: "REWIND_BRANCH_PROMOTED",
        status: "pass",
        actual: traceState(promoted.state),
        detail: `At ${movement.movementId} the ${promotedBy} contradicts the primary rewind; an alternate exact inverse that agrees replaces it`,
      });
    }

    const primaryNow = primaryHistoryByKey.get(key) ?? primaryHistory;
    const primarySignature = reversed.reversible
      ? branchSignature(reversed.stateBefore, withSale(primaryNow, reversed.stateBefore))
      : null;
    const seen = new Set<string>(primarySignature ? [primarySignature] : []);
    const deduped: RewindAlternate[] = [];
    for (const alternate of surviving) {
      const signature = branchSignature(alternate.state, alternate.history);
      if (seen.has(signature)) continue;
      seen.add(signature);
      deduped.push(alternate);
    }
    if (deduped.length > REWIND_BRANCH_LIMIT) {
      branchOverflowKeys.add(key);
      rewindAlternates.set(key, []);
    } else {
      rewindAlternates.set(key, deduped);
    }
    finishedAlternates.set(key, finished);
  }
  traceRewind(
    key,
    [
      movement.createdAt ?? movement.occurredAt,
      movement.movementId,
      movement.sourceType + (movement.canonicalPosRole ? "/" + movement.canonicalPosRole : ""),
      "dq=" + repairQuantity(movement.quantityDelta).toFixed(3),
      "uc=" + (movement.unitCost == null ? "-" : String(movement.unitCost)),
      "ev=" + (movement.exactValue == null ? "-" : String(movement.exactValue)),
      "after=" + traceState(stateAfter),
      reversed.reversible
        ? "before=" + traceState(reversed.stateBefore) + (reversed.recovery ? " via " + reversed.recovery : "")
        : "IRREVERSIBLE " + reversed.reason,
      movement.sale ? "sale=" + movement.sale.salesItemId : "",
      (rewindAlternates.get(key)?.length ?? 0) > 0 ? "alts=" + rewindAlternates.get(key)!.length : "",
    ]
      .filter(Boolean)
      .join(" ")
  );

  return { done: false as const, key, stateAfter, reversed };
}
