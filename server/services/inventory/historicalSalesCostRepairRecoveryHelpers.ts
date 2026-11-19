// Extracted from ./historicalSalesCostRepairRecovery.ts: shared helpers.
import Decimal from "decimal.js";
import {
  applyHistoricalSalesRepairMovement,
  createHistoricalInventoryStateFromSnapshot,
  historicalRateWithinEvidencedRange,
  repairMoney,
  repairQuantity,
  repairRate,
  type HistoricalInventoryState,
  type HistoricalSalesRepairMovement,
  type HistoricalSalesRepairProposal,
} from "./historicalSalesCostRepairEngine";
import { historicalSaleProposalFromState } from "./historicalSalesCostRepairEngineReplay";
import {
  HistoricalMergeRow,
  LegacyRow,
  MONEY_TOLERANCE,
  OffloadValueEvidenceRow,
  QTY_TOLERANCE,
  RepairCheck,
  SaleRow,
  StockItemRow,
  ValuationCheckpoint,
  beforeCutoff,
  d,
  iso,
} from "./historicalSalesCostRepairTypes";
import {
  canonicalMovementNumericId,
  compareMovementMutationAscending,
  movementMutationTime,
} from "./historicalSalesCostRepairEvidence";

export function markAmbiguousTimestampTies(
  companyId: number,
  movements: HistoricalSalesRepairMovement[],
  sales: SaleRow[],
  canonicalStart: Date | null,
  canonicalSaleKeys: Set<string>
): RepairCheck[] {
  const checks: RepairCheck[] = [];
  const inboundByKeyTime = new Set<string>();
  for (const movement of movements) {
    if (movement.evidence !== "legacy") continue;
    if (d(movement.quantityDelta).lte(0) || movement.unitCost === null) continue;
    inboundByKeyTime.add(`${movement.locationId}:${movement.stockItemId}:${movement.occurredAt}`);
  }
  for (const sale of sales) {
    if (!sale.location_id || !beforeCutoff(sale.created_at, canonicalStart)) continue;
    if (canonicalSaleKeys.has(`${sale.voucher_id}:${sale.location_id}:${sale.stock_item_id}`)) continue;
    const key = `${sale.location_id}:${sale.stock_item_id}:${iso(sale.created_at)}`;
    if (inboundByKeyTime.has(key)) {
      checks.push({
        companyId,
        locationId: Number(sale.location_id),
        stockItemId: Number(sale.stock_item_id),
        code: "SAME_TIMESTAMP_COST_ORDER_AMBIGUOUS",
        status: "block",
        detail: `Sale item ${sale.sales_item_id} shares an exact legacy timestamp with a priced stock-in; ordering cannot be proven`,
      });
    }
  }
  return checks;
}

export function stateForZeroOpening(rate: Decimal.Value): HistoricalInventoryState {
  return createHistoricalInventoryStateFromSnapshot("0", repairRate(rate), "0");
}

export function historicalInventoryStatesEqual(
  left: HistoricalInventoryState,
  right: HistoricalInventoryState
): boolean {
  return (
    repairQuantity(left.quantity).eq(repairQuantity(right.quantity)) &&
    repairRate(left.averageRate).eq(repairRate(right.averageRate)) &&
    repairMoney(left.totalValue).eq(repairMoney(right.totalValue))
  );
}

export function stateQuantityValueMatches(
  actual: HistoricalInventoryState,
  expected: HistoricalInventoryState
): boolean {
  return (
    repairQuantity(actual.quantity).minus(repairQuantity(expected.quantity)).abs().lte(QTY_TOLERANCE) &&
    repairMoney(actual.totalValue).minus(repairMoney(expected.totalValue)).abs().lte(MONEY_TOLERANCE)
  );
}

export function checkpointContainsMovement(
  movement: HistoricalSalesRepairMovement,
  checkpoint: ValuationCheckpoint
): boolean {
  const canonicalId = canonicalMovementNumericId(movement);
  if (canonicalId !== null) return canonicalId <= checkpoint.movementCutoffId;
  return movementMutationTime(movement) <= checkpoint.createdAt.getTime();
}

export function replayMergedSourceLocationForward(input: {
  companyId: number;
  sourceItemId: number;
  locationId: number;
  opening: HistoricalInventoryState;
  movements: HistoricalSalesRepairMovement[];
  mergeAtMs: number;
}): { stateAtMerge: HistoricalInventoryState; proposals: HistoricalSalesRepairProposal[] } {
  let state = createHistoricalInventoryStateFromSnapshot(
    input.opening.quantity,
    input.opening.averageRate,
    input.opening.totalValue
  );
  const proposals: HistoricalSalesRepairProposal[] = [];
  const movements = input.movements
    .filter(
      (movement) =>
        movement.stockItemId === input.sourceItemId &&
        movement.locationId === input.locationId &&
        movementMutationTime(movement) < input.mergeAtMs
    )
    .sort(compareMovementMutationAscending);

  for (const movement of movements) {
    if (movement.sale) proposals.push(historicalSaleProposalFromState(movement, state));
    state = applyHistoricalSalesRepairMovement(state, movement);
  }
  return { stateAtMerge: state, proposals };
}

/**
 * Every rate an item could have carried, from evidence already pinned in the
 * V2 source hash: pinned openings, priced receipts (canonical and legacy),
 * exact offload values, recorded live sale-issue rates, the checkpoint, and
 * the rates of historically merged source items.
 */
