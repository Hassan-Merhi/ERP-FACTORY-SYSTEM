// Extracted from ./historicalSalesCostRepairForwardReplay.ts: a stage of historicalSalesCostRepairForwardReplay.
import Decimal from "decimal.js";
import {
  repairMoney,
  repairQuantity,
  repairRate,
  type HistoricalSalesRepairProposal,
} from "./historicalSalesCostRepairEngine";
import type { HistoricalInventoryState, HistoricalSalesRepairMovement } from "./historicalSalesCostRepairEngine";
import type { RepairCheck, StockItemRow, ValuationCheckpoint } from "./historicalSalesCostRepairTypes";

export type FallbackProofCandidate = {
  replay: {
    exact: boolean;
    detail: string | null;
    replayProposals: Map<number, HistoricalSalesRepairProposal>;
    peakNegativeLayerQuantity: Decimal;
  };
  openingTotal: Decimal;
  openingProofBasis: "stock-opening" | "location-import-inferred" | "signed-location-import-inferred";
  usedNormalizedPos: boolean;
  movementCount: number;
};

export function historicalSalesCostRepairForwardReplayStep({
  stockItemById,
  stockItemId,
  checks,
  itemTargetKeys,
  companyId,
  movementsAscending,
  normalizedMovementsAscending,
  fallbackMovementsInCheckpoint,
}: {
  stockItemById: {
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
  }["stockItemById"];
  stockItemId: number;
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
  itemTargetKeys: string[];
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
  movementsAscending: {
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
  }["movementsAscending"];
  normalizedMovementsAscending: {
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
  }["normalizedMovementsAscending"];
  fallbackMovementsInCheckpoint: {
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
  }["fallbackMovementsInCheckpoint"];
}) {
  const stockItem = stockItemById.get(stockItemId);
  if (!stockItem) return { done: true as const, value: undefined };

  const hasPreexistingEvidenceBlock = checks.some(
    (check) =>
      check.status === "block" &&
      check.stockItemId === stockItemId &&
      (check.locationId === null || itemTargetKeys.some((key) => Number(key.split(":")[1]) === check.locationId))
  );
  if (hasPreexistingEvidenceBlock) {
    checks.push({
      companyId,
      locationId: null,
      stockItemId,
      code: "OPENING_FORWARD_SKIPPED_PREEXISTING_BLOCK",
      status: "warning",
      detail: "Opening forward proof was skipped because independent evidence already blocks this stock item.",
    });
    return { done: true as const, value: undefined };
  }

  const itemMovements = movementsAscending.filter((movement) => movement.stockItemId === stockItemId);
  const normalizedItemMovements = normalizedMovementsAscending.filter(
    (movement) => movement.stockItemId === stockItemId
  );
  const openingQty = repairQuantity(stockItem.opening_qty);
  const openingRate = repairRate(stockItem.opening_rate);
  const openingValue = repairMoney(stockItem.opening_value);
  const fallbackItemMovements = fallbackMovementsInCheckpoint.filter(
    (movement) => movement.stockItemId === stockItemId
  );
  const fallbackProofCandidate = null as FallbackProofCandidate | null;

  return {
    done: false as const,
    itemMovements,
    normalizedItemMovements,
    openingQty,
    openingRate,
    openingValue,
    fallbackItemMovements,
    fallbackProofCandidate,
  };
}
