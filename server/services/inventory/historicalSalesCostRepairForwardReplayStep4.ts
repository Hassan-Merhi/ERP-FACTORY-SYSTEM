// Extracted from ./historicalSalesCostRepairForwardReplay.ts: a stage of historicalSalesCostRepairForwardReplay.
import Decimal from "decimal.js";
import {
  applyHistoricalForwardReplayMovement,
  createHistoricalForwardReplayState,
  createHistoricalInventoryStateFromSnapshot,
  createHistoricalSignedLocationImportState,
  historicalInventoryKey,
  repairMoney,
  repairQuantity,
  repairRate,
  type HistoricalForwardReplayState,
  type HistoricalSalesRepairMovement,
  type HistoricalSalesRepairProposal,
} from "./historicalSalesCostRepairEngine";
import { historicalSaleProposalFromState } from "./historicalSalesCostRepairEngineReplay";
import { MONEY_TOLERANCE } from "./historicalSalesCostRepairTypes";
import { movementKey } from "./historicalSalesCostRepairEvidence";
import { historicalInventoryStatesEqual, stateForZeroOpening } from "./historicalSalesCostRepairRecovery";
import type { HistoricalInventoryState } from "./historicalSalesCostRepairEngine";
import type { RepairCheck, StockItemRow, ValuationCheckpoint } from "./historicalSalesCostRepairTypes";
import type { historicalSalesCostRepairForwardReplayStep } from "./historicalSalesCostRepairForwardReplayStep";
import type { historicalSalesCostRepairForwardReplayStep3 } from "./historicalSalesCostRepairForwardReplayStep3";

