// Extracted from ./historicalSalesCostRepairForwardReplay.ts: a stage of historicalSalesCostRepairForwardReplay.
import Decimal from "decimal.js";
import {
  applyHistoricalForwardReplayMovement,
  createHistoricalForwardReplayState,
  createHistoricalInventoryStateFromSnapshot,
  historicalInventoryKey,
  repairMoney,
  repairQuantity,
  repairRate,
  type HistoricalForwardReplayState,
  type HistoricalInventoryState,
  type HistoricalSalesRepairMovement,
  type HistoricalSalesRepairProposal,
} from "./historicalSalesCostRepairEngine";
import { historicalSaleProposalFromState } from "./historicalSalesCostRepairEngineReplay";
import { MONEY_TOLERANCE, QTY_TOLERANCE, d } from "./historicalSalesCostRepairTypes";
import { movementKey } from "./historicalSalesCostRepairEvidence";
import { historicalInventoryStatesEqual, stateForZeroOpening } from "./historicalSalesCostRepairRecovery";
import { historicalSalesCostRepairForwardReplayStep2 } from "./historicalSalesCostRepairForwardReplayStep2";
import type { RepairCheck, StockItemRow, ValuationCheckpoint } from "./historicalSalesCostRepairTypes";
import type { historicalSalesCostRepairForwardReplayStep } from "./historicalSalesCostRepairForwardReplayStep";

