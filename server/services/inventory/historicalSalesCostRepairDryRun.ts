/** Per-company dry run of the historical sales-cost repair: loads evidence and runs each proof phase. */
import type { PoolClient } from "pg";

import {
  applyHistoricalSalesRepairMovement,
  createHistoricalInventoryStateFromSnapshot,
  historicalInventoryKey,
  repairMoney,
  repairQuantity,
  type HistoricalInventoryState,
  type HistoricalSalesRepairMovement,
  type HistoricalSalesRepairProposal,
} from "./historicalSalesCostRepairEngine";
import {
  CompanyDryRun,
  HISTORICAL_VALUATION_RESETS,
  InventoryRow,
  LegacyRow,
  MONEY_TOLERANCE,
  OFFLOAD_EVIDENCE_SOURCE_TYPES,
  QTY_TOLERANCE,
  REWIND_TRACE_LIMIT,
  RepairCheck,
  d,
  distinctBlockedItemLocations,
  iso,
  offloadEvidenceKey,
} from "./historicalSalesCostRepairTypes";
import {
  loadCanonicalMovements,
  loadCanonicalStart,
  loadHistoricalMerges,
  loadLegacyManualAdjustments,
  loadLegacyMovements,
  loadOffloadValueEvidence,
  loadSales,
  loadStockItems,
  loadValuationCheckpoint,
  loadValuationOverrides,
} from "./historicalSalesCostRepairLoaders";
import {
  activeCanonicalSaleEvidence,
  buildPriorCanonicalCostMemoryRateHints,
  canonicalMovementNumericId,
  compareMovementMutationAscending,
  compareMovementMutationDescending,
  droppedPosLineMovements,
  historicalSalesCompanyEvidenceHash,
  journalWithoutOverriddenLocationUpdates,
  movementKey,
  movementMutationTime,
  originalProposalForSale,
} from "./historicalSalesCostRepairEvidence";
import { rateHullBlocks, recoverHistoricalMergedSales } from "./historicalSalesCostRepairRecovery";
import { classifyCompanySales } from "./historicalSalesCostRepairSales";
import { proveOpeningForwardReplay } from "./historicalSalesCostRepairForwardReplay";
import { proveForwardCostMemoryResets, resolveRewindBranchesAndReanchor } from "./historicalSalesCostRepairReanchor";
import { rewindCheckpointToLegacySales } from "./historicalSalesCostRepairRewind";
import { proveClosedZeroStockEras, reportCheckpointRewindCoverage } from "./historicalSalesCostRepairEras";