export function historicalSalesCostRepairForwardReplayStep4({
  hfr3,
  hfr1,
  checks,
  companyId,
  stockItemId,
  checkpointTargetKeys,
  checkpointStates,
  fallbackProvenItemIds,
}: {
  hfr3: Extract<ReturnType<typeof historicalSalesCostRepairForwardReplayStep3>, { done: false }>;
  hfr1: Extract<ReturnType<typeof historicalSalesCostRepairForwardReplayStep>, { done: false }>;
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
  stockItemId: number;
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
  fallbackProvenItemIds: {
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
  }["fallbackProvenItemIds"];
}) {
  const {
    inferredOpeningQtyByLocation,
    openingStates,
    locationIds,
    positiveOpeningLocations,
    normalizedQuantityCompatible,
    normalizedLifecycleChanged,
  } = hfr3;
  const { openingRate, openingQty, openingValue, itemMovements, normalizedItemMovements, fallbackProofCandidate } =
    hfr1;

  if (hfr3.openingProofBasis === "signed-location-import-inferred") {
    // The historical location-import route accepted signed quantities and
    // defaulted value to quantity × rate before writing the inventory row
    // directly. Preserve that exact signed shape as a candidate. The
    // candidate remains untrusted unless the complete historical replay
    // reproduces the immutable checkpoint quantity, rate and value.
    for (const [locationId, quantity] of inferredOpeningQtyByLocation) {
      openingStates.set(locationId, createHistoricalSignedLocationImportState(quantity, openingRate));
    }
  } else if (hfr3.openingProofBasis === "location-import-inferred") {
    // Historical /api/locations/:locationId/import-inventory writes location
    // quantity/value directly and does not update the item-level frozen
    // opening quantity. Reconstruct those per-location quantities from the
    // immutable checkpoint and durable net movement, but keep the separately
    // pinned item opening rate as the independent cost anchor. This remains a
    // candidate until the full quantity/rate/value replay matches exactly.
    for (const [locationId, quantity] of inferredOpeningQtyByLocation) {
      if (quantity.gt(0)) {
        const value = repairMoney(quantity.times(openingRate));
        openingStates.set(locationId, createHistoricalInventoryStateFromSnapshot(quantity, openingRate, value));
      } else {
        openingStates.set(locationId, stateForZeroOpening(openingRate));
      }
    }
  } else if (openingQty.isZero()) {
    if (openingValue.abs().gt(MONEY_TOLERANCE)) {
      checks.push({
        companyId,
        locationId: null,
        stockItemId,
        code: "OPENING_FORWARD_ZERO_QTY_VALUE_MISMATCH",
        status: "warning",
        expected: "0.00",
        actual: openingValue.toFixed(2),
        detail: "Pinned opening quantity is zero but pinned opening value is nonzero.",
      });
      return { done: true as const, value: undefined };
    }
    for (const locationId of locationIds) {
      openingStates.set(locationId, stateForZeroOpening(openingRate));
    }
  } else if (positiveOpeningLocations.length === 1) {
    const [openingLocationId, locationQty] = positiveOpeningLocations[0];
    if (!locationQty.eq(openingQty)) return { done: true as const, value: undefined };
    for (const locationId of locationIds) {
      openingStates.set(
        locationId,
        locationId === openingLocationId
          ? createHistoricalInventoryStateFromSnapshot(locationQty, openingRate, openingValue)
          : stateForZeroOpening(openingRate)
      );
    }
  } else {
    let allocatedValue = new Decimal(0);
    for (const [locationId, quantity] of inferredOpeningQtyByLocation) {
      const value = repairMoney(quantity.times(openingRate));
      openingStates.set(locationId, createHistoricalInventoryStateFromSnapshot(quantity, openingRate, value));
      allocatedValue = repairMoney(allocatedValue.plus(value));
    }
    if (!allocatedValue.eq(openingValue)) {
      checks.push({
        companyId,
        locationId: null,
        stockItemId,
        code: "OPENING_FORWARD_VALUE_ALLOCATION_MISMATCH",
        status: "warning",
        expected: openingValue.toFixed(2),
        actual: allocatedValue.toFixed(2),
        detail:
          "Multiple inferred opening locations cannot reproduce the pinned opening value at the pinned opening rate.",
      });
      return { done: true as const, value: undefined };
    }
  }

  const replayToCheckpoint = (candidateMovements: HistoricalSalesRepairMovement[]) => {
    const replayStates = new Map<number, HistoricalForwardReplayState>();
    for (const [locationId, opening] of openingStates) {
      replayStates.set(locationId, createHistoricalForwardReplayState(opening));
    }

    const replayProposals = new Map<number, HistoricalSalesRepairProposal>();
    let peakNegativeLayerQuantity = new Decimal(0);
    for (const movement of candidateMovements) {
      const current =
        replayStates.get(movement.locationId) ?? createHistoricalForwardReplayState(stateForZeroOpening(openingRate));
      if (movement.sale) {
        const key = movementKey(movement);
        if (checkpointTargetKeys.has(key)) {
          replayProposals.set(movement.sale.salesItemId, historicalSaleProposalFromState(movement, current.inventory));
        }
      }
      const next = applyHistoricalForwardReplayMovement(current, movement);
      if (next.negativeLayerQuantity.gt(peakNegativeLayerQuantity)) {
        peakNegativeLayerQuantity = next.negativeLayerQuantity;
      }
      replayStates.set(movement.locationId, next);
    }

    let exact = true;
    let detail: string | null = null;
    for (const locationId of locationIds) {
      const key = historicalInventoryKey(companyId, locationId, stockItemId);
      const actualReplay =
        replayStates.get(locationId) ?? createHistoricalForwardReplayState(stateForZeroOpening(openingRate));
      const actual = actualReplay.inventory;
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
            repairMoney(actual.totalValue).toFixed(2) +
            " peakLayerQty " +
            peakNegativeLayerQuantity.toFixed(3);
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
          repairMoney(actual.totalValue).toFixed(2) +
          " peakLayerQty " +
          peakNegativeLayerQuantity.toFixed(3);
        break;
      }
    }

    return { exact, detail, replayProposals, peakNegativeLayerQuantity };
  };

  const rawReplay = replayToCheckpoint(itemMovements);
  let acceptedReplay = rawReplay;
  let proofMode: "raw" | "normalized-pos-lifecycle" = "raw";
  let normalizedReplay: ReturnType<typeof replayToCheckpoint> | undefined;

  if (!rawReplay.exact && normalizedQuantityCompatible && normalizedLifecycleChanged) {
    normalizedReplay = replayToCheckpoint(normalizedItemMovements);
    if (normalizedReplay.exact) {
      acceptedReplay = normalizedReplay;
      proofMode = "normalized-pos-lifecycle";
    }
  }

  if (!acceptedReplay.exact) {
    if (fallbackProofCandidate) {
      acceptedReplay = fallbackProofCandidate.replay;
      hfr3.inferredOpeningTotal = fallbackProofCandidate.openingTotal;
      hfr3.openingProofBasis = fallbackProofCandidate.openingProofBasis;
      proofMode = fallbackProofCandidate.usedNormalizedPos ? "normalized-pos-lifecycle" : "raw";
      fallbackProvenItemIds.add(stockItemId);
      checks.push({
        companyId,
        locationId: null,
        stockItemId,
        code: "LEGACY_TRANSFER_FLAG_FALLBACK_REPLAY_PROVEN",
        status: "pass",
        actual: String(fallbackProofCandidate.movementCount),
        detail:
          "Trusted V15 replay failed, but adding the false inventory_applied legacy transfer rows reproduced the immutable Phase 3 checkpoint exactly; only this proven item history uses the fallback.",
      });
    } else {
      checks.push({
        companyId,
        locationId: null,
        stockItemId,
        code: "OPENING_FORWARD_CHECKPOINT_MISMATCH",
        status: "warning",
        detail:
          rawReplay.detail ?? normalizedReplay?.detail ?? "Forward replay did not reproduce the immutable checkpoint.",
      });
      return { done: true as const, value: undefined };
    }
  }

  if (hfr3.openingProofBasis === "signed-location-import-inferred") {
    checks.push({
      companyId,
      locationId: null,
      stockItemId,
      code: "OPENING_FORWARD_SIGNED_LOCATION_IMPORT_RECONCILED",
      status: "pass",
      expected: openingQty.toFixed(3) + "@" + openingRate.toFixed(2),
      actual: hfr3.inferredOpeningTotal.toFixed(3) + "@" + openingRate.toFixed(2),
      detail:
        "Checkpoint-implied signed per-location openings seeded at the separately pinned item rate replay exactly to the immutable Phase 3 checkpoint, consistent with the historical signed location-inventory import path.",
    });
  }

  return { done: false as const, acceptedReplay, proofMode };
}