export function evidencedRateHullByItem(input: {
  stockItems: StockItemRow[];
  canonical: HistoricalSalesRepairMovement[];
  legacy: LegacyRow[];
  offloadEvidence: OffloadValueEvidenceRow[];
  checkpoint: ValuationCheckpoint | null;
  historicalMerges: HistoricalMergeRow[];
}): Map<number, { low: Decimal; high: Decimal }> {
  const hull = new Map<number, { low: Decimal; high: Decimal }>();
  const add = (stockItemId: number, value: Decimal.Value | null | undefined) => {
    if (value === null || value === undefined) return;
    const rate = new Decimal(value);
    if (!rate.isFinite() || !rate.gt(0)) return;
    const current = hull.get(stockItemId);
    if (!current) {
      hull.set(stockItemId, { low: rate, high: rate });
      return;
    }
    if (rate.lt(current.low)) current.low = rate;
    if (rate.gt(current.high)) current.high = rate;
  };

  for (const item of input.stockItems) add(Number(item.id), item.opening_rate);
  for (const movement of input.canonical) {
    const delta = d(movement.quantityDelta);
    if (delta.gt(0) || movement.canonicalPosRole === "sale-issue") {
      add(movement.stockItemId, movement.unitCost);
    }
  }
  for (const row of input.legacy) {
    if (d(row.quantity_delta).gt(0)) add(Number(row.stock_item_id), row.unit_cost);
  }
  for (const row of input.offloadEvidence) {
    add(Number(row.stock_item_id), row.rate);
    const quantity = d(row.quantity);
    if (quantity.gt(0)) add(Number(row.stock_item_id), d(row.total_value).dividedBy(quantity));
  }
  for (const row of input.checkpoint?.rows ?? []) {
    if (d(row.quantity).gt(0)) add(Number(row.stock_item_id), row.average_rate);
  }
  for (const merge of input.historicalMerges) {
    const source = hull.get(Number(merge.source_item_id));
    if (source) {
      add(Number(merge.kept_item_id), source.low);
      add(Number(merge.kept_item_id), source.high);
    }
    add(Number(merge.kept_item_id), merge.source_opening_rate);
  }
  return hull;
}

export function rateHullBlocks(input: {
  companyId: number;
  proposals: HistoricalSalesRepairProposal[];
  stockItems: StockItemRow[];
  canonical: HistoricalSalesRepairMovement[];
  legacy: LegacyRow[];
  offloadEvidence: OffloadValueEvidenceRow[];
  checkpoint: ValuationCheckpoint | null;
  historicalMerges: HistoricalMergeRow[];
  /** Sales proven independently of the rewind chain (closed zero-stock eras). */
  independentSaleIds?: Set<number>;
}): RepairCheck[] {
  const hull = evidencedRateHullByItem(input);
  const worstByKey = new Map<string, { proposal: HistoricalSalesRepairProposal; count: number }>();
  for (const proposal of input.proposals) {
    if (proposal.evidence !== "legacy") continue;
    const rate = repairRate(proposal.proposedCostPrice);
    if (historicalRateWithinEvidencedRange(rate, hull.get(proposal.stockItemId))) continue;
    const key = `${proposal.locationId}:${proposal.stockItemId}`;
    const current = worstByKey.get(key);
    worstByKey.set(key, {
      proposal: current && d(current.proposal.proposedCostPrice).gt(rate) ? current.proposal : proposal,
      count: (current?.count ?? 0) + 1,
    });
  }

  const independent = input.independentSaleIds ?? new Set<number>();
  const legacyByKey = new Map<string, HistoricalSalesRepairProposal[]>();
  for (const candidate of input.proposals) {
    if (candidate.evidence !== "legacy") continue;
    const key = `${candidate.locationId}:${candidate.stockItemId}`;
    if (!worstByKey.has(key)) continue;
    const list = legacyByKey.get(key) ?? [];
    list.push(candidate);
    legacyByKey.set(key, list);
  }
  const checks: RepairCheck[] = [];
  for (const [key, { proposal, count }] of worstByKey) {
    const range = hull.get(proposal.stockItemId);
    const keyProposals = legacyByKey.get(key) ?? [];
    if (!keyProposals.some((candidate) => independent.has(candidate.salesItemId))) {
      checks.push(hullCheck(proposal, count, range));
      continue;
    }
    // V48: a hull violation proves the rewind chain wrong, not a sale proven by
    // a closed zero-stock era that never used it. Block every other legacy
    // sale at the key individually; an independent sale is blocked only when
    // its own cost is outside the range.
    for (const candidate of keyProposals) {
      const ownOutside = !historicalRateWithinEvidencedRange(repairRate(candidate.proposedCostPrice), range);
      if (independent.has(candidate.salesItemId) && !ownOutside) continue;
      checks.push({ ...hullCheck(proposal, count, range), salesItemId: candidate.salesItemId });
    }
  }
  return checks;

  function hullCheck(
    proposal: HistoricalSalesRepairProposal,
    count: number,
    range: ReturnType<typeof hull.get>
  ): RepairCheck {
    return {
      companyId: input.companyId,
      locationId: proposal.locationId,
      stockItemId: proposal.stockItemId,
      code: "LEGACY_PROPOSED_COST_OUTSIDE_RATE_HULL",
      status: "block" as const,
      expected: range
        ? `${repairRate(range.low).toFixed(2)}..${repairRate(range.high).toFixed(2)}`
        : "no rate evidence",
      actual: repairRate(proposal.proposedCostPrice).toFixed(2),
      detail: `${count} reconstructed sale cost(s) fall outside every rate this item ever carried (worst: sales item ${proposal.salesItemId}); the reconstruction chain for this item/location is unproven`,
    };
  }
}
