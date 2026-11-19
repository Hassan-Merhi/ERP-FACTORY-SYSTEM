// Extracted from ./historicalSalesCostRepairForwardReplay.ts: a stage of historicalSalesCostRepairForwardReplay.
import Decimal from "decimal.js";
import {
  createHistoricalInventoryStateFromSnapshot,
  createHistoricalSignedLocationImportState,
  historicalInventoryKey,
  repairMoney,
  repairQuantity,
  type HistoricalInventoryState,
} from "./historicalSalesCostRepairEngine";
import { MONEY_TOLERANCE, QTY_TOLERANCE, d } from "./historicalSalesCostRepairTypes";
import { compareMovementMutationAscending } from "./historicalSalesCostRepairEvidence";
import { stateForZeroOpening } from "./historicalSalesCostRepairRecovery";
import type { HistoricalSalesRepairMovement, HistoricalSalesRepairProposal } from "./historicalSalesCostRepairEngine";
import type { RepairCheck, StockItemRow, ValuationCheckpoint } from "./historicalSalesCostRepairTypes";
import type { historicalSalesCostRepairForwardReplayStep } from "./historicalSalesCostRepairForwardReplayStep";

export function historicalSalesCostRepairForwardReplayStep2({
  hfr1,
  checkpoint,
  stockItemId,
  checkpointStates,
  companyId,
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
}) {
  const { itemMovements, fallbackItemMovements, normalizedItemMovements, openingRate, openingQty, openingValue } = hfr1;
  const fallbackRawMovements = [...itemMovements, ...fallbackItemMovements].sort(compareMovementMutationAscending);
  const fallbackNormalizedMovements = [...normalizedItemMovements, ...fallbackItemMovements].sort(
    compareMovementMutationAscending
  );
  const fallbackLocationIds = new Set<number>([
    ...checkpoint.rows.filter((row) => Number(row.stock_item_id) === stockItemId).map((row) => Number(row.location_id)),
    ...fallbackRawMovements.map((movement) => movement.locationId),
    ...fallbackNormalizedMovements.map((movement) => movement.locationId),
  ]);

  const rawFallbackDeltaByLocation = new Map<number, Decimal>();
  for (const movement of fallbackRawMovements) {
    rawFallbackDeltaByLocation.set(
      movement.locationId,
      repairQuantity(
        (rawFallbackDeltaByLocation.get(movement.locationId) ?? new Decimal(0)).plus(d(movement.quantityDelta))
      )
    );
  }
  const normalizedFallbackDeltaByLocation = new Map<number, Decimal>();
  for (const movement of fallbackNormalizedMovements) {
    normalizedFallbackDeltaByLocation.set(
      movement.locationId,
      repairQuantity(
        (normalizedFallbackDeltaByLocation.get(movement.locationId) ?? new Decimal(0)).plus(d(movement.quantityDelta))
      )
    );
  }
  const fallbackNormalizedQuantityCompatible = [...fallbackLocationIds].every((locationId) =>
    (normalizedFallbackDeltaByLocation.get(locationId) ?? new Decimal(0)).eq(
      rawFallbackDeltaByLocation.get(locationId) ?? new Decimal(0)
    )
  );

  const fallbackOpeningQtyByLocation = new Map<number, Decimal>();
  let fallbackOpeningTotal = new Decimal(0);
  let fallbackHasNegativeOpening = false;
  for (const locationId of fallbackLocationIds) {
    const checkpointState = checkpointStates.get(historicalInventoryKey(companyId, locationId, stockItemId));
    let inferred = repairQuantity(
      (checkpointState?.quantity ?? new Decimal(0)).minus(rawFallbackDeltaByLocation.get(locationId) ?? new Decimal(0))
    );
    if (inferred.abs().lte(QTY_TOLERANCE)) inferred = new Decimal(0);
    if (inferred.lt(0)) fallbackHasNegativeOpening = true;
    fallbackOpeningQtyByLocation.set(locationId, inferred);
    fallbackOpeningTotal = repairQuantity(fallbackOpeningTotal.plus(inferred));
  }

  let fallbackOpeningProofBasis: "stock-opening" | "location-import-inferred" | "signed-location-import-inferred" =
    "stock-opening";
  let fallbackOpeningStates: Map<number, HistoricalInventoryState> | null = new Map<number, HistoricalInventoryState>();

  if (fallbackHasNegativeOpening) {
    if (!openingRate.gt(0)) {
      fallbackOpeningStates = null;
    } else {
      fallbackOpeningProofBasis = "signed-location-import-inferred";
      for (const [locationId, quantity] of fallbackOpeningQtyByLocation) {
        fallbackOpeningStates.set(locationId, createHistoricalSignedLocationImportState(quantity, openingRate));
      }
    }
  } else if (!fallbackOpeningTotal.eq(openingQty)) {
    if (!openingRate.gt(0)) {
      fallbackOpeningStates = null;
    } else {
      fallbackOpeningProofBasis = "location-import-inferred";
      for (const [locationId, quantity] of fallbackOpeningQtyByLocation) {
        fallbackOpeningStates.set(
          locationId,
          quantity.gt(0)
            ? createHistoricalInventoryStateFromSnapshot(
                quantity,
                openingRate,
                repairMoney(quantity.times(openingRate))
              )
            : stateForZeroOpening(openingRate)
        );
      }
    }
  } else if (openingQty.isZero()) {
    if (openingValue.abs().gt(MONEY_TOLERANCE)) {
      fallbackOpeningStates = null;
    } else {
      for (const locationId of fallbackLocationIds) {
        fallbackOpeningStates.set(locationId, stateForZeroOpening(openingRate));
      }
    }
  } else {
    const positiveLocations = [...fallbackOpeningQtyByLocation.entries()].filter(([, quantity]) => quantity.gt(0));
    if (positiveLocations.length === 1 && positiveLocations[0][1].eq(openingQty)) {
      const openingLocationId = positiveLocations[0][0];
      for (const locationId of fallbackLocationIds) {
        fallbackOpeningStates.set(
          locationId,
          locationId === openingLocationId
            ? createHistoricalInventoryStateFromSnapshot(openingQty, openingRate, openingValue)
            : stateForZeroOpening(openingRate)
        );
      }
    } else {
      let allocatedValue = new Decimal(0);
      for (const [locationId, quantity] of fallbackOpeningQtyByLocation) {
        const value = repairMoney(quantity.times(openingRate));
        fallbackOpeningStates.set(locationId, createHistoricalInventoryStateFromSnapshot(quantity, openingRate, value));
        allocatedValue = repairMoney(allocatedValue.plus(value));
      }
      if (!allocatedValue.eq(openingValue)) fallbackOpeningStates = null;
    }
  }

  return {
    fallbackRawMovements,
    fallbackNormalizedMovements,
    fallbackLocationIds,
    fallbackNormalizedQuantityCompatible,
    fallbackOpeningTotal,
    fallbackOpeningProofBasis,
    fallbackOpeningStates,
  };
}
