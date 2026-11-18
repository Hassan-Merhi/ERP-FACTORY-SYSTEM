// Extracted from ./historicalSalesCostRepairDryRun.ts to keep that module under the source-size cap.
import {
  applyHistoricalSalesRepairMovement,
  createHistoricalInventoryStateFromSnapshot,
  historicalInventoryKey,
  type HistoricalInventoryState,
  type HistoricalSalesRepairMovement,
  repairMoney,
  repairQuantity,
} from "./historicalSalesCostRepairEngine";
import { InventoryRow, MONEY_TOLERANCE, QTY_TOLERANCE } from "./historicalSalesCostRepairTypes";
import {
  buildPriorCanonicalCostMemoryRateHints,
  canonicalMovementNumericId,
  compareMovementMutationAscending,
  compareMovementMutationDescending,
  movementKey,
  movementMutationTime,
  originalProposalForSale,
} from "./historicalSalesCostRepairEvidence";
import { recoverHistoricalMergedSales } from "./historicalSalesCostRepairRecovery";
import { proveOpeningForwardReplay } from "./historicalSalesCostRepairForwardReplay";
import { proveForwardCostMemoryResets, resolveRewindBranchesAndReanchor } from "./historicalSalesCostRepairReanchor";
import { rewindCheckpointToLegacySales } from "./historicalSalesCostRepairRewind";
import { proveClosedZeroStockEras, reportCheckpointRewindCoverage } from "./historicalSalesCostRepairEras";
import { dryRunCompanyStep1 } from "./historicalSalesCostRepairDryRunDryRunCompanyStep1";

