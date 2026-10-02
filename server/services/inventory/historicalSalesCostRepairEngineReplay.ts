/** Sale proposals, forward cost replay, re-anchoring and issue-inverse candidates for the historical sales-cost repair engine. */
import Decimal from "decimal.js";
import {
  EXACT_OFFLOAD_REMOVAL_SOURCE_TYPES,
  HistoricalInventoryState,
  HistoricalSalesRepairMovement,
  HistoricalSalesRepairOpening,
  HistoricalSalesRepairProposal,
  HistoricalSalesRepairReplayResult,
  INITIAL_OFFLOAD_SOURCE_TYPES,
  ZERO,
  applyHistoricalInventoryMovement,
  applyHistoricalSalesRepairMovement,
  createHistoricalInventoryState,
  createHistoricalInventoryStateFromSnapshot,
  decimal,
  historicalInventoryKey,
  historicalStateRateMatchesValue,
  hscrEngineError,
  isExactValuationReset,
  posJournalCostIsNotInventoryRate,
  rawHistoricalInventoryState,
  repairMoney,
  repairQuantity,
  repairRate,
} from "./historicalSalesCostRepairEngine";
import { reverseHistoricalSalesRepairMovement, statesEqual } from "./historicalSalesCostRepairEngineReverse";

export function historicalSaleProposalFromState(
  movement: HistoricalSalesRepairMovement,
  stateBefore: HistoricalInventoryState
): HistoricalSalesRepairProposal {
  if (!movement.sale) throw hscrEngineError("HSCR_SALE_PROPOSAL_REQUIRES_SALE_MOVEMENT");
  const saleQty = repairQuantity(movement.sale.quantity).abs();
  const proposedCostPrice = repairRate(stateBefore.averageRate);
  const proposedTotalCost = repairMoney(saleQty.times(proposedCostPrice));
  const proposedProfit = repairMoney(decimal(movement.sale.totalSales, "sale total").minus(proposedTotalCost));
  const originalCostPrice = repairRate(movement.sale.originalCostPrice);
  const originalTotalCost = repairMoney(movement.sale.originalTotalCost);
  const originalProfit = repairMoney(movement.sale.originalProfit);

  return {
    salesItemId: movement.sale.salesItemId,
    voucherId: movement.sale.voucherId,
    companyId: movement.companyId,
    locationId: movement.locationId,
    stockItemId: movement.stockItemId,
    occurredAt: movement.occurredAt,
    sourceType: movement.sourceType,
    sourceId: movement.sourceId,
    evidence: movement.evidence,
    originalCostPrice: originalCostPrice.toFixed(2),
    originalTotalCost: originalTotalCost.toFixed(2),
    originalProfit: originalProfit.toFixed(2),
    proposedCostPrice: proposedCostPrice.toFixed(2),
    proposedTotalCost: proposedTotalCost.toFixed(2),
    proposedProfit: proposedProfit.toFixed(2),
    changed:
      !originalCostPrice.eq(proposedCostPrice) ||
      !originalTotalCost.eq(proposedTotalCost) ||
      !originalProfit.eq(proposedProfit),
  };
}

function compareMovements(a: HistoricalSalesRepairMovement, b: HistoricalSalesRepairMovement): number {
  const time = Date.parse(a.occurredAt) - Date.parse(b.occurredAt);
  if (time !== 0) return time;
  if (a.sequence !== b.sequence) return a.sequence - b.sequence;
  return a.movementId.localeCompare(b.movementId);
}

export function replayHistoricalSalesCosts(input: {
  openings: HistoricalSalesRepairOpening[];
  movements: HistoricalSalesRepairMovement[];
}): HistoricalSalesRepairReplayResult {
  const states = new Map<string, HistoricalInventoryState>();
  for (const opening of input.openings) {
    states.set(
      historicalInventoryKey(opening.companyId, opening.locationId, opening.stockItemId),
      createHistoricalInventoryState(opening.quantity, opening.averageRate)
    );
  }

  const proposals: HistoricalSalesRepairProposal[] = [];
  const movements = [...input.movements].sort(compareMovements);

  for (const movement of movements) {
    const key = historicalInventoryKey(movement.companyId, movement.locationId, movement.stockItemId);
    const current =
      states.get(key) ??
      createHistoricalInventoryState("0", movement.unitCost === null ? "0" : (movement.unitCost ?? "0"));

    if (movement.sale) {
      const saleQty = repairQuantity(movement.sale.quantity).abs();
      const proposedCostPrice = repairRate(current.averageRate);
      const proposedTotalCost = repairMoney(saleQty.times(proposedCostPrice));
      const proposedProfit = repairMoney(decimal(movement.sale.totalSales, "sale total").minus(proposedTotalCost));

      const originalCostPrice = repairRate(movement.sale.originalCostPrice);
      const originalTotalCost = repairMoney(movement.sale.originalTotalCost);
      const originalProfit = repairMoney(movement.sale.originalProfit);

      proposals.push({
        salesItemId: movement.sale.salesItemId,
        voucherId: movement.sale.voucherId,
        companyId: movement.companyId,
        locationId: movement.locationId,
        stockItemId: movement.stockItemId,
        occurredAt: movement.occurredAt,
        sourceType: movement.sourceType,
        sourceId: movement.sourceId,
        evidence: movement.evidence,
        originalCostPrice: originalCostPrice.toFixed(2),
        originalTotalCost: originalTotalCost.toFixed(2),
        originalProfit: originalProfit.toFixed(2),
        proposedCostPrice: proposedCostPrice.toFixed(2),
        proposedTotalCost: proposedTotalCost.toFixed(2),
        proposedProfit: proposedProfit.toFixed(2),
        changed:
          !originalCostPrice.eq(proposedCostPrice) ||
          !originalTotalCost.eq(proposedTotalCost) ||
          !originalProfit.eq(proposedProfit),
      });
    }

    states.set(
      key,
      applyHistoricalInventoryMovement(current, {
        quantityDelta: movement.quantityDelta,
        unitCost: movement.unitCost,
      })
    );
  }

  return { proposals, closingStates: states };
}

