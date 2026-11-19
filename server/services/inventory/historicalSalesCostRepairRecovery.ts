/** Timestamp-tie marking, merged stock-item recovery and evidenced rate hulls for the historical sales-cost repair. */
import Decimal from "decimal.js";

import {
  createHistoricalInventoryStateFromSnapshot,
  repairMoney,
  repairQuantity,
  repairRate,
  type HistoricalInventoryState,
  type HistoricalSalesRepairMovement,
  type HistoricalSalesRepairProposal,
} from "./historicalSalesCostRepairEngine";
import {
  HistoricalMergeRow,
  MONEY_TOLERANCE,
  QTY_TOLERANCE,
  RepairCheck,
  ValuationCheckpoint,
  iso,
} from "./historicalSalesCostRepairTypes";
import { buildPriorCanonicalCostMemoryRateHints } from "./historicalSalesCostRepairEvidence";
import {
  stateForZeroOpening,
  stateQuantityValueMatches,
  replayMergedSourceLocationForward,
} from "./historicalSalesCostRepairRecoveryHelpers";
export {
  markAmbiguousTimestampTies,
  stateForZeroOpening,
  historicalInventoryStatesEqual,
  rateHullBlocks,
} from "./historicalSalesCostRepairRecoveryHelpers";
import { historicalSalesCostRepairRecoveryStep } from "./historicalSalesCostRepairRecoveryStep";
import { historicalSalesCostRepairRecoveryStep2 } from "./historicalSalesCostRepairRecoveryStep2";

export type MergedRecoveryResult = {
  recoveredKeys: Set<string>;
  proposals: HistoricalSalesRepairProposal[];
  checks: RepairCheck[];
};

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

  const recoverMergedSource = (sourceItemId: number): void => {
    const hrr1 = historicalSalesCostRepairRecoveryStep({
      mergeBySource,
      sourceItemId,
      input,
      blockSourceKeys,
      allMovements,
      missingKeys,
      proposals,
      recoveredKeys,
      checks,
    });
    if (hrr1.done) return hrr1.value;
    const {
      sourceOpeningRate,
      mergeAtMs,
      sourceOpeningQty,
      sourceOpeningValue,
      sourceTargetLocations,
      sourceTargetKeys,
      merge,
    } = hrr1;
    const hrr2 = historicalSalesCostRepairRecoveryStep2({
      hrr1,
      priorCostMemoryRateHints,
      input,
      sourceItemId,
      allMovements,
      blockSourceKeys,
      checks,
    });
    if (hrr2.done) return hrr2.value;
    const {
      remainingOpeningQty,
      remainingOpeningValue,
      unresolvedWithActivity,
      sourceAtMergeByLocation,
      openingByLocation,
      tempProposals,
    } = hrr2;
    if ((!remainingOpeningQty.isZero() || !remainingOpeningValue.isZero()) && unresolvedWithActivity.length !== 1) {
      blockSourceKeys(
        sourceItemId,
        "MERGED_ITEM_OPENING_LOCATION_AMBIGUOUS",
        `Remaining source opening ${remainingOpeningQty.toFixed(3)} / ${remainingOpeningValue.toFixed(
          2
        )} cannot be assigned uniquely across ${unresolvedWithActivity.length} unresolved locations`
      );
      return;
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
        mergeAtMs: mergeAtMs,
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
      return;
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
      return;
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
      return;
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
  };
  for (const sourceItemId of sourceIds) recoverMergedSource(sourceItemId);

  return { recoveredKeys, proposals, checks };
}
