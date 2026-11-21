// Extracted from ./historicalSalesCostRepairEngineReplay.ts
import Decimal from "decimal.js";
import {
  HistoricalInventoryState,
  HistoricalSalesRepairMovement,
  HistoricalSalesRepairOpening,
  HistoricalSalesRepairProposal,
  HistoricalSalesRepairReplayResult,
  ZERO,
  applyHistoricalInventoryMovement,
  applyHistoricalSalesRepairMovement,
  createHistoricalInventoryState,
  decimal,
  historicalInventoryKey,
  historicalStateRateMatchesValue,
  hscrEngineError,
  posJournalCostIsNotInventoryRate,
  rawHistoricalInventoryState,
  repairMoney,
  repairQuantity,
  repairRate,
} from "./historicalSalesCostRepairEngine";
import { statesEqual } from "./historicalSalesCostRepairEngineReverse";

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