/**
 * True for a canonical original sale issue: its unit cost is the locked live
 * inventory rate at the moment of the sale, a persisted observation of the
 * stored average rate. Edit legs journal the old line cost and are excluded.
 */
export function isRecordedLiveRateObservation(movement: HistoricalSalesRepairMovement): boolean {
  return (
    movement.evidence === "canonical" &&
    (movement.sourceType === "pos-sale" ||
      movement.sourceType === "pos-import" ||
      movement.sourceType === "credit-sales-import") &&
    !posJournalCostIsNotInventoryRate(movement) &&
    decimal(movement.quantityDelta, "quantity delta").lt(0) &&
    movement.unitCost !== null &&
    movement.unitCost !== undefined
  );
}

export type HistoricalReanchorResult = {
  status: "proven" | "ambiguous" | "too-wide";
  candidateCount: number;
  survivorCount: number;
  distinctOutcomeCount: number;
  /** Reconstructed cost for each target sale reached by every survivor. */
  proposals: Map<number, HistoricalSalesRepairProposal>;
  /** Worst rewind amplification per target sale across all survivors. */
  sensitivity: Map<number, Decimal>;
  /** Movement where every survivor stopped at irreversible cost memory. */
  stoppedAt: string | null;
  /** Target sales whose own legacy inverse admits another exact pre-sale rate (V50). */
  notUniqueSaleIds: Set<number>;
};

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

/**
 * Jointly invert an original POS issue and its restored dropped lines (V44).
 *
 * Each dropped line was issued at the live rate left by the line before it,
 * so inverting a line alone can have two self-consistent pre-states a cent
 * apart. The journaled first line records the live rate before the whole
 * sale, which pins the chain: every combination of dropped-line pre-rates
 * (within ten cents of the after-state rate) is tried, and the inverse is
 * accepted only when exactly one combination replays every line exactly and
 * lands on a pre-sale state whose stored rate equals the recorded rate.
 *
 * `groupDescending` is newest first: the dropped lines, then the original.
 * Returns every solution (the state before each movement, in the same
 * order), capped at `maxSolutions`; an empty list when none exists.
 */
export function reverseCollapsedPosIssueGroup(
  stateAfterInput: HistoricalInventoryState,
  groupDescending: HistoricalSalesRepairMovement[],
  maxSolutions = 2
): HistoricalInventoryState[][] {
  const original = groupDescending[groupDescending.length - 1];
  if (!original || !isRecordedLiveRateObservation(original)) return [];
  const recorded = repairRate(original.unitCost!);
  const dropped = groupDescending.slice(0, -1);
  if (dropped.length === 0 || dropped.some((movement) => movement.canonicalPosRole !== "dropped-line")) return [];

  const solutions: HistoricalInventoryState[][] = [];
  const search = (state: HistoricalInventoryState, index: number, path: HistoricalInventoryState[]) => {
    if (solutions.length >= maxSolutions) return;
    if (index === dropped.length) {
      const quantity = repairQuantity(original.quantityDelta).abs();
      const before = rawHistoricalInventoryState(
        repairQuantity(state.quantity.plus(quantity)),
        recorded,
        repairMoney(state.totalValue.plus(quantity.times(recorded)))
      );
      if (!historicalStateRateMatchesValue(before)) return;
      if (!statesEqual(applyHistoricalSalesRepairMovement(before, original), state)) return;
      solutions.push([...path, before]);
      return;
    }
    const movement = dropped[index];
    const quantity = repairQuantity(movement.quantityDelta).abs();
    const center = repairRate(state.averageRate);
    for (let cents = -10; cents <= 10; cents += 1) {
      const rate = repairRate(center.plus(new Decimal(cents).dividedBy(100)));
      if (rate.lt(ZERO)) continue;
      const before = rawHistoricalInventoryState(
        repairQuantity(state.quantity.plus(quantity)),
        rate,
        repairMoney(state.totalValue.plus(quantity.times(rate)))
      );
      if (!historicalStateRateMatchesValue(before)) continue;
      if (!statesEqual(applyHistoricalSalesRepairMovement(before, movement), state)) continue;
      search(before, index + 1, [...path, before]);
    }
  };
  search(
    rawHistoricalInventoryState(stateAfterInput.quantity, stateAfterInput.averageRate, stateAfterInput.totalValue),
    0,
    []
  );
  return solutions;
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
