/** Sale proposals, forward cost replay, re-anchoring and issue-inverse candidates for the historical sales-cost repair engine. */
import Decimal from "decimal.js";
import {
  EXACT_OFFLOAD_REMOVAL_SOURCE_TYPES,
  HistoricalInventoryState,
  HistoricalSalesRepairMovement,
  HistoricalSalesRepairProposal,
  INITIAL_OFFLOAD_SOURCE_TYPES,
  ZERO,
  applyHistoricalSalesRepairMovement,
  createHistoricalInventoryStateFromSnapshot,
  decimal,
  historicalStateRateMatchesValue,
  isExactValuationReset,
  posJournalCostIsNotInventoryRate,
  rawHistoricalInventoryState,
  repairMoney,
  repairQuantity,
  repairRate,
} from "./historicalSalesCostRepairEngine";
import { reverseHistoricalSalesRepairMovement, statesEqual } from "./historicalSalesCostRepairEngineReverse";
import {
  historicalSaleProposalFromState,
  isRecordedLiveRateObservation,
  type HistoricalReanchorResult,
} from "./historicalSalesCostRepairEngineReplayHelpers";
export {
  historicalSaleProposalFromState,
  replayHistoricalSalesCosts,
  isRecordedLiveRateObservation,
  reverseCollapsedPosIssueGroup,
  type HistoricalReanchorResult,
} from "./historicalSalesCostRepairEngineReplayHelpers";

/**
 * Re-anchor a checkpoint rewind at a canonical original sale issue (V39/V41).
 *
 * At the anchor the locked live rate is journaled and the quantity is exact,
 * only the value is unknown: every 2dp value whose stored rate equals the
 * recorded rate is a candidate. Each candidate is rewound independently
 * through the earlier movements (newest first) and must survive every inverse
 * and agree with every earlier recorded live sale rate. The result is proven
 * only when at least one candidate survives and all survivors agree exactly on
 * every reconstructed target sale cost and on where the rewind stops, so the
 * unknown value cannot change any proposal.
 */