export function historicalSalesCostRepairForwardReplayStep3({
  hfr1,
  checkpoint,
  stockItemId,
  checkpointStates,
  companyId,
  checkpointTargetKeys,
  evidencedOpeningStates,
  checks,
}: {
  hfr1: Extract<ReturnType<typeof historicalSalesCostRepairForwardReplayStep>, { done: false }>;
  checkpoint: {
    companyId: number;
    checkpoint: ValuationCheckpoint;
    checks: RepairCheck[];
    proposalsBySaleId: Map<number, HistoricalSalesRepairProposal>;
    evidencedOpeningStates: Map<string, HistoricalInventoryState>;
    checkpointStates: Map<string, HistoricalInventoryState>;
    checkpointTargetKeys: Set<string>;
    normalizedMovementsAscending: HistoricalSalesRepairMovement[];
    fallbackMovementsInCheckpoint: HistoricalSalesRepairMovement[];
    legacyTransferFallbackItemIds: Set<number>;
    forwardReplayResolvedKeys: Set<string>;
    fallbackProvenItemIds: Set<number>;
    movementsAscending: HistoricalSalesRepairMovement[];
    stockItemById: Map<number, StockItemRow>;
    targetKeysByItem: Map<number, string[]>;
  }["checkpoint"];
  stockItemId: number;
  checkpointStates: {
    companyId: number;
    checkpoint: ValuationCheckpoint;
    checks: RepairCheck[];
    proposalsBySaleId: Map<number, HistoricalSalesRepairProposal>;
    evidencedOpeningStates: Map<string, HistoricalInventoryState>;
    checkpointStates: Map<string, HistoricalInventoryState>;
    checkpointTargetKeys: Set<string>;
    normalizedMovementsAscending: HistoricalSalesRepairMovement[];
    fallbackMovementsInCheckpoint: HistoricalSalesRepairMovement[];
    legacyTransferFallbackItemIds: Set<number>;
    forwardReplayResolvedKeys: Set<string>;
    fallbackProvenItemIds: Set<number>;
    movementsAscending: HistoricalSalesRepairMovement[];
    stockItemById: Map<number, StockItemRow>;
    targetKeysByItem: Map<number, string[]>;
  }["checkpointStates"];
  companyId: {
    companyId: number;
    checkpoint: ValuationCheckpoint;
    checks: RepairCheck[];
    proposalsBySaleId: Map<number, HistoricalSalesRepairProposal>;
    evidencedOpeningStates: Map<string, HistoricalInventoryState>;
    checkpointStates: Map<string, HistoricalInventoryState>;
    checkpointTargetKeys: Set<string>;
    normalizedMovementsAscending: HistoricalSalesRepairMovement[];
    fallbackMovementsInCheckpoint: HistoricalSalesRepairMovement[];
    legacyTransferFallbackItemIds: Set<number>;
    forwardReplayResolvedKeys: Set<string>;
    fallbackProvenItemIds: Set<number>;
    movementsAscending: HistoricalSalesRepairMovement[];
    stockItemById: Map<number, StockItemRow>;
    targetKeysByItem: Map<number, string[]>;
  }["companyId"];
  checkpointTargetKeys: {
    companyId: number;
    checkpoint: ValuationCheckpoint;
    checks: RepairCheck[];
    proposalsBySaleId: Map<number, HistoricalSalesRepairProposal>;
    evidencedOpeningStates: Map<string, HistoricalInventoryState>;
    checkpointStates: Map<string, HistoricalInventoryState>;
    checkpointTargetKeys: Set<string>;
    normalizedMovementsAscending: HistoricalSalesRepairMovement[];
    fallbackMovementsInCheckpoint: HistoricalSalesRepairMovement[];
    legacyTransferFallbackItemIds: Set<number>;
    forwardReplayResolvedKeys: Set<string>;
    fallbackProvenItemIds: Set<number>;
    movementsAscending: HistoricalSalesRepairMovement[];
    stockItemById: Map<number, StockItemRow>;
    targetKeysByItem: Map<number, string[]>;
  }["checkpointTargetKeys"];
  evidencedOpeningStates: {
    companyId: number;
    checkpoint: ValuationCheckpoint;
    checks: RepairCheck[];
    proposalsBySaleId: Map<number, HistoricalSalesRepairProposal>;
    evidencedOpeningStates: Map<string, HistoricalInventoryState>;
    checkpointStates: Map<string, HistoricalInventoryState>;
    checkpointTargetKeys: Set<string>;
    normalizedMovementsAscending: HistoricalSalesRepairMovement[];
    fallbackMovementsInCheckpoint: HistoricalSalesRepairMovement[];
    legacyTransferFallbackItemIds: Set<number>;
    forwardReplayResolvedKeys: Set<string>;
    fallbackProvenItemIds: Set<number>;
    movementsAscending: HistoricalSalesRepairMovement[];
    stockItemById: Map<number, StockItemRow>;
    targetKeysByItem: Map<number, string[]>;
  }["evidencedOpeningStates"];
  checks: {
    companyId: number;
    checkpoint: ValuationCheckpoint;
    checks: RepairCheck[];
    proposalsBySaleId: Map<number, HistoricalSalesRepairProposal>;
    evidencedOpeningStates: Map<string, HistoricalInventoryState>;
    checkpointStates: Map<string, HistoricalInventoryState>;
    checkpointTargetKeys: Set<string>;
    normalizedMovementsAscending: HistoricalSalesRepairMovement[];
    fallbackMovementsInCheckpoint: HistoricalSalesRepairMovement[];
    legacyTransferFallbackItemIds: Set<number>;
    forwardReplayResolvedKeys: Set<string>;
    fallbackProvenItemIds: Set<number>;
    movementsAscending: HistoricalSalesRepairMovement[];
    stockItemById: Map<number, StockItemRow>;
    targetKeysByItem: Map<number, string[]>;
  }["checks"];
}) {
  const { fallbackItemMovements, openingRate, itemMovements, normalizedItemMovements, openingQty } = hfr1;

  if (fallbackItemMovements.length > 0) {
    const hfr2 = historicalSalesCostRepairForwardReplayStep2({
      hfr1,
      checkpoint,
      stockItemId,
      checkpointStates,
      companyId,
    });
    const {
      fallbackOpeningStates,
      fallbackLocationIds,
      fallbackRawMovements,
      fallbackNormalizedMovements,
      fallbackNormalizedQuantityCompatible,
      fallbackOpeningTotal,
      fallbackOpeningProofBasis,
    } = hfr2;

    if (fallbackOpeningStates) {
      const replayFallbackToCheckpoint = (candidateMovements: HistoricalSalesRepairMovement[]) => {
        const replayStates = new Map<number, HistoricalForwardReplayState>();
        for (const [locationId, opening] of fallbackOpeningStates!) {
          replayStates.set(locationId, createHistoricalForwardReplayState(opening));
        }

        const replayProposals = new Map<number, HistoricalSalesRepairProposal>();
        let peakNegativeLayerQuantity = new Decimal(0);
        for (const movement of candidateMovements) {
          const current =
            replayStates.get(movement.locationId) ??
            createHistoricalForwardReplayState(stateForZeroOpening(openingRate));
          if (movement.sale && checkpointTargetKeys.has(movementKey(movement))) {
            replayProposals.set(
              movement.sale.salesItemId,
              historicalSaleProposalFromState(movement, current.inventory)
            );
          }
          const next = applyHistoricalForwardReplayMovement(current, movement);
          if (next.negativeLayerQuantity.gt(peakNegativeLayerQuantity)) {
            peakNegativeLayerQuantity = next.negativeLayerQuantity;
          }
          replayStates.set(movement.locationId, next);
        }

        let exact = true;
        let detail: string | null = null;
        for (const locationId of fallbackLocationIds) {
          const key = historicalInventoryKey(companyId, locationId, stockItemId);
          const actual = replayStates.get(locationId)?.inventory ?? stateForZeroOpening(openingRate);
          const expected = checkpointStates.get(key);
          if (expected) {
            if (!historicalInventoryStatesEqual(actual, expected)) {
              exact = false;
              detail =
                "location " +
                locationId +
                " expected " +
                repairQuantity(expected.quantity).toFixed(3) +
                "|" +
                repairRate(expected.averageRate).toFixed(2) +
                "|" +
                repairMoney(expected.totalValue).toFixed(2) +
                " actual " +
                repairQuantity(actual.quantity).toFixed(3) +
                "|" +
                repairRate(actual.averageRate).toFixed(2) +
                "|" +
                repairMoney(actual.totalValue).toFixed(2);
              break;
            }
          } else if (
            !repairQuantity(actual.quantity).isZero() ||
            repairMoney(actual.totalValue).abs().gt(MONEY_TOLERANCE)
          ) {
            exact = false;
            detail =
              "location " +
              locationId +
              " has no checkpoint row but replay ends " +
              repairQuantity(actual.quantity).toFixed(3) +
              "|" +
              repairRate(actual.averageRate).toFixed(2) +
              "|" +
              repairMoney(actual.totalValue).toFixed(2);
            break;
          }
        }
        return { exact, detail, replayProposals, peakNegativeLayerQuantity };
      };

      const fallbackRawReplay = replayFallbackToCheckpoint(fallbackRawMovements);
      let fallbackAcceptedReplay = fallbackRawReplay;
      let fallbackUsedNormalizedPos = false;
      const fallbackRawPosFingerprint = fallbackRawMovements
        .filter((movement) => movement.sourceType === "pos-sale")
        .map((movement) => `${movement.movementId}:${movement.quantityDelta}:${movement.unitCost ?? ""}`)
        .join("|");
      const fallbackNormalizedPosFingerprint = fallbackNormalizedMovements
        .filter((movement) => movement.sourceType === "pos-sale" || movement.sourceType === "pos-sale-normalized")
        .map((movement) => `${movement.movementId}:${movement.quantityDelta}:${movement.unitCost ?? ""}`)
        .join("|");

      if (
        !fallbackAcceptedReplay.exact &&
        fallbackNormalizedQuantityCompatible &&
        fallbackRawPosFingerprint !== fallbackNormalizedPosFingerprint
      ) {
        const normalizedFallbackReplay = replayFallbackToCheckpoint(fallbackNormalizedMovements);
        if (normalizedFallbackReplay.exact) {
          fallbackAcceptedReplay = normalizedFallbackReplay;
          fallbackUsedNormalizedPos = true;
        }
      }

      if (fallbackAcceptedReplay.exact) {
        hfr1.fallbackProofCandidate = {
          replay: fallbackAcceptedReplay,
          openingTotal: fallbackOpeningTotal,
          openingProofBasis: fallbackOpeningProofBasis,
          usedNormalizedPos: fallbackUsedNormalizedPos,
          movementCount: fallbackItemMovements.length,
        };
      }
    }
  }

  const locationIds = new Set<number>([
    ...checkpoint.rows.filter((row) => Number(row.stock_item_id) === stockItemId).map((row) => Number(row.location_id)),
    ...itemMovements.map((movement) => movement.locationId),
    ...normalizedItemMovements.map((movement) => movement.locationId),
  ]);
  if (locationIds.size === 0) return { done: true as const, value: undefined };

  const movementDeltaByLocation = new Map<number, Decimal>();
  for (const movement of itemMovements) {
    movementDeltaByLocation.set(
      movement.locationId,
      repairQuantity(
        (movementDeltaByLocation.get(movement.locationId) ?? new Decimal(0)).plus(d(movement.quantityDelta))
      )
    );
  }
  const normalizedMovementDeltaByLocation = new Map<number, Decimal>();
  for (const movement of normalizedItemMovements) {
    normalizedMovementDeltaByLocation.set(
      movement.locationId,
      repairQuantity(
        (normalizedMovementDeltaByLocation.get(movement.locationId) ?? new Decimal(0)).plus(d(movement.quantityDelta))
      )
    );
  }
  const normalizedQuantityCompatible = [...locationIds].every((locationId) =>
    (normalizedMovementDeltaByLocation.get(locationId) ?? new Decimal(0)).eq(
      movementDeltaByLocation.get(locationId) ?? new Decimal(0)
    )
  );
  const rawPosFingerprint = itemMovements
    .filter((movement) => movement.sourceType === "pos-sale")
    .map((movement) => `${movement.movementId}:${movement.quantityDelta}:${movement.unitCost ?? ""}`)
    .join("|");
  const normalizedPosFingerprint = normalizedItemMovements
    .filter((movement) => movement.sourceType === "pos-sale" || movement.sourceType === "pos-sale-normalized")
    .map((movement) => `${movement.movementId}:${movement.quantityDelta}:${movement.unitCost ?? ""}`)
    .join("|");
  const normalizedLifecycleChanged = rawPosFingerprint !== normalizedPosFingerprint;

  const inferredOpeningQtyByLocation = new Map<number, Decimal>();
  let inferredOpeningTotal = new Decimal(0);
  let hasNegativeInferredOpening = false;
  for (const locationId of locationIds) {
    const checkpointState = checkpointStates.get(historicalInventoryKey(companyId, locationId, stockItemId));
    let inferred = repairQuantity(
      (checkpointState?.quantity ?? new Decimal(0)).minus(movementDeltaByLocation.get(locationId) ?? new Decimal(0))
    );
    if (inferred.abs().lte(QTY_TOLERANCE)) inferred = new Decimal(0);
    if (inferred.lt(0)) hasNegativeInferredOpening = true;
    inferredOpeningQtyByLocation.set(locationId, inferred);
    inferredOpeningTotal = repairQuantity(inferredOpeningTotal.plus(inferred));
  }

  const pinnedOpeningQuantityMatches = inferredOpeningTotal.eq(openingQty);
  if (pinnedOpeningQuantityMatches && !hasNegativeInferredOpening && openingRate.gt(0)) {
    for (const [locationId, quantity] of inferredOpeningQtyByLocation) {
      if (!quantity.gt(0)) continue;
      evidencedOpeningStates.set(
        historicalInventoryKey(companyId, locationId, stockItemId),
        createHistoricalInventoryStateFromSnapshot(quantity, openingRate, repairMoney(quantity.times(openingRate)))
      );
    }
  }
  let openingProofBasis: "stock-opening" | "location-import-inferred" | "signed-location-import-inferred" =
    "stock-opening";

  if (hasNegativeInferredOpening) {
    checks.push({
      companyId,
      locationId: null,
      stockItemId,
      code: "OPENING_FORWARD_NEGATIVE_INFERRED_QTY",
      status: "warning",
      expected: openingQty.toFixed(3),
      actual: inferredOpeningTotal.toFixed(3),
      detail:
        "Checkpoint minus durable movement deltas implies a signed per-location opening. V15 will try the historical signed location-import shape only when a pinned nonzero opening rate exists, and will accept it only on an exact checkpoint replay.",
    });
    if (!openingRate.gt(0)) return { done: true as const, value: undefined };
    openingProofBasis = "signed-location-import-inferred";
  } else if (!pinnedOpeningQuantityMatches) {
    checks.push({
      companyId,
      locationId: null,
      stockItemId,
      code: "OPENING_FORWARD_QTY_MISMATCH",
      status: "warning",
      expected: openingQty.toFixed(3),
      actual: inferredOpeningTotal.toFixed(3),
      detail:
        "Item-level opening quantity differs from checkpoint-implied location opening. The repair will try the historical location-import shape only when a pinned nonzero opening rate exists, and will accept it only on an exact checkpoint replay.",
    });
    if (!openingRate.gt(0)) return { done: true as const, value: undefined };
    openingProofBasis = "location-import-inferred";
  }

  const positiveOpeningLocations = [...inferredOpeningQtyByLocation.entries()].filter(([, quantity]) => quantity.gt(0));
  const openingStates = new Map<number, HistoricalInventoryState>();

  return {
    done: false as const,
    locationIds,
    normalizedQuantityCompatible,
    normalizedLifecycleChanged,
    inferredOpeningQtyByLocation,
    inferredOpeningTotal,
    openingProofBasis,
    positiveOpeningLocations,
    openingStates,
  };
}
