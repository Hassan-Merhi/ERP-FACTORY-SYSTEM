/** Timestamp-tie marking, merged stock-item recovery and evidenced rate hulls for the historical sales-cost repair. */
import Decimal from "decimal.js";

import {
  applyHistoricalSalesRepairMovement,
  createHistoricalInventoryStateFromSnapshot,
  historicalInventoryKey,
  historicalRateWithinEvidencedRange,
  repairMoney,
  repairQuantity,
  repairRate,
  type HistoricalInventoryState,
  type HistoricalSalesRepairMovement,
  type HistoricalSalesRepairProposal,
} from "./historicalSalesCostRepairEngine";
import {
  historicalSaleProposalFromState,
  historicalIssueInverseCandidates,
  isRecordedLiveRateObservation,
} from "./historicalSalesCostRepairEngineReplay";
import { reverseHistoricalSalesRepairMovement } from "./historicalSalesCostRepairEngineReverse";
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
  legacyInverseNotUniqueBlock,
} from "./historicalSalesCostRepairTypes";
import {
  buildPriorCanonicalCostMemoryRateHints,
  canonicalMovementNumericId,
  compareMovementMutationAscending,
  compareMovementMutationDescending,
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

export type MergedRecoveryResult = {
  recoveredKeys: Set<string>;
  proposals: HistoricalSalesRepairProposal[];
  checks: RepairCheck[];
};

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

function stateQuantityValueMatches(actual: HistoricalInventoryState, expected: HistoricalInventoryState): boolean {
  return (
    repairQuantity(actual.quantity).minus(repairQuantity(expected.quantity)).abs().lte(QTY_TOLERANCE) &&
    repairMoney(actual.totalValue).minus(repairMoney(expected.totalValue)).abs().lte(MONEY_TOLERANCE)
  );
}

function checkpointContainsMovement(movement: HistoricalSalesRepairMovement, checkpoint: ValuationCheckpoint): boolean {
  const canonicalId = canonicalMovementNumericId(movement);
  if (canonicalId !== null) return canonicalId <= checkpoint.movementCutoffId;
  return movementMutationTime(movement) <= checkpoint.createdAt.getTime();
}

function replayMergedSourceLocationForward(input: {
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

export function recoverHistoricalMergedSales(input: {
  companyId: number;
  targetKeys: Set<string>;
  checkpoint: ValuationCheckpoint;
  checkpointStates: Map<string, HistoricalInventoryState>;
  historicalMerges: HistoricalMergeRow[];
  canonical: HistoricalSalesRepairMovement[];
  legacyMovements: HistoricalSalesRepairMovement[];
}): MergedRecoveryResult {
  const recoveredKeys = new Set<string>();
  const proposals: HistoricalSalesRepairProposal[] = [];
  const checks: RepairCheck[] = [];
  const allMovements = [...input.legacyMovements, ...input.canonical];
  const priorCostMemoryRateHints = buildPriorCanonicalCostMemoryRateHints(allMovements);
  const mergeBySource = new Map(input.historicalMerges.map((merge) => [Number(merge.source_item_id), merge]));
  const missingKeys = [...input.targetKeys].filter((key) => !input.checkpointStates.has(key));
  const sourceIds = [...new Set(missingKeys.map((key) => Number(key.split(":")[2])))];

  const blockSourceKeys = (sourceItemId: number, code: string, detail: string) => {
    const sourceKeys = missingKeys.filter((key) => Number(key.split(":")[2]) === sourceItemId);
    for (const key of sourceKeys) {
      const [, locationIdText] = key.split(":");
      checks.push({
        companyId: input.companyId,
        locationId: Number(locationIdText),
        stockItemId: sourceItemId,
        code,
        status: "block",
        detail,
      });
    }
  };

  for (const sourceItemId of sourceIds) {
    const merge = mergeBySource.get(sourceItemId);
    if (!merge) continue;

    const mergeAtMs = merge.merge_at.getTime();
    if (!Number.isFinite(mergeAtMs) || mergeAtMs > input.checkpoint.createdAt.getTime()) {
      blockSourceKeys(
        sourceItemId,
        "MERGED_ITEM_MERGE_TIMESTAMP_INVALID",
        `Historical merge timestamp is not before the valuation checkpoint (alias ${merge.alias_id})`
      );
      continue;
    }

    const sourceMovements = allMovements.filter((movement) => movement.stockItemId === sourceItemId);
    const postMergeSource = sourceMovements.filter((movement) => movementMutationTime(movement) >= mergeAtMs);
    if (postMergeSource.length > 0) {
      blockSourceKeys(
        sourceItemId,
        "MERGED_ITEM_SOURCE_MOVEMENT_AFTER_MERGE",
        `Historical source item has ${postMergeSource.length} inventory movement(s) at/after merge; identity transition is not clean`
      );
      continue;
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
        continue;
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
      continue;
    }

    const keptOpeningQty = repairQuantity(merge.kept_opening_qty);
    const keptOpeningValue = repairMoney(merge.kept_opening_value);
    if (!keptOpeningQty.isZero() || !keptOpeningValue.isZero()) {
      blockSourceKeys(
        sourceItemId,
        "MERGED_ITEM_SPLIT_UNPROVEN",
        `Source opening is nonzero and kept item ${merge.kept_item_id} also has a nonzero opening; merge split cannot be uniquely separated`
      );
      continue;
    }

    const keptItemId = Number(merge.kept_item_id);
    const keptMovements = allMovements.filter((movement) => movement.stockItemId === keptItemId);
    const sourcePreMovements = sourceMovements.filter((movement) => movementMutationTime(movement) < mergeAtMs);
    const keptPreMovements = keptMovements
      .filter((movement) => movementMutationTime(movement) < mergeAtMs)
      .sort(compareMovementMutationAscending);
    const keptPostMovements = keptMovements
      .filter(
        (movement) =>
          movementMutationTime(movement) > mergeAtMs && checkpointContainsMovement(movement, input.checkpoint)
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

    if (!keptRewindFailure) {
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
          if (movement.evidence === "canonical")
            befores.push(...historicalIssueInverseCandidates(stateAfter, movement));
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
          keptRewindFailure = {
            locationId: movement.locationId,
            detail: lastReason
              ? `Cannot rewind kept item movement ${movement.movementId}: ${lastReason}`
              : `Canonical kept-item sale ${movement.movementId} disagrees with every exact checkpoint rewind branch`,
          };
          break;
        }
        if (next.length > 64) {
          keptRewindFailure = {
            locationId: movement.locationId,
            detail: `Kept item rewind exceeded the branch limit at ${movement.movementId}`,
          };
          break;
        }
        keptCandidates.set(movement.locationId, next);
      }
      if (!keptRewindFailure) {
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
              mergeAtMs,
            }).stateAtMerge;
            const expectedQty = repairQuantity(keptBefore.quantity.plus(contribution.quantity));
            const expectedValue = repairMoney(keptBefore.totalValue.plus(contribution.totalValue));
            const matching = states.filter(
              (state) =>
                repairQuantity(state.quantity).eq(expectedQty) && repairMoney(state.totalValue).eq(expectedValue)
            );
            if (matching.length === 1) {
              keptCandidates.set(locationId, matching);
              combinedAtMergeByLocation.set(locationId, matching[0]);
              continue;
            }
          }
          if (states.length !== 1) {
            keptRewindFailure = {
              locationId,
              detail: `Kept item rewind has ${states.length} exact states at the merge`,
            };
            break;
          }
          combinedAtMergeByLocation.set(locationId, states[0]);
        }
      }
    }

    if (keptRewindFailure) {
      blockSourceKeys(sourceItemId, "MERGED_ITEM_KEPT_REWIND_FAILED", keptRewindFailure.detail);
      continue;
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
      continue;
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
              legacyInverseNotUniqueBlock(
                input.companyId,
                movement,
                primaryBefore,
                alternatives,
                "merged source rewind"
              )
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
      continue;
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
      continue;
    }

    const unresolvedWithActivity = unresolvedLocations.filter(
      (locationId) =>
        sourcePreMovements.some((movement) => movement.locationId === locationId) ||
        sourceTargetLocations.includes(locationId)
    );
    if ((!remainingOpeningQty.isZero() || !remainingOpeningValue.isZero()) && unresolvedWithActivity.length !== 1) {
      blockSourceKeys(
        sourceItemId,
        "MERGED_ITEM_OPENING_LOCATION_AMBIGUOUS",
        `Remaining source opening ${remainingOpeningQty.toFixed(3)} / ${remainingOpeningValue.toFixed(
          2
        )} cannot be assigned uniquely across ${unresolvedWithActivity.length} unresolved locations`
      );
      continue;
    }

    let forwardFailure: { locationId: number; detail: string } | null = null;
    for (const locationId of unresolvedWithActivity) {
      const getsRemainder =
        unresolvedWithActivity.length === 1 && (!remainingOpeningQty.isZero() || !remainingOpeningValue.isZero());
      const opening = getsRemainder
        ? createHistoricalInventoryStateFromSnapshot(remainingOpeningQty, sourceOpeningRate, remainingOpeningValue)
        : stateForZeroOpening(sourceOpeningRate);
      const replay = replayMergedSourceLocationForward({
        companyId: input.companyId,
        sourceItemId,
        locationId,
        opening,
        movements: allMovements,
        mergeAtMs,
      });
      const expectedAtMerge = sourceAtMergeByLocation.get(locationId)!;
      if (!stateQuantityValueMatches(replay.stateAtMerge, expectedAtMerge)) {
        forwardFailure = {
          locationId,
          detail: `Forward replay reaches ${replay.stateAtMerge.quantity.toFixed(3)} / ${replay.stateAtMerge.totalValue.toFixed(
            2
          )}, expected merge contribution ${expectedAtMerge.quantity.toFixed(3)} / ${expectedAtMerge.totalValue.toFixed(2)}`,
        };
        break;
      }
      openingByLocation.set(locationId, opening);
      tempProposals.push(...replay.proposals);
    }

    if (forwardFailure) {
      blockSourceKeys(sourceItemId, "MERGED_ITEM_FORWARD_PROOF_FAILED", forwardFailure.detail);
      continue;
    }

    let finalOpeningQty = new Decimal(0);
    let finalOpeningValue = new Decimal(0);
    let openingRateMismatch = false;
    for (const opening of openingByLocation.values()) {
      finalOpeningQty = repairQuantity(finalOpeningQty.plus(opening.quantity));
      finalOpeningValue = repairMoney(finalOpeningValue.plus(opening.totalValue));
      if (opening.quantity.gt(0) && !repairRate(opening.averageRate).eq(sourceOpeningRate)) {
        openingRateMismatch = true;
      }
    }
    if (
      finalOpeningQty.minus(sourceOpeningQty).abs().gt(QTY_TOLERANCE) ||
      finalOpeningValue.minus(sourceOpeningValue).abs().gt(MONEY_TOLERANCE) ||
      openingRateMismatch
    ) {
      blockSourceKeys(
        sourceItemId,
        "MERGED_ITEM_OPENING_RECONCILIATION_FAILED",
        `Recovered opening ${finalOpeningQty.toFixed(3)} @ ${sourceOpeningRate.toFixed(
          2
        )} / ${finalOpeningValue.toFixed(2)} does not reproduce stock master ${sourceOpeningQty.toFixed(
          3
        )} / ${sourceOpeningValue.toFixed(2)}`
      );
      continue;
    }

    const targetSaleIds = new Set(
      input.legacyMovements
        .filter(
          (movement) =>
            movement.stockItemId === sourceItemId &&
            movement.sale &&
            sourceTargetLocations.includes(movement.locationId)
        )
        .map((movement) => movement.sale!.salesItemId)
    );
    const recoveredSaleIds = new Set(tempProposals.map((proposal) => proposal.salesItemId));
    if ([...targetSaleIds].some((saleId) => !recoveredSaleIds.has(saleId))) {
      blockSourceKeys(
        sourceItemId,
        "MERGED_ITEM_SALE_PROPOSAL_INCOMPLETE",
        "At least one historical sale did not receive a proposal from the proven merge rewind"
      );
      continue;
    }

    proposals.push(...tempProposals);
    for (const key of sourceTargetKeys) {
      recoveredKeys.add(key);
      const [, locationIdText] = key.split(":");
      checks.push({
        companyId: input.companyId,
        locationId: Number(locationIdText),
        stockItemId: sourceItemId,
        code: "MERGED_ITEM_IDENTITY_RECONCILED",
        status: "pass",
        expected: `${sourceOpeningQty.toFixed(3)}|${sourceOpeningValue.toFixed(2)}`,
        actual: `${finalOpeningQty.toFixed(3)}|${finalOpeningValue.toFixed(2)}`,
        detail: `Alias ${merge.alias_code} -> ${merge.kept_code}; merge ${iso(
          merge.merge_at
        )}; kept checkpoint rewound and exact source opening recovered`,
      });
    }
  }

  return { recoveredKeys, proposals, checks };
}

/**
 * Every rate an item could have carried, from evidence already pinned in the
 * V2 source hash: pinned openings, priced receipts (canonical and legacy),
 * exact offload values, recorded live sale-issue rates, the checkpoint, and
 * the rates of historically merged source items.
 */
function evidencedRateHullByItem(input: {
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
