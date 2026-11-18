// Extracted from ./historicalSalesCostRepairRecovery.ts: a stage of historicalSalesCostRepairRecovery.
import {
  applyHistoricalSalesRepairMovement,
  createHistoricalInventoryStateFromSnapshot,
  historicalInventoryKey,
  repairMoney,
  repairQuantity,
  repairRate,
  type HistoricalInventoryState,
  type HistoricalSalesRepairProposal,
} from "./historicalSalesCostRepairEngine";
import { iso } from "./historicalSalesCostRepairTypes";
import {
  compareMovementMutationAscending,
  compareMovementMutationDescending,
  movementMutationTime,
} from "./historicalSalesCostRepairEvidence";
import {
  stateForZeroOpening,
  checkpointContainsMovement,
  replayMergedSourceLocationForward,
} from "./historicalSalesCostRepairRecoveryHelpers";
import type { HistoricalSalesRepairMovement } from "./historicalSalesCostRepairEngine";
import type { HistoricalMergeRow, RepairCheck, ValuationCheckpoint } from "./historicalSalesCostRepairTypes";

export function historicalSalesCostRepairRecoveryStep({
  mergeBySource,
  sourceItemId,
  input,
  blockSourceKeys,
  allMovements,
  missingKeys,
  proposals,
  recoveredKeys,
  checks,
}: {
  mergeBySource: Map<number, HistoricalMergeRow>;
  sourceItemId: number;
  input: {
    companyId: number;
    targetKeys: Set<string>;
    checkpoint: ValuationCheckpoint;
    checkpointStates: Map<string, HistoricalInventoryState>;
    historicalMerges: HistoricalMergeRow[];
    canonical: HistoricalSalesRepairMovement[];
    legacyMovements: HistoricalSalesRepairMovement[];
  };
  blockSourceKeys: (sourceItemId: number, code: string, detail: string) => void;
  allMovements: HistoricalSalesRepairMovement[];
  missingKeys: string[];
  proposals: HistoricalSalesRepairProposal[];
  recoveredKeys: Set<string>;
  checks: RepairCheck[];
}) {
  const merge = mergeBySource.get(sourceItemId);
  if (!merge) return { done: true as const, value: undefined };

  const mergeAtMs = merge.merge_at.getTime();
  if (!Number.isFinite(mergeAtMs) || mergeAtMs > input.checkpoint.createdAt.getTime()) {
    blockSourceKeys(
      sourceItemId,
      "MERGED_ITEM_MERGE_TIMESTAMP_INVALID",
      `Historical merge timestamp is not before the valuation checkpoint (alias ${merge.alias_id})`
    );
    return { done: true as const, value: undefined };
  }

  const sourceMovements = allMovements.filter((movement) => movement.stockItemId === sourceItemId);
  const postMergeSource = sourceMovements.filter((movement) => movementMutationTime(movement) >= mergeAtMs);
  if (postMergeSource.length > 0) {
    blockSourceKeys(
      sourceItemId,
      "MERGED_ITEM_SOURCE_MOVEMENT_AFTER_MERGE",
      `Historical source item has ${postMergeSource.length} inventory movement(s) at/after merge; identity transition is not clean`
    );
    return { done: true as const, value: undefined };
  }

  const sourceOpeningQty = repairQuantity(merge.source_opening_qty);
  const sourceOpeningRate = repairRate(merge.source_opening_rate);
  const sourceOpeningValue = repairMoney(merge.source_opening_value);
  const sourceTargetKeys = missingKeys.filter((key) => Number(key.split(":")[2]) === sourceItemId);
  const sourceTargetLocations = sourceTargetKeys.map((key) => Number(key.split(":")[1]));

  if (sourceOpeningQty.isZero() && sourceOpeningValue.isZero()) {
    const locations = new Set<number>([
      ...sourceTargetLocations,
      ...sourceMovements.map((movement) => movement.locationId),
    ]);
    const sourceProposals: HistoricalSalesRepairProposal[] = [];
    for (const locationId of locations) {
      const replay = replayMergedSourceLocationForward({
        companyId: input.companyId,
        sourceItemId,
        locationId,
        opening: stateForZeroOpening(sourceOpeningRate),
        movements: allMovements,
        mergeAtMs,
      });
      sourceProposals.push(...replay.proposals);
    }

    const proposedSaleIds = new Set(sourceProposals.map((proposal) => proposal.salesItemId));
    const missingProposal = input.legacyMovements.find(
      (movement) =>
        movement.stockItemId === sourceItemId &&
        movement.sale &&
        sourceTargetLocations.includes(movement.locationId) &&
        !proposedSaleIds.has(movement.sale.salesItemId)
    );
    if (missingProposal) {
      blockSourceKeys(
        sourceItemId,
        "MERGED_ITEM_ZERO_OPENING_REPLAY_INCOMPLETE",
        `Could not replay sale item ${missingProposal.sale?.salesItemId ?? "unknown"} from exact zero opening`
      );
      return { done: true as const, value: undefined };
    }

    proposals.push(...sourceProposals);
    for (const key of sourceTargetKeys) {
      recoveredKeys.add(key);
      const [, locationIdText] = key.split(":");
      checks.push({
        companyId: input.companyId,
        locationId: Number(locationIdText),
        stockItemId: sourceItemId,
        code: "MERGED_ITEM_ZERO_OPENING_REPLAY",
        status: "pass",
        expected: "0.000|0.00",
        actual: "0.000|0.00",
        detail: `Alias ${merge.alias_code} -> ${merge.kept_code}; merged at ${iso(merge.merge_at)}; source opening is exact zero`,
      });
    }
    return { done: true as const, value: undefined };
  }

  const keptOpeningQty = repairQuantity(merge.kept_opening_qty);
  const keptOpeningValue = repairMoney(merge.kept_opening_value);
  if (!keptOpeningQty.isZero() || !keptOpeningValue.isZero()) {
    blockSourceKeys(
      sourceItemId,
      "MERGED_ITEM_SPLIT_UNPROVEN",
      `Source opening is nonzero and kept item ${merge.kept_item_id} also has a nonzero opening; merge split cannot be uniquely separated`
    );
    return { done: true as const, value: undefined };
  }

  const keptItemId = Number(merge.kept_item_id);
  const keptMovements = allMovements.filter((movement) => movement.stockItemId === keptItemId);
  const sourcePreMovements = sourceMovements.filter((movement) => movementMutationTime(movement) < mergeAtMs);
  const keptPreMovements = keptMovements
    .filter((movement) => movementMutationTime(movement) < mergeAtMs)
    .sort(compareMovementMutationAscending);
  const keptPostMovements = keptMovements
    .filter(
      (movement) => movementMutationTime(movement) > mergeAtMs && checkpointContainsMovement(movement, input.checkpoint)
    )
    .sort(compareMovementMutationDescending);

  const relevantLocations = new Set<number>([
    ...sourceTargetLocations,
    ...sourcePreMovements.map((movement) => movement.locationId),
    ...input.checkpoint.rows
      .filter((row) => Number(row.stock_item_id) === keptItemId)
      .map((row) => Number(row.location_id)),
  ]);

  const keptBeforeByLocation = new Map<number, HistoricalInventoryState>();
  for (const locationId of relevantLocations) {
    keptBeforeByLocation.set(locationId, stateForZeroOpening(merge.kept_opening_rate));
  }
  for (const movement of keptPreMovements) {
    if (!relevantLocations.has(movement.locationId)) continue;
    const current = keptBeforeByLocation.get(movement.locationId) ?? stateForZeroOpening(merge.kept_opening_rate);
    keptBeforeByLocation.set(movement.locationId, applyHistoricalSalesRepairMovement(current, movement));
  }

  const combinedAtMergeByLocation = new Map<number, HistoricalInventoryState>();
  let keptRewindFailure: { locationId: number; detail: string } | null = null;
  for (const locationId of relevantLocations) {
    const checkpointKey = historicalInventoryKey(input.companyId, locationId, keptItemId);
    const checkpointState = input.checkpointStates.get(checkpointKey);
    if (!checkpointState) {
      keptRewindFailure = {
        locationId,
        detail: `Kept item ${keptItemId} has no checkpoint row at location ${locationId}`,
      };
      break;
    }
    combinedAtMergeByLocation.set(
      locationId,
      createHistoricalInventoryStateFromSnapshot(
        checkpointState.quantity,
        checkpointState.averageRate,
        checkpointState.totalValue
      )
    );
  }

  return {
    done: false as const,
    merge,
    mergeAtMs,
    sourceOpeningQty,
    sourceOpeningRate,
    sourceOpeningValue,
    sourceTargetKeys,
    sourceTargetLocations,
    sourcePreMovements,
    keptPostMovements,
    relevantLocations,
    keptBeforeByLocation,
    combinedAtMergeByLocation,
    keptRewindFailure,
  };
}