export async function dryRunCompany(
  client: PoolClient,
  companyId: number,
  sourceCutoff: Date,
  options: { diagnoseKeys?: Set<string> } = {}
): Promise<CompanyDryRun> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`historical-sales-cost-repair:${companyId}`]);
  // V40 diagnostics: the checkpoint rewind trace per item/location, newest
  // first, so a blocked group can be read movement by movement. Read-only.
  const rewindTrace = new Map<string, string[]>();
  const traceRewind = (key: string, line: string) => {
    const lines = rewindTrace.get(key) ?? [];
    lines.push(line);
    if (!options.diagnoseKeys?.has(key) && lines.length > REWIND_TRACE_LIMIT) lines.shift();
    rewindTrace.set(key, lines);
  };

  const [inventoryResult, stockItems, canonicalStart, sales, checkpoint, offloadEvidence, historicalMerges] =
    await Promise.all([
      client.query<InventoryRow>(
        `SELECT i.location_id,i.stock_item_id,i.quantity::text,i.average_rate::text,i.total_value::text
         FROM inventory i
         JOIN locations l
           ON l.id=i.location_id
          AND l.company_id=i.company_id
          AND l.deleted_at IS NULL
        WHERE i.company_id=$1
        ORDER BY i.location_id,i.stock_item_id`,
        [companyId]
      ),
      loadStockItems(client, companyId),
      loadCanonicalStart(client, companyId, sourceCutoff),
      loadSales(client, companyId, sourceCutoff),
      loadValuationCheckpoint(client, companyId),
      loadOffloadValueEvidence(client, companyId, sourceCutoff),
      loadHistoricalMerges(client, companyId),
    ]);

  const [loadedCanonical, legacy, manual, valuationOverrides] = await Promise.all([
    loadCanonicalMovements(client, companyId, canonicalStart, sourceCutoff),
    loadLegacyMovements(client, companyId, canonicalStart, sourceCutoff),
    loadLegacyManualAdjustments(client, companyId, canonicalStart, sourceCutoff),
    loadValuationOverrides(client, companyId, sourceCutoff),
  ]);
  const journalCanonical = journalWithoutOverriddenLocationUpdates(loadedCanonical, valuationOverrides);

  const sourceEvidenceHash = historicalSalesCompanyEvidenceHash({
    companyId,
    canonicalStart,
    checkpoint,
    canonical: journalCanonical,
    legacy,
    manual,
    sales,
    stockItems,
    offloadEvidence,
    historicalMerges,
    valuationOverrides,
  });
  // Derived from hashed evidence (the journal and the sales lines), so the
  // restored lines need no hash entry of their own.
  const droppedPosLines = droppedPosLineMovements(companyId, journalCanonical, sales);
  const canonical = [...journalCanonical, ...droppedPosLines.movements];
  const offloadEvidenceByKey = new Map(
    offloadEvidence.map((row) => [offloadEvidenceKey(row.offload_id, row.stock_item_id), row])
  );
  for (const movement of canonical) {
    if (!OFFLOAD_EVIDENCE_SOURCE_TYPES.has(movement.sourceType)) continue;
    const evidence = offloadEvidenceByKey.get(offloadEvidenceKey(movement.sourceId, movement.stockItemId));
    if (evidence) movement.exactValue = String(evidence.total_value);
  }

  const checks: RepairCheck[] = [
    ...manual.checks,
    ...droppedPosLines.checks,
    {
      companyId,
      locationId: null,
      stockItemId: null,
      code: "V2_SOURCE_EVIDENCE_HASH",
      status: "pass",
      expected: sourceEvidenceHash,
      actual: sourceEvidenceHash,
      detail:
        "Pins Phase 3 checkpoint rows/cutoff, canonical and legacy movements, historical merge aliases, source openings, and target sale originals",
    },
  ];
  const pinnedOffloadRows = legacy.filter((row) => row.source_type === "legacy-container-offload" && row.mutation_at);
  checks.push({
    companyId,
    locationId: null,
    stockItemId: null,
    code: "LEGACY_OFFLOAD_ENTRY_TIME_PINNED",
    status: "pass",
    expected: String(legacy.filter((row) => row.source_type === "legacy-container-offload").length),
    actual: String(pinnedOffloadRows.length),
    detail:
      "Legacy offload item rows ordered at their charge-voucher transaction time (unique container offload, single voucher group, millisecond stamp agrees with created_at); the rest keep offloaded_at",
  });
  for (const reset of HISTORICAL_VALUATION_RESETS.filter((candidate) => candidate.companyId === companyId)) {
    checks.push({
      companyId,
      locationId: reset.locationId,
      stockItemId: reset.stockItemId,
      code: "WAVE6_VALUATION_RESET_EVIDENCE",
      status: "pass",
      expected: reset.afterQuantity + "|" + reset.afterAverageRate + "|" + reset.afterTotalValue,
      actual: reset.beforeQuantity + "|" + reset.beforeAverageRate + "|" + reset.beforeTotalValue,
      detail:
        "Exact guarded Wave 6 production valuation reset is included as an immutable replay boundary and source-hash input.",
    });
  }

  const canonicalSaleEvidence = activeCanonicalSaleEvidence(canonical);
  const canonicalSaleKeys = new Set(canonicalSaleEvidence.keys());
  const toLegacyMovement = (row: LegacyRow): HistoricalSalesRepairMovement => ({
    movementId: row.movement_id,
    companyId,
    locationId: Number(row.location_id),
    stockItemId: Number(row.stock_item_id),
    occurredAt: iso(row.occurred_at),
    ...(row.mutation_at ? { createdAt: iso(row.mutation_at) } : {}),
    sequence: Number(row.sequence),
    quantityDelta: String(row.quantity_delta),
    unitCost: row.unit_cost === null ? null : String(row.unit_cost),
    exactValue: OFFLOAD_EVIDENCE_SOURCE_TYPES.has(row.source_type)
      ? (offloadEvidenceByKey.get(offloadEvidenceKey(row.source_id, row.stock_item_id))?.total_value ?? null)
      : null,
    sourceType: row.source_type,
    sourceId: row.source_id,
    evidence: "legacy" as const,
  });
  const legacyTransferFallbackMovements = legacy
    .filter((row) => row.source_type.endsWith("-flag-fallback"))
    .map(toLegacyMovement);
  const valuationResetMovements: HistoricalSalesRepairMovement[] = HISTORICAL_VALUATION_RESETS.filter(
    (reset) => reset.companyId === companyId
  ).map((reset, index) => ({
    movementId: `valuation-reset:${reset.sourceId}`,
    companyId: reset.companyId,
    locationId: reset.locationId,
    stockItemId: reset.stockItemId,
    occurredAt: reset.occurredAt,
    createdAt: reset.occurredAt,
    sequence: 900_000_000 + index,
    quantityDelta: "0.000",
    unitCost: null,
    valuationReset: {
      beforeQuantity: reset.beforeQuantity,
      beforeAverageRate: reset.beforeAverageRate,
      beforeTotalValue: reset.beforeTotalValue,
      afterQuantity: reset.afterQuantity,
      afterAverageRate: reset.afterAverageRate,
      afterTotalValue: reset.afterTotalValue,
    },
    sourceType: "inventory-valuation-wave6-reset",
    sourceId: reset.sourceId,
    evidence: "legacy" as const,
  }));
  valuationResetMovements.push(
    ...valuationOverrides.map((row) => ({
      movementId: `valuation-override:${row.id}`,
      companyId,
      locationId: Number(row.location_id),
      stockItemId: Number(row.stock_item_id),
      occurredAt: iso(row.created_at),
      createdAt: iso(row.created_at),
      sequence: Number(row.id) * 10 + 9,
      quantityDelta: repairQuantity(d(row.after_quantity).minus(d(row.before_quantity))).toFixed(3),
      unitCost: null,
      valuationReset: {
        beforeQuantity: String(row.before_quantity),
        beforeAverageRate: String(row.before_average_rate),
        beforeTotalValue: String(row.before_total_value),
        afterQuantity: String(row.after_quantity),
        afterAverageRate: String(row.after_average_rate),
        afterTotalValue: String(row.after_total_value),
      },
      sourceType: "inventory-valuation-override",
      sourceId: `${row.source_type}:${row.id}`,
      evidence: "legacy" as const,
    }))
  );

  const legacyMovements: HistoricalSalesRepairMovement[] = [
    ...legacy.filter((row) => !row.source_type.endsWith("-flag-fallback")).map(toLegacyMovement),
    ...valuationResetMovements,
    ...manual.movements.map((row) => ({
      movementId: row.movement_id,
      companyId,
      locationId: Number(row.location_id),
      stockItemId: Number(row.stock_item_id),
      occurredAt: iso(row.occurred_at),
      sequence: Number(row.sequence),
      quantityDelta: String(row.quantity_delta),
      unitCost: row.unit_cost === null ? null : String(row.unit_cost),
      sourceType: row.source_type,
      sourceId: row.source_id,
      evidence: "legacy" as const,
    })),
  ];

  const { directCanonicalProposals, canonicalForReplay, normalizedCanonicalPosReplay, legacySales } =
    classifyCompanySales({
      companyId,
      sales,
      canonicalStart,
      canonical,
      checks,
      canonicalSaleEvidence,
      canonicalSaleKeys,
      legacyMovements,
    });

  const proposalsBySaleId = new Map<number, HistoricalSalesRepairProposal>();
  const closedEraProvenSaleIds = new Set<number>();
  // V53: per-location opening states where the checkpoint-implied location
  // openings sum exactly to the pinned item opening (no negative location),
  // valued at the pinned item opening rate.
  const evidencedOpeningStates = new Map<string, HistoricalInventoryState>();
  const targetKeys = new Set(
    legacySales
      .filter((sale) => sale.location_id !== null)
      .map((sale) => historicalInventoryKey(companyId, Number(sale.location_id), Number(sale.stock_item_id)))
  );

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

  // V32: a moving weighted average is a convex combination of the rates that
  // fed it, so a reconstructed sale cost can never leave the range of every
  // rate the item ever carried. Run #33 marked legacy proposals of 536M/unit
  // (item normally ~107) "ready": a rewind chain amplified a small inverse
  // error geometrically while every local step still looked consistent. Any
  // reconstructed proposal outside the evidenced range proves the chain for
  // that item/location is wrong, so every legacy proposal there is blocked.
  checks.push(
    ...rateHullBlocks({
      companyId,
      proposals: [...proposalsBySaleId.values()],
      stockItems,
      canonical,
      legacy,
      offloadEvidence,
      checkpoint,
      historicalMerges,
      independentSaleIds: closedEraProvenSaleIds,
    })
  );

  const diagnosedKeys = new Set(options.diagnoseKeys ?? []);
  for (const check of checks) {
    if (check.status === "block" && check.locationId !== null && check.stockItemId !== null) {
      diagnosedKeys.add(historicalInventoryKey(companyId, check.locationId, check.stockItemId));
    }
  }
  for (const key of [...diagnosedKeys].sort()) {
    const lines = rewindTrace.get(key);
    if (!lines?.length) continue;
    const [, locationIdText, stockItemIdText] = key.split(":");
    checks.push({
      companyId,
      locationId: Number(locationIdText),
      stockItemId: Number(stockItemIdText),
      code: "REWIND_TIMELINE_DIAGNOSTIC",
      status: "warning",
      expected: String(lines.length),
      detail: lines.join("\n"),
    });
  }

  const proposals = [...directCanonicalProposals.values(), ...proposalsBySaleId.values()].sort(
    (a, b) => a.salesItemId - b.salesItemId
  );
  const report = {
    companyId,
    canonicalStart: canonicalStart ? canonicalStart.toISOString() : null,
    sourceCutoff: sourceCutoff.toISOString(),
    checkpointAt: checkpoint?.createdAt.toISOString() ?? null,
    checkpointMovementCutoffId: checkpoint?.movementCutoffId ?? null,
    sourceEvidenceHash,
    activeInventoryRows: inventoryResult.rows.length,
    checkpointRows: checkpoint?.rows.length ?? 0,
    stockItems: stockItems.length,
    canonicalMovements: canonical.length,
    legacyMovements: legacy.length + manual.movements.length,
    saleRows: sales.length,
    canonicalSaleRows: directCanonicalProposals.size,
    legacySaleRows: legacySales.length,
    historicalMerges: historicalMerges.length,
    exactOffloadEvidenceRows: offloadEvidence.length,
    valuationResetEvidenceRows: valuationResetMovements.length,
    proposedRows: proposals.length,
    changedSaleRows: proposals.filter((proposal) => proposal.changed).length,
    blockedItemLocations: distinctBlockedItemLocations(checks),
  };

  return { proposals, checks, report };
}
