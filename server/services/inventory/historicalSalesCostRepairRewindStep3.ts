// Extracted from ./historicalSalesCostRepairRewind.ts: a stage of historicalSalesCostRepairRewind.
import {
  applyHistoricalSalesRepairMovement,
  createHistoricalInventoryStateFromSnapshot,
  repairMoney,
  repairQuantity,
  posJournalCostIsNotInventoryRate,
  repairRate,
} from "./historicalSalesCostRepairEngine";
import { historicalSaleProposalFromState } from "./historicalSalesCostRepairEngineReplay";
import { compareMovementMutationAscending, movementKey } from "./historicalSalesCostRepairEvidence";
import type {
  HistoricalInventoryState,
  HistoricalSalesRepairMovement,
  HistoricalSalesRepairProposal,
} from "./historicalSalesCostRepairEngine";
import type { RepairCheck } from "./historicalSalesCostRepairTypes";
import type { historicalSalesCostRepairRewindStep } from "./historicalSalesCostRepairRewindStep";
import type { historicalSalesCostRepairRewindStep2 } from "./historicalSalesCostRepairRewindStep2";

export function historicalSalesCostRepairRewindStep3({
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
}: {
  hrw2: Extract<ReturnType<typeof historicalSalesCostRepairRewindStep2>, { done: false }>;
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
  movement: HistoricalSalesRepairMovement;
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
  targetLegacySaleMovementsByKey: {
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
  }["targetLegacySaleMovementsByKey"];
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
  hrw1: ReturnType<typeof historicalSalesCostRepairRewindStep>;
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
  movementsInCheckpoint: {
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
  }["movementsInCheckpoint"];
}) {
  const { reversed, stateAfter, key } = hrw2;
  const { rewindBoundaryReached } = hrw1;
  if (!reversed.reversible) {
    const priorRateHint = priorCostMemoryRateHints.get(movement.movementId) ?? null;
    checks.push({
      companyId,
      locationId: movement.locationId,
      stockItemId: movement.stockItemId,
      code: "REWIND_BOUNDARY_DIAGNOSTIC",
      status: "warning",
      expected:
        repairQuantity(stateAfter.quantity).toFixed(3) +
        "|" +
        repairRate(stateAfter.averageRate).toFixed(2) +
        "|" +
        repairMoney(stateAfter.totalValue).toFixed(2),
      actual:
        repairQuantity(movement.quantityDelta).toFixed(3) +
        "|" +
        (movement.unitCost == null ? "null" : String(movement.unitCost)) +
        "|" +
        (priorRateHint == null ? "null" : repairRate(priorRateHint).toFixed(2)),
      detail:
        "reason=" +
        reversed.reason +
        " boundary=" +
        movement.movementId +
        " sourceType=" +
        movement.sourceType +
        " evidence=" +
        movement.evidence +
        " stateAfter=qty|rate|value delta|unitCost|priorRateHint occurredAt=" +
        movement.occurredAt,
    });
    const unresolvedSales = (targetLegacySaleMovementsByKey.get(key) ?? []).filter(
      (saleMovement) =>
        compareMovementMutationAscending(saleMovement, movement) <= 0 &&
        !forwardResetProvenSaleIds.has(saleMovement.sale!.salesItemId)
    );
    rewindBoundaryReached.add(key);

    if (reversed.reason === "MOVEMENT_INVERSE_INVALID") {
      // V43: an impossible inverse proves the rewound state above this
      // movement inconsistent with the evidence below it, yet the legacy
      // sales between it and the checkpoint were already priced from that
      // state. The error is somewhere between the checkpoint and here, so
      // a sale's rewound cost is kept only when it is independent of where
      // the error lies: a priced receipt into exactly empty stock fixes
      // the state after it whatever came before, and a forward replay from
      // that state must reach the same cost for the sale. Otherwise the
      // sale is blocked.
      const pricedAbove = (targetLegacySaleMovementsByKey.get(key) ?? []).filter(
        (saleMovement) =>
          compareMovementMutationAscending(saleMovement, movement) > 0 &&
          proposalsBySaleId.has(saleMovement.sale!.salesItemId) &&
          !forwardResetProvenSaleIds.has(saleMovement.sale!.salesItemId)
      );
      if (pricedAbove.length > 0) {
        const delta = repairQuantity(movement.quantityDelta);
        const determined =
          delta.gt(0) &&
          movement.unitCost !== null &&
          movement.unitCost !== undefined &&
          !posJournalCostIsNotInventoryRate(movement) &&
          repairQuantity(stateAfter.quantity).minus(delta).isZero();
        const forwardCost = new Map<number, string>();
        if (determined) {
          let forward = applyHistoricalSalesRepairMovement(
            createHistoricalInventoryStateFromSnapshot("0", "0", "0"),
            movement
          );
          const later = movementsInCheckpoint
            .filter(
              (candidate) => movementKey(candidate) === key && compareMovementMutationAscending(candidate, movement) > 0
            )
            .sort(compareMovementMutationAscending);
          for (const laterMovement of later) {
            if (laterMovement.sale) {
              forwardCost.set(
                laterMovement.sale.salesItemId,
                historicalSaleProposalFromState(laterMovement, forward).proposedCostPrice
              );
            }
            forward = applyHistoricalSalesRepairMovement(forward, laterMovement);
          }
        }
        let agreed = 0;
        for (const saleMovement of pricedAbove) {
          const salesItemId = saleMovement.sale!.salesItemId;
          const rewound = proposalsBySaleId.get(salesItemId)!.proposedCostPrice;
          const forward = forwardCost.get(salesItemId);
          if (forward !== undefined && forward === rewound) {
            agreed += 1;
            continue;
          }
          checks.push({
            companyId,
            locationId: saleMovement.locationId,
            stockItemId: saleMovement.stockItemId,
            salesItemId,
            code: "CHECKPOINT_REWIND_CONTRADICTED_BELOW",
            status: "block",
            expected: rewound,
            actual: forward ?? "undetermined",
            detail: `Sales item ${salesItemId} was rewound from a state contradicted by ${movement.movementId} (${
              determined ? "forward replay from the empty-stock receipt disagrees" : "no fully determined state below"
            })`,
          });
        }
        checks.push({
          companyId,
          locationId: movement.locationId,
          stockItemId: movement.stockItemId,
          code: "REWIND_CONTRADICTION_TWO_SIDED",
          status: "warning",
          expected: String(pricedAbove.length),
          actual: String(agreed),
          detail: `${agreed} of ${pricedAbove.length} legacy sales above impossible inverse ${movement.movementId} have the same cost from the checkpoint rewind and from ${
            determined ? "a forward replay of the empty-stock receipt" : "no independent forward state"
          }`,
        });
      }
    }

    if (unresolvedSales.length === 0) {
      checks.push({
        companyId,
        locationId: movement.locationId,
        stockItemId: movement.stockItemId,
        code: "REWIND_RESET_BOUNDARY_REACHED",
        status: "pass",
        detail: `Stopped safely at ${movement.movementId} because no target historical sale exists before the irreversible valuation boundary`,
      });
      return { done: true as const, value: undefined };
    }

    for (const saleMovement of unresolvedSales) {
      checks.push({
        companyId,
        locationId: saleMovement.locationId,
        stockItemId: saleMovement.stockItemId,
        salesItemId: saleMovement.sale!.salesItemId,
        code: `${movement.evidence === "canonical" ? "CHECKPOINT" : "LEGACY"}_REWIND_${reversed.reason}`,
        status: "block",
        detail: `Sales item ${saleMovement.sale!.salesItemId} predates irreversible valuation boundary ${movement.movementId}`,
      });
    }
    return { done: true as const, value: undefined };
  }

  if (reversed.recovery === "CANONICAL_RATE_ONLY") {
    checks.push({
      companyId,
      locationId: movement.locationId,
      stockItemId: movement.stockItemId,
      code: "CANONICAL_REWIND_RATE_ONLY_RECOVERED",
      status: "pass",
      expected: repairQuantity(stateAfter.quantity).toFixed(3) + "|" + repairMoney(stateAfter.totalValue).toFixed(2),
      actual: repairQuantity(stateAfter.quantity).toFixed(3) + "|" + repairMoney(stateAfter.totalValue).toFixed(2),
      detail:
        "Canonical boundary " +
        movement.movementId +
        " recovered because forward replay reproduced quantity and total value exactly; only the reconstructed intermediate average-rate field disagreed. Prior rate=" +
        repairRate(reversed.stateBefore.averageRate).toFixed(2),
    });
  }

  if (reversed.recovery === "LEGACY_ISSUE_RATE_ONLY") {
    checks.push({
      companyId,
      locationId: movement.locationId,
      stockItemId: movement.stockItemId,
      code: "LEGACY_REWIND_RATE_ONLY_RECOVERED",
      status: "pass",
      expected: repairQuantity(stateAfter.quantity).toFixed(3) + "|" + repairMoney(stateAfter.totalValue).toFixed(2),
      actual: repairQuantity(stateAfter.quantity).toFixed(3) + "|" + repairMoney(stateAfter.totalValue).toFixed(2),
      detail:
        "Legacy sale boundary " +
        movement.movementId +
        " recovered from the unique self-consistent pre-issue rate because replay reproduced quantity and total value exactly; no ambiguous rate candidate was accepted. Prior rate=" +
        repairRate(reversed.stateBefore.averageRate).toFixed(2),
    });
  }

  if (reversed.recovery === "CANONICAL_RECORDED_ISSUE_RATE") {
    checks.push({
      companyId,
      locationId: movement.locationId,
      stockItemId: movement.stockItemId,
      code: "CANONICAL_RECORDED_SALE_RATE_RECOVERED",
      status: "pass",
      expected: repairRate(movement.unitCost ?? "0").toFixed(2),
      actual: repairRate(reversed.stateBefore.averageRate).toFixed(2),
      detail:
        "Canonical sale boundary " +
        movement.movementId +
        " used its recorded transaction-time issue rate because that rate replayed quantity and total value exactly and the generic inverse selected a conflicting rate.",
    });
  }

  if (reversed.recovery === "CANONICAL_ADJUSTMENT_EDIT_VALUE") {
    checks.push({
      companyId,
      locationId: movement.locationId,
      stockItemId: movement.stockItemId,
      code: "CANONICAL_ADJUSTMENT_EDIT_VALUE_RECOVERED",
      status: "pass",
      expected: repairQuantity(stateAfter.quantity).toFixed(3) + "|" + repairMoney(stateAfter.totalValue).toFixed(2),
      actual: repairQuantity(stateAfter.quantity).toFixed(3) + "|" + repairMoney(stateAfter.totalValue).toFixed(2),
      detail:
        "Canonical stock-adjustment edit apply boundary " +
        movement.movementId +
        " recovered by adding back its persisted line value and replaying the source-specific consumption semantics exactly. Prior rate=" +
        repairRate(reversed.stateBefore.averageRate).toFixed(2),
    });
  }

  return { done: false as const, reversed };
}
