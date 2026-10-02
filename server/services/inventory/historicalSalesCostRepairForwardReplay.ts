/** Opening-balance forward replay proof for the historical sales-cost repair dry run. */
import Decimal from "decimal.js";

import {
  applyHistoricalForwardReplayMovement,
  createHistoricalForwardReplayState,
  createHistoricalInventoryStateFromSnapshot,
  createHistoricalSignedLocationImportState,
  historicalInventoryKey,
  historicalSaleProposalFromState,
  repairMoney,
  repairQuantity,
  repairRate,
  type HistoricalForwardReplayState,
  type HistoricalInventoryState,
  type HistoricalSalesRepairMovement,
  type HistoricalSalesRepairProposal,
} from "./historicalSalesCostRepairEngine";
import {
  MONEY_TOLERANCE,
  QTY_TOLERANCE,
  RepairCheck,
  StockItemRow,
  ValuationCheckpoint,
  d,
} from "./historicalSalesCostRepairTypes";
import { compareMovementMutationAscending, movementKey } from "./historicalSalesCostRepairEvidence";
import { historicalInventoryStatesEqual, stateForZeroOpening } from "./historicalSalesCostRepairRecovery";

/** Proves legacy sales by replaying each stock item forward from its pinned opening balance to the checkpoint. */
export function proveOpeningForwardReplay({
  companyId,
  checkpoint,
  checks,
  proposalsBySaleId,
  evidencedOpeningStates,
  checkpointStates,
  checkpointTargetKeys,
  normalizedMovementsAscending,
  fallbackMovementsInCheckpoint,
  legacyTransferFallbackItemIds,
  forwardReplayResolvedKeys,
  fallbackProvenItemIds,
  movementsAscending,
  stockItemById,
  targetKeysByItem,
}: {
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
}): void {
  for (const [stockItemId, itemTargetKeys] of targetKeysByItem) {
    const stockItem = stockItemById.get(stockItemId);
    if (!stockItem) continue;

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
      continue;
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
    let fallbackProofCandidate: {
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
    } | null = null;

    if (fallbackItemMovements.length > 0) {
      const fallbackRawMovements = [...itemMovements, ...fallbackItemMovements].sort(compareMovementMutationAscending);
      const fallbackNormalizedMovements = [...normalizedItemMovements, ...fallbackItemMovements].sort(
        compareMovementMutationAscending
      );
      const fallbackLocationIds = new Set<number>([
        ...checkpoint.rows
          .filter((row) => Number(row.stock_item_id) === stockItemId)
          .map((row) => Number(row.location_id)),
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
            (normalizedFallbackDeltaByLocation.get(movement.locationId) ?? new Decimal(0)).plus(
              d(movement.quantityDelta)
            )
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
          (checkpointState?.quantity ?? new Decimal(0)).minus(
            rawFallbackDeltaByLocation.get(locationId) ?? new Decimal(0)
          )
        );
        if (inferred.abs().lte(QTY_TOLERANCE)) inferred = new Decimal(0);
        if (inferred.lt(0)) fallbackHasNegativeOpening = true;
        fallbackOpeningQtyByLocation.set(locationId, inferred);
        fallbackOpeningTotal = repairQuantity(fallbackOpeningTotal.plus(inferred));
      }

      let fallbackOpeningProofBasis: "stock-opening" | "location-import-inferred" | "signed-location-import-inferred" =
        "stock-opening";
      let fallbackOpeningStates: Map<number, HistoricalInventoryState> | null = new Map<
        number,
        HistoricalInventoryState
      >();

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
            fallbackOpeningStates.set(
              locationId,
              createHistoricalInventoryStateFromSnapshot(quantity, openingRate, value)
            );
            allocatedValue = repairMoney(allocatedValue.plus(value));
          }
          if (!allocatedValue.eq(openingValue)) fallbackOpeningStates = null;
        }
      }

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
          fallbackProofCandidate = {
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
      ...checkpoint.rows
        .filter((row) => Number(row.stock_item_id) === stockItemId)
        .map((row) => Number(row.location_id)),
      ...itemMovements.map((movement) => movement.locationId),
      ...normalizedItemMovements.map((movement) => movement.locationId),
    ]);
    if (locationIds.size === 0) continue;

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
      if (!openingRate.gt(0)) continue;
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
      if (!openingRate.gt(0)) continue;
      openingProofBasis = "location-import-inferred";
    }

    const positiveOpeningLocations = [...inferredOpeningQtyByLocation.entries()].filter(([, quantity]) =>
      quantity.gt(0)
    );
    const openingStates = new Map<number, HistoricalInventoryState>();

    if (openingProofBasis === "signed-location-import-inferred") {
      // The historical location-import route accepted signed quantities and
      // defaulted value to quantity × rate before writing the inventory row
      // directly. Preserve that exact signed shape as a candidate. The
      // candidate remains untrusted unless the complete historical replay
      // reproduces the immutable checkpoint quantity, rate and value.
      for (const [locationId, quantity] of inferredOpeningQtyByLocation) {
        openingStates.set(locationId, createHistoricalSignedLocationImportState(quantity, openingRate));
      }
    } else if (openingProofBasis === "location-import-inferred") {
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
        continue;
      }
      for (const locationId of locationIds) {
        openingStates.set(locationId, stateForZeroOpening(openingRate));
      }
    } else if (positiveOpeningLocations.length === 1) {
      const [openingLocationId, locationQty] = positiveOpeningLocations[0];
      if (!locationQty.eq(openingQty)) continue;
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
        continue;
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
            replayProposals.set(
              movement.sale.salesItemId,
              historicalSaleProposalFromState(movement, current.inventory)
            );
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
        inferredOpeningTotal = fallbackProofCandidate.openingTotal;
        openingProofBasis = fallbackProofCandidate.openingProofBasis;
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
            rawReplay.detail ??
            normalizedReplay?.detail ??
            "Forward replay did not reproduce the immutable checkpoint.",
        });
        continue;
      }
    }

    if (openingProofBasis === "signed-location-import-inferred") {
      checks.push({
        companyId,
        locationId: null,
        stockItemId,
        code: "OPENING_FORWARD_SIGNED_LOCATION_IMPORT_RECONCILED",
        status: "pass",
        expected: openingQty.toFixed(3) + "@" + openingRate.toFixed(2),
        actual: inferredOpeningTotal.toFixed(3) + "@" + openingRate.toFixed(2),
        detail:
          "Checkpoint-implied signed per-location openings seeded at the separately pinned item rate replay exactly to the immutable Phase 3 checkpoint, consistent with the historical signed location-inventory import path.",
      });
    }

    if (openingProofBasis === "location-import-inferred") {
      checks.push({
        companyId,
        locationId: null,
        stockItemId,
        code: "OPENING_FORWARD_LOCATION_IMPORT_RECONCILED",
        status: "pass",
        expected: openingQty.toFixed(3) + "@" + openingRate.toFixed(2),
        actual: inferredOpeningTotal.toFixed(3) + "@" + openingRate.toFixed(2),
        detail:
          "Checkpoint-implied per-location opening quantities seeded at the separately pinned item opening rate replay exactly to the immutable Phase 3 checkpoint, consistent with the historical direct location-inventory import path.",
      });
    }

    if (acceptedReplay.peakNegativeLayerQuantity.gt(0)) {
      checks.push({
        companyId,
        locationId: null,
        stockItemId,
        code: "OPENING_FORWARD_EPOCH_LAYER_REPLAY",
        status: "pass",
        actual: acceptedReplay.peakNegativeLayerQuantity.toFixed(3),
        detail:
          "Forward proof reproduced the checkpoint while simulating the historical negative-layer engine and its production epoch boundaries.",
      });
    }

    if (proofMode === "normalized-pos-lifecycle") {
      checks.push({
        companyId,
        locationId: null,
        stockItemId,
        code: "OPENING_FORWARD_POS_LIFECYCLE_NORMALIZED",
        status: "pass",
        detail:
          "Raw POS edit/delete valuation history missed the checkpoint, but the final-active-sale normalization reproduced the immutable Phase 3 checkpoint exactly.",
      });
    }

    for (const key of itemTargetKeys) {
      forwardReplayResolvedKeys.add(key);
      const locationId = Number(key.split(":")[1]);
      checks.push({
        companyId,
        locationId,
        stockItemId,
        code: "OPENING_FORWARD_REPLAY_PROVEN",
        status: "pass",
        expected: openingQty.toFixed(3) + "|" + openingValue.toFixed(2),
        actual:
          inferredOpeningTotal.toFixed(3) +
          "|" +
          (openingProofBasis === "location-import-inferred" || openingProofBasis === "signed-location-import-inferred"
            ? repairMoney(inferredOpeningTotal.times(openingRate)).toFixed(2)
            : openingValue.toFixed(2)),
        detail:
          openingProofBasis === "signed-location-import-inferred"
            ? "Checkpoint-implied signed location openings at the pinned item rate and all durable movements replay exactly to the immutable Phase 3 checkpoint"
            : openingProofBasis === "location-import-inferred"
              ? "Checkpoint-implied location openings at the pinned item rate and all durable movements replay exactly to the immutable Phase 3 checkpoint"
              : proofMode === "normalized-pos-lifecycle"
                ? "Pinned stock opening balance and normalized final POS lifecycle replay exactly to the immutable Phase 3 checkpoint"
                : "Pinned stock opening balance and all durable movements replay exactly to the immutable Phase 3 checkpoint",
      });
    }
    for (const proposal of acceptedReplay.replayProposals.values()) {
      proposalsBySaleId.set(proposal.salesItemId, proposal);
    }
  }

  for (const stockItemId of legacyTransferFallbackItemIds) {
    const itemKeys = targetKeysByItem.get(stockItemId) ?? [];
    if (itemKeys.length === 0 || fallbackProvenItemIds.has(stockItemId)) continue;
    checks.push({
      companyId,
      locationId: null,
      stockItemId,
      code: "LEGACY_TRANSFER_FLAG_FALLBACK_IGNORED",
      status: "warning",
      actual: String(itemKeys.length),
      detail:
        "False inventory_applied legacy transfer rows did not reproduce the immutable checkpoint, so V17 ignores them and retains the trusted V15 movement history for this item.",
    });
  }
}