export function dryRunCompanyStep2(
  {
    canonicalForReplay,
    checkpoint,
    checks,
    closedEraProvenSaleIds,
    evidencedOpeningStates,
    historicalMerges,
    inventoryResult,
    legacyMovements,
    legacySales,
    legacyTransferFallbackMovements,
    normalizedCanonicalPosReplay,
    proposalsBySaleId,
    stockItems,
    targetKeys,
    traceRewind,
  }: Pick<
    Awaited<ReturnType<typeof dryRunCompanyStep1>>,
    | "canonicalForReplay"
    | "checkpoint"
    | "checks"
    | "closedEraProvenSaleIds"
    | "evidencedOpeningStates"
    | "historicalMerges"
    | "inventoryResult"
    | "legacyMovements"
    | "legacySales"
    | "legacyTransferFallbackMovements"
    | "normalizedCanonicalPosReplay"
    | "proposalsBySaleId"
    | "stockItems"
    | "targetKeys"
    | "traceRewind"
  >,
  companyId: number
) {
  if (!checkpoint || checkpoint.rows.length === 0) {
    checks.push({
      companyId,
      locationId: null,
      stockItemId: null,
      code: "VALUATION_CHECKPOINT_MISSING",
      status: "block",
      detail: "Phase 3 inventory valuation checkpoint is missing for this company",
    });
    for (const sale of legacySales) {
      if (sale.location_id) proposalsBySaleId.set(Number(sale.sales_item_id), originalProposalForSale(companyId, sale));
    }
  } else {
    checks.push({
      companyId,
      locationId: null,
      stockItemId: null,
      code: "VALUATION_CHECKPOINT_PRESENT",
      status: "pass",
      expected: String(checkpoint.movementCutoffId),
      actual: String(checkpoint.movementCutoffId),
      detail: checkpoint.createdAt.toISOString(),
    });

    const checkpointByKey = new Map<string, InventoryRow>();
    const checkpointStates = new Map<string, HistoricalInventoryState>();
    for (const row of checkpoint.rows) {
      const key = historicalInventoryKey(companyId, Number(row.location_id), Number(row.stock_item_id));
      checkpointByKey.set(key, row);
      checkpointStates.set(
        key,
        createHistoricalInventoryStateFromSnapshot(row.quantity, row.average_rate, row.total_value)
      );
    }

    const mergedRecovery = recoverHistoricalMergedSales({
      companyId,
      targetKeys,
      checkpoint,
      checkpointStates,
      historicalMerges,
      canonical: canonicalForReplay,
      legacyMovements,
    });
    checks.push(...mergedRecovery.checks);
    for (const proposal of mergedRecovery.proposals) {
      proposalsBySaleId.set(proposal.salesItemId, proposal);
    }

    const mergedSourceIds = new Set(historicalMerges.map((merge) => Number(merge.source_item_id)));
    const unavailableKeys = new Set<string>();
    for (const key of targetKeys) {
      if (checkpointStates.has(key) || mergedRecovery.recoveredKeys.has(key)) continue;
      const [, locationIdText, stockItemIdText] = key.split(":");
      const locationId = Number(locationIdText);
      const stockItemId = Number(stockItemIdText);
      unavailableKeys.add(key);
      const alreadyBlocked = checks.some(
        (check) =>
          check.status === "block" &&
          check.companyId === companyId &&
          check.stockItemId === stockItemId &&
          (check.locationId === null || check.locationId === locationId)
      );
      if (!alreadyBlocked) {
        checks.push({
          companyId,
          locationId,
          stockItemId,
          code: mergedSourceIds.has(stockItemId) ? "MERGED_ITEM_RECOVERY_FAILED" : "VALUATION_CHECKPOINT_KEY_MISSING",
          status: "block",
          detail: mergedSourceIds.has(stockItemId)
            ? "Historical merged item could not be reconstructed uniquely"
            : "Legacy sale item/location has no row in the immutable Phase 3 valuation checkpoint",
        });
      }
    }
    const checkpointTargetKeys = new Set(
      [...targetKeys].filter((key) => checkpointStates.has(key) && !unavailableKeys.has(key))
    );

    // Prove the immutable checkpoint still reaches today's active-location
    // inventory using every durable movement after the checkpoint. Canonical
    // rows use the exact checkpoint movement-id boundary; noncanonical durable
    // rows use the checkpoint timestamp.
    const liveReplayStates = new Map<string, HistoricalInventoryState>();
    for (const [key, state] of checkpointStates) {
      if (checkpointTargetKeys.has(key)) {
        liveReplayStates.set(
          key,
          createHistoricalInventoryStateFromSnapshot(state.quantity, state.averageRate, state.totalValue)
        );
      }
    }

    const postCheckpointMovements = [
      ...canonicalForReplay.filter((movement) => {
        const id = canonicalMovementNumericId(movement);
        return id !== null && id > checkpoint.movementCutoffId;
      }),
      ...legacyMovements.filter((movement) => movementMutationTime(movement) > checkpoint.createdAt.getTime()),
    ].sort(compareMovementMutationAscending);

    for (const movement of postCheckpointMovements) {
      const key = movementKey(movement);
      if (!checkpointTargetKeys.has(key) || unavailableKeys.has(key)) continue;
      const current =
        liveReplayStates.get(key) ?? createHistoricalInventoryStateFromSnapshot("0", movement.unitCost ?? "0", "0");
      liveReplayStates.set(key, applyHistoricalSalesRepairMovement(current, movement));
    }

    const liveByKey = new Map(
      inventoryResult.rows.map((row) => [
        historicalInventoryKey(companyId, Number(row.location_id), Number(row.stock_item_id)),
        row,
      ])
    );
    for (const key of checkpointTargetKeys) {
      if (unavailableKeys.has(key)) continue;
      const actual = liveReplayStates.get(key) ?? createHistoricalInventoryStateFromSnapshot("0", "0", "0");
      const live = liveByKey.get(key);
      const expectedQty = repairQuantity(live?.quantity ?? "0");
      const expectedValue = repairMoney(live?.total_value ?? "0");
      if (
        actual.quantity.minus(expectedQty).abs().gt(QTY_TOLERANCE) ||
        actual.totalValue.minus(expectedValue).abs().gt(MONEY_TOLERANCE)
      ) {
        const [, locationIdText, stockItemIdText] = key.split(":");
        checks.push({
          companyId,
          locationId: Number(locationIdText),
          stockItemId: Number(stockItemIdText),
          code: "CHECKPOINT_TO_LIVE_RECONCILIATION_MISMATCH",
          status: "warning",
          expected: `${expectedQty.toFixed(3)}|${expectedValue.toFixed(2)}`,
          actual: `${actual.quantity.toFixed(3)}|${actual.totalValue.toFixed(2)}`,
          detail:
            "Post-checkpoint journal does not reproduce today's live inventory exactly. The immutable checkpoint remains valid for pre-checkpoint sales-cost reconstruction; apply still fingerprints inventory so this warning cannot mutate current stock.",
        });
      }
    }

    const rewindStates = new Map<string, HistoricalInventoryState>();
    for (const [key, state] of checkpointStates) {
      if (checkpointTargetKeys.has(key) && !unavailableKeys.has(key)) {
        rewindStates.set(
          key,
          createHistoricalInventoryStateFromSnapshot(state.quantity, state.averageRate, state.totalValue)
        );
      }
    }

    // Rewind every durable movement represented in the checkpoint in actual
    // mutation order. This includes durable legacy rows that never received a
    // canonical journal counterpart after canonical journaling began.
    const movementsInCheckpoint = [
      ...canonicalForReplay.filter((movement) => {
        const id = canonicalMovementNumericId(movement);
        return id !== null && id <= checkpoint.movementCutoffId;
      }),
      ...legacyMovements.filter((movement) => movementMutationTime(movement) <= checkpoint.createdAt.getTime()),
    ].sort(compareMovementMutationDescending);
    const normalizedMovementsAscending = [
      ...normalizedCanonicalPosReplay.filter((movement) => {
        const id = canonicalMovementNumericId(movement);
        return id !== null && id <= checkpoint.movementCutoffId;
      }),
      ...legacyMovements.filter((movement) => movementMutationTime(movement) <= checkpoint.createdAt.getTime()),
    ].sort(compareMovementMutationAscending);
    const priorCostMemoryRateHints = buildPriorCanonicalCostMemoryRateHints(movementsInCheckpoint);
    const fallbackMovementsInCheckpoint = legacyTransferFallbackMovements
      .filter((movement) => movementMutationTime(movement) <= checkpoint.createdAt.getTime())
      .sort(compareMovementMutationAscending);
    const legacyTransferFallbackItemIds = new Set(
      fallbackMovementsInCheckpoint.map((movement) => movement.stockItemId)
    );
    const targetLegacySaleMovementsByKey = new Map<string, HistoricalSalesRepairMovement[]>();
    for (const movement of legacyMovements) {
      if (!movement.sale) continue;
      const key = movementKey(movement);
      const rows = targetLegacySaleMovementsByKey.get(key) ?? [];
      rows.push(movement);
      targetLegacySaleMovementsByKey.set(key, rows);
    }

    // Reverse replay can lose pre-reset cost memory. Before blocking older
    // sales, derive location opening quantities from the immutable checkpoint,
    // reconcile them to the pinned stock-item opening balance, replay every
    // durable movement forward, and accept only an exact checkpoint match.
    const forwardReplayResolvedKeys = new Set<string>();
    const fallbackProvenItemIds = new Set<number>();
    const movementsAscending = [...movementsInCheckpoint].sort(compareMovementMutationAscending);
    const stockItemById = new Map(stockItems.map((item) => [Number(item.id), item]));
    const targetKeysByItem = new Map<number, string[]>();
    for (const key of checkpointTargetKeys) {
      const stockItemId = Number(key.split(":")[2]);
      const rows = targetKeysByItem.get(stockItemId) ?? [];
      rows.push(key);
      targetKeysByItem.set(stockItemId, rows);
    }

    proveOpeningForwardReplay({
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
    });

    const { forwardResetProvenSaleIds, movementsByTargetKey } = proveForwardCostMemoryResets({
      companyId,
      checks,
      proposalsBySaleId,
      checkpointStates,
      unavailableKeys,
      checkpointTargetKeys,
      forwardReplayResolvedKeys,
      movementsAscending,
    });

    const {
      reanchorRequests,
      rewindAlternates,
      finishedAlternates,
      primaryHistoryByKey,
      branchOverflowKeys,
      legacyInverseAmbiguity,
      REWIND_AMPLIFICATION_LIMIT,
      REANCHOR_MAX_CANDIDATES,
      rewindAmplification,
    } = rewindCheckpointToLegacySales({
      companyId,
      traceRewind,
      checks,
      proposalsBySaleId,
      unavailableKeys,
      checkpointTargetKeys,
      rewindStates,
      movementsInCheckpoint,
      priorCostMemoryRateHints,
      targetLegacySaleMovementsByKey,
      forwardReplayResolvedKeys,
      movementsAscending,
      forwardResetProvenSaleIds,
    });

    resolveRewindBranchesAndReanchor({
      companyId,
      checks,
      proposalsBySaleId,
      movementsInCheckpoint,
      priorCostMemoryRateHints,
      forwardResetProvenSaleIds,
      reanchorRequests,
      rewindAlternates,
      finishedAlternates,
      primaryHistoryByKey,
      branchOverflowKeys,
      legacyInverseAmbiguity,
      REWIND_AMPLIFICATION_LIMIT,
      REANCHOR_MAX_CANDIDATES,
    });

    const { REWIND_FAILURE_BLOCKS, blockedSaleCodes, eraProvenSales, eraConflictSales } = proveClosedZeroStockEras({
      companyId,
      checks,
      proposalsBySaleId,
      closedEraProvenSaleIds,
      evidencedOpeningStates,
      checkpointStates,
      forwardReplayResolvedKeys,
      movementsByTargetKey,
    });
    reportCheckpointRewindCoverage({
      companyId,
      checks,
      legacySales,
      proposalsBySaleId,
      targetKeys,
      checkpointStates,
      mergedRecovery,
      unavailableKeys,
      checkpointTargetKeys,
      forwardReplayResolvedKeys,
      movementsByTargetKey,
      rewindAmplification,
      REWIND_FAILURE_BLOCKS,
      blockedSaleCodes,
      eraProvenSales,
      eraConflictSales,
    });
  }
  return {};
}