export function reanchorHistoricalRewindAtRecordedRate(input: {
  anchorQuantity: Decimal.Value;
  recordedRate: Decimal.Value;
  earlierMovementsDescending: HistoricalSalesRepairMovement[];
  targetSaleIds: Set<number>;
  priorCostMemoryRateHints?: Map<string, Decimal.Value>;
  maxCandidates?: number;
}): HistoricalReanchorResult {
  const quantity = repairQuantity(input.anchorQuantity);
  const recorded = repairRate(input.recordedRate);
  const maxCandidates = new Decimal(input.maxCandidates ?? 20000);
  const candidates: HistoricalInventoryState[] = [];
  if (!quantity.gt(0)) {
    candidates.push(createHistoricalInventoryStateFromSnapshot(quantity, recorded, "0"));
  } else {
    const lowCents = quantity.times(recorded.minus("0.006")).times(100).floor();
    const highCents = quantity.times(recorded.plus("0.006")).times(100).ceil();
    if (highCents.minus(lowCents).gt(maxCandidates)) {
      return {
        status: "too-wide",
        candidateCount: highCents.minus(lowCents).toNumber(),
        survivorCount: 0,
        distinctOutcomeCount: 0,
        proposals: new Map(),
        sensitivity: new Map(),
        stoppedAt: null,
        notUniqueSaleIds: new Set(),
      };
    }
    for (let cents = lowCents; cents.lte(highCents); cents = cents.plus(1)) {
      const candidate = { quantity, averageRate: recorded, totalValue: repairMoney(cents.dividedBy(100)) };
      if (historicalStateRateMatchesValue(candidate)) candidates.push(candidate);
    }
  }

  type Outcome = {
    proposals: Map<number, HistoricalSalesRepairProposal>;
    sensitivity: Map<number, Decimal>;
    stoppedAt: string | null;
  };
  const notUniqueSaleIds = new Set<number>();
  // V47: each value candidate is rewound as a set of branches. An issue at an
  // unpinned live rate keeps every exact inverse (canonical era only, as in the
  // checkpoint rewind); recorded live rates prune. A candidate whose branches
  // exceed the cap is inconclusive, and the whole re-anchor then fails closed.
  type Branch = { state: HistoricalInventoryState; sensitivity: Decimal; outcome: Outcome };
  const BRANCH_CAP = 64;
  const outcomes: Outcome[] = [];
  let inconclusive = false;
  const outcomeKey = (branch: Branch) =>
    `${branch.state.quantity.toFixed(3)}|${repairRate(branch.state.averageRate).toFixed(2)}|${repairMoney(
      branch.state.totalValue
    ).toFixed(2)}|` +
    [...branch.outcome.proposals.entries()].map(([id, proposal]) => `${id}=${proposal.proposedCostPrice}`).join(",");
  for (const start of candidates) {
    let branches: Branch[] = [
      {
        state: start,
        sensitivity: quantity.gt(0) ? new Decimal(1).dividedBy(quantity) : new Decimal(1),
        outcome: { proposals: new Map(), sensitivity: new Map(), stoppedAt: null },
      },
    ];
    for (const movement of input.earlierMovementsDescending) {
      const next: Branch[] = [];
      for (const branch of branches) {
        const befores: HistoricalInventoryState[] = [];
        const reversed = reverseHistoricalSalesRepairMovement(branch.state, movement, {
          priorCostMemoryRate: input.priorCostMemoryRateHints?.get(movement.movementId) ?? null,
        });
        if (reversed.reversible) befores.push(reversed.stateBefore);
        else if (reversed.reason === "COST_MEMORY_IRREVERSIBLE") {
          outcomes.push({ ...branch.outcome, stoppedAt: movement.movementId });
        }
        if (movement.evidence === "canonical") {
          for (const candidate of historicalIssueInverseCandidates(branch.state, movement)) {
            if (!befores.some((before) => statesEqual(before, candidate))) befores.push(candidate);
          }
        }
        for (const before of befores) {
          if (
            isRecordedLiveRateObservation(movement) &&
            !repairRate(movement.unitCost!).eq(repairRate(before.averageRate))
          ) {
            continue;
          }
          let sensitivity = branch.sensitivity;
          const afterQty = repairQuantity(branch.state.quantity);
          const beforeQty = repairQuantity(before.quantity);
          if (decimal(movement.quantityDelta, "quantity delta").gt(0) && afterQty.gt(0) && beforeQty.gt(0)) {
            sensitivity = Decimal.min(sensitivity.times(afterQty).dividedBy(beforeQty), new Decimal("1e15"));
          }
          const outcome: Outcome = {
            proposals: new Map(branch.outcome.proposals),
            sensitivity: new Map(branch.outcome.sensitivity),
            stoppedAt: null,
          };
          if (movement.sale && input.targetSaleIds.has(movement.sale.salesItemId)) {
            outcome.proposals.set(movement.sale.salesItemId, historicalSaleProposalFromState(movement, before));
            outcome.sensitivity.set(movement.sale.salesItemId, sensitivity);
            if (
              movement.evidence !== "canonical" &&
              historicalIssueInverseCandidates(branch.state, movement).some(
                (candidate) => !statesEqual(candidate, before)
              )
            ) {
              notUniqueSaleIds.add(movement.sale.salesItemId);
            }
          }
          next.push({ state: before, sensitivity, outcome });
        }
      }
      const seen = new Set<string>();
      branches = next.filter((branch) => {
        const key = outcomeKey(branch);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if (branches.length > BRANCH_CAP) {
        inconclusive = true;
        branches = [];
      }
      if (branches.length === 0) break;
    }
    for (const branch of branches) outcomes.push(branch.outcome);
    if (inconclusive) break;
  }

  const signature = (outcome: Outcome) =>
    `${outcome.stoppedAt ?? ""}|` +
    [...outcome.proposals.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([salesItemId, proposal]) => `${salesItemId}=${proposal.proposedCostPrice}`)
      .join(",");
  const distinct = new Set(outcomes.map(signature));
  const proven = !inconclusive && outcomes.length > 0 && distinct.size === 1 && outcomes[0].proposals.size > 0;
  const sensitivity = new Map<number, Decimal>();
  if (proven) {
    for (const salesItemId of outcomes[0].proposals.keys()) {
      sensitivity.set(
        salesItemId,
        Decimal.max(...outcomes.map((outcome) => outcome.sensitivity.get(salesItemId) ?? new Decimal(0)))
      );
    }
  }
  return {
    status: proven ? "proven" : "ambiguous",
    candidateCount: candidates.length,
    survivorCount: outcomes.length,
    distinctOutcomeCount: distinct.size,
    proposals: proven ? outcomes[0].proposals : new Map(),
    sensitivity,
    stoppedAt: proven ? outcomes[0].stoppedAt : null,
    notUniqueSaleIds,
  };
}

/** The restored dropped lines and their original issue, newest first, from a newest-first list. */
export function collapsedPosIssueGroup(
  movementsDescending: HistoricalSalesRepairMovement[],
  dropped: HistoricalSalesRepairMovement
): HistoricalSalesRepairMovement[] {
  const originalId = dropped.movementId.split(":")[1];
  const key = `${dropped.companyId}:${dropped.locationId}:${dropped.stockItemId}`;
  return movementsDescending.filter(
    (movement) =>
      `${movement.companyId}:${movement.locationId}:${movement.stockItemId}` === key &&
      (movement.movementId === `canonical:${originalId}` ||
        movement.movementId.startsWith(`canonical-dropped-line:${originalId}:`))
  );
}

/**
 * True for an outbound movement production executed at the live stored rate
 * whose journal does not pin that rate: unpriced issues, POS edit re-issues,
 * restored dropped lines and stock-transfer source legs (the journal carries
 * the transfer document rate). Original POS sale issues are excluded: their
 * journaled unit cost is the live rate.
 */
export function isLiveRateIssueWithUnpinnedRate(movement: HistoricalSalesRepairMovement): boolean {
  if (!decimal(movement.quantityDelta, "quantity delta").lt(ZERO)) return false;
  if (movement.exactValue !== null && movement.exactValue !== undefined) return false;
  if (isExactValuationReset(movement)) return false;
  if (
    INITIAL_OFFLOAD_SOURCE_TYPES.has(movement.sourceType) ||
    EXACT_OFFLOAD_REMOVAL_SOURCE_TYPES.has(movement.sourceType)
  ) {
    return false;
  }
  return (
    movement.unitCost === null ||
    movement.unitCost === undefined ||
    posJournalCostIsNotInventoryRate(movement) ||
    movement.sourceType === "stock-transfer"
  );
}

/**
 * Every pre-issue state that replays exactly to `stateAfter` for an issue at
 * the live stored rate (V45). Issuing q at rate R leaves value V - qR and a
 * stored rate round((V - qR)/(Q - q)), so when q is large against what remains
 * several pre-issue rates within a few cents can lead to the same after-state.
 * Only positive after-states are expanded; rates within ten cents of the
 * after-state rate are tried.
 */
export function historicalIssueInverseCandidates(
  stateAfterInput: HistoricalInventoryState,
  movement: HistoricalSalesRepairMovement
): HistoricalInventoryState[] {
  const stateAfter = rawHistoricalInventoryState(
    stateAfterInput.quantity,
    stateAfterInput.averageRate,
    stateAfterInput.totalValue
  );
  if (!isLiveRateIssueWithUnpinnedRate(movement) || !stateAfter.quantity.gt(ZERO)) return [];
  const quantity = repairQuantity(movement.quantityDelta).abs();
  const center = repairRate(stateAfter.averageRate);
  const candidates: HistoricalInventoryState[] = [];
  for (let cents = -10; cents <= 10; cents += 1) {
    const rate = repairRate(center.plus(new Decimal(cents).dividedBy(100)));
    if (!rate.gt(ZERO)) continue;
    const before = rawHistoricalInventoryState(
      repairQuantity(stateAfter.quantity.plus(quantity)),
      rate,
      repairMoney(stateAfter.totalValue.plus(quantity.times(rate)))
    );
    if (!historicalStateRateMatchesValue(before)) continue;
    if (!statesEqual(applyHistoricalSalesRepairMovement(before, movement), stateAfter)) continue;
    candidates.push(before);
  }
  return candidates;
}
