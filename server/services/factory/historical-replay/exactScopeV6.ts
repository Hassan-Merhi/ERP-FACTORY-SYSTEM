import { type ReplayQueryExecutor, type ReplayScopeInternal, type ReplaySummary } from "./types";
import { buildBatchConsumptionEvents, loadContainerUniverse } from "./read-model";
import { computeCanonicalCostsV6 } from "./canonicalCostsV6";
import { previewHistoricalCostReplayWithExecutor } from "./securePreview";
import { buildSelectedSupplierCorrectionPlan } from "./closure";
import { classifyReplayBalesForBatches } from "./baleClassification";
import { toMoney } from "../../../lib/money";

function sortNumbers(values: number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function emptySummary(): ReplaySummary {
  return {
    totalReceivedContainers: 0,
    containersScanned: 0,
    omittedContainers: 0,
    canonicalContainerMismatches: 0,
    suppliersScanned: 0,
    safeSuppliers: 0,
    manualReviewSuppliers: 0,
    supplierPricedSourcesScanned: 0,
    sourceMismatches: 0,
    batchesToUpdate: 0,
    completedBatchesToUpdate: 0,
    balesToUpdate: 0,
    finalizedBalesToUpdate: 0,
    unresolvedFx: 0,
    missingDates: 0,
    quantityTimelineMismatches: 0,
    ambiguousEventOrdering: 0,
    scanCoverageError: false,
  };
}

function emptyScope(): ReplayScopeInternal {
  return {
    supplierIds: [],
    containerIdsToUpdate: [],
    rawStockIdsToUpdate: [],
    sourceIdsToUpdate: [],
    batchIdsToUpdate: [],
    availableBaleIdsToUpdate: [],
    finalizedBaleIdsToUpdate: [],
    blockedBatches: [],
    _safeSupplierRows: [],
    _sourceInfos: [],
    _sourceCorrections: new Map(),
    _batchCorrections: [],
    _canonicalRateByContainer: new Map(),
    _canonicalTotalUsdByContainer: new Map(),
    _rawStockIdToContainer: new Map(),
    _fullPreview: {
      summary: emptySummary(),
      supplierRows: [],
      containerRows: [],
      sourceRows: [],
      batchRows: [],
    },
  };
}

/**
 * Exact selected-supplier closure using persisted target columns for mismatch
 * detection. In particular, container total mismatch compares against
 * final_payable_amount_usd rather than reconstructing receivedKg × rate.
 */
export async function buildExactHistoricalReplayScopeInternalV6(params: {
  companyId: number;
  selectedSupplierIds: Set<number>;
  includeCompletedBatches: boolean;
  includeFinalizedBales: boolean;
  executor: ReplayQueryExecutor;
  lockRows?: boolean;
}): Promise<ReplayScopeInternal> {
  const {
    companyId,
    selectedSupplierIds,
    includeCompletedBatches,
    includeFinalizedBales,
    executor,
    lockRows = false,
  } = params;
  const requestedSupplierIds = sortNumbers([...selectedSupplierIds]);
  if (requestedSupplierIds.length === 0) return emptyScope();

  if (lockRows) {
    await executor.query(
      `SELECT id
       FROM factory_suppliers
       WHERE id = ANY($1) AND company_id = $2
       FOR UPDATE`,
      [requestedSupplierIds, companyId]
    );
    await executor.query(
      `SELECT id
       FROM factory_containers
       WHERE supplier_id = ANY($1)
         AND company_id = $2
         AND deleted_at IS NULL
       FOR UPDATE`,
      [requestedSupplierIds, companyId]
    );
    await executor.query(
      `SELECT frs.id
       FROM factory_raw_stock frs
       JOIN factory_containers fc ON fc.id = frs.container_id
       WHERE frs.company_id = $1
         AND fc.company_id = $1
         AND fc.supplier_id = ANY($2)
         AND frs.deleted_at IS NULL
         AND fc.deleted_at IS NULL
       FOR UPDATE OF frs`,
      [companyId, requestedSupplierIds]
    );
  }

  const fullPreview = await previewHistoricalCostReplayWithExecutor(executor, companyId);
  const safeSupplierRows = fullPreview.supplierRows.filter(
    (supplier) => supplier.safeToRepair && selectedSupplierIds.has(supplier.supplierId)
  );
  const safeSupplierIds = new Set(safeSupplierRows.map((supplier) => supplier.supplierId));
  if (safeSupplierIds.size === 0) return { ...emptyScope(), _fullPreview: fullPreview };

  const { sourceInfos, batchInfoMap } = await buildBatchConsumptionEvents(executor, companyId, safeSupplierIds);
  const previewSourceById = new Map(fullPreview.sourceRows.map((source) => [source.sourceId, source]));
  const expectedRates = new Map<string, number>();
  for (const source of sourceInfos) {
    if (source.pricingBasis !== "SUPPLIER_LOCKED_RATE" || source.supplierId == null) continue;
    const previewSource = previewSourceById.get(source.sourceId);
    expectedRates.set(
      `${source.supplierId}:${source.batchId}`,
      previewSource?.expectedHistoricalCostPerKg ?? source.storedCostPerKg
    );
  }

  const universe = await loadContainerUniverse(executor, companyId);
  const canonicals = await computeCanonicalCostsV6(executor, companyId, universe);
  const canonicalRateByContainer = new Map<number, number>();
  const canonicalTotalUsdByContainer = new Map<number, number>();
  for (const canonical of canonicals) {
    if (canonical.fxUnresolved) continue;
    canonicalRateByContainer.set(canonical.universe.container.id, canonical.canonicalCostPerKgUsd);
    canonicalTotalUsdByContainer.set(canonical.universe.container.id, canonical.canonicalTotalUsd);
  }

  const plan = buildSelectedSupplierCorrectionPlan({
    batchInfoMap,
    sourceInfos,
    selectedSupplierIds: safeSupplierIds,
    expectedRateAtBatch: expectedRates,
    canonicalRateByContainer,
  });

  const optionBlockedReasons = new Map<number, string>();
  if (!includeCompletedBatches) {
    for (const correction of plan.changedBatchCorrections) {
      const batch = batchInfoMap.get(correction.batchId);
      if (batch && ["COMPLETED", "CLOSED"].includes(batch.status)) {
        optionBlockedReasons.set(correction.batchId, "COMPLETED_BATCH_REQUIRES_INCLUDE_COMPLETED");
      }
    }

    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const source of sourceInfos) {
        if (
          source.pricingBasis === "BATCH" &&
          source.sourceBatchId != null &&
          optionBlockedReasons.has(source.sourceBatchId) &&
          plan.closureBatchIds.has(source.batchId) &&
          !optionBlockedReasons.has(source.batchId)
        ) {
          optionBlockedReasons.set(source.batchId, "UPSTREAM_COMPLETED_BATCH_EXCLUDED");
          expanded = true;
        }
      }
    }
  }

  const eligibleClosureBatchIds = new Set<number>();
  for (const batchId of plan.closureBatchIds) {
    if (!batchInfoMap.has(batchId) || optionBlockedReasons.has(batchId)) continue;
    eligibleClosureBatchIds.add(batchId);
  }

  const batchCorrections = plan.changedBatchCorrections.filter((correction) =>
    eligibleClosureBatchIds.has(correction.batchId)
  );
  const batchIdsToUpdate = sortNumbers(batchCorrections.map((correction) => correction.batchId));
  const sourceCorrections = new Map(
    [...plan.sourceCorrections].filter(([, correction]) => eligibleClosureBatchIds.has(correction.batchId))
  );
  const sourceIdsToUpdate = sortNumbers([...sourceCorrections.keys()]);

  const containerIdsToUpdate = sortNumbers(
    canonicals
      .filter((canonical) => {
        const supplierId = canonical.universe.container.supplierId;
        if (canonical.fxUnresolved || supplierId == null || !safeSupplierIds.has(supplierId)) return false;
        return (
          Math.abs(canonical.canonicalCostPerKgUsd - canonical.storedCostPerKgUsd) > 0.000001 ||
          Math.abs(canonical.canonicalTotalUsd - canonical.storedTotalUsd) > 0.01
        );
      })
      .map((canonical) => canonical.universe.container.id)
  );

  const rawStockIdToContainer = new Map<number, number>();
  if (containerIdsToUpdate.length > 0) {
    const rawStockResult = await executor.query<{
      id: number;
      container_id: number;
      cost_per_kg_usd: string | null;
    }>(
      `SELECT id, container_id, cost_per_kg_usd
       FROM factory_raw_stock
       WHERE company_id = $1
         AND container_id = ANY($2)
         AND deleted_at IS NULL`,
      [companyId, containerIdsToUpdate]
    );
    for (const row of rawStockResult.rows) {
      const expected = canonicalRateByContainer.get(row.container_id);
      if (expected == null) continue;
      const stored = toMoney(row.cost_per_kg_usd).toNumber();
      if (Math.abs(expected - stored) > 0.000001) {
        rawStockIdToContainer.set(row.id, row.container_id);
      }
    }
  }

  const baleClassification = await classifyReplayBalesForBatches(executor, companyId, batchIdsToUpdate);
  const availableBaleIdsToUpdate = baleClassification.availableIds;
  const finalizedBaleIdsToUpdate = baleClassification.finalizedIds;

  if (lockRows) {
    if (containerIdsToUpdate.length > 0) {
      await executor.query(
        `SELECT id
         FROM factory_containers
         WHERE id = ANY($1) AND company_id = $2
         FOR UPDATE`,
        [containerIdsToUpdate, companyId]
      );
    }
    if (rawStockIdToContainer.size > 0) {
      await executor.query(
        `SELECT id
         FROM factory_raw_stock
         WHERE id = ANY($1) AND company_id = $2
         FOR UPDATE`,
        [sortNumbers([...rawStockIdToContainer.keys()]), companyId]
      );
    }

    const closureBatchIds = sortNumbers([...eligibleClosureBatchIds]);
    if (closureBatchIds.length > 0) {
      await executor.query(
        `SELECT id
         FROM factory_mix_batches
         WHERE id = ANY($1) AND company_id = $2
         FOR UPDATE`,
        [closureBatchIds, companyId]
      );

      const closureSourceIds = sortNumbers(
        sourceInfos.filter((source) => eligibleClosureBatchIds.has(source.batchId)).map((source) => source.sourceId)
      );
      if (closureSourceIds.length > 0) {
        await executor.query(
          `SELECT mbs.id
           FROM factory_mix_batch_sources mbs
           JOIN factory_mix_batches mb ON mb.id = mbs.mix_batch_id
           WHERE mbs.id = ANY($1) AND mb.company_id = $2
           FOR UPDATE OF mbs`,
          [closureSourceIds, companyId]
        );
      }
    }

    const baleIdsToLock = includeFinalizedBales
      ? sortNumbers([...availableBaleIdsToUpdate, ...finalizedBaleIdsToUpdate])
      : availableBaleIdsToUpdate;
    if (baleIdsToLock.length > 0) {
      await executor.query(
        `SELECT id
         FROM factory_bales
         WHERE id = ANY($1)
           AND company_id = $2
           AND deleted_at IS NULL
         FOR UPDATE`,
        [baleIdsToLock, companyId]
      );
    }
  }

  const blockedByBatchId = new Map<number, { batchId: number; batchCode: string; reasons: Set<string> }>();
  for (const blocked of plan.blockedBatches) {
    if (!plan.closureBatchIds.has(blocked.batchId)) continue;
    blockedByBatchId.set(blocked.batchId, {
      batchId: blocked.batchId,
      batchCode: blocked.batchCode,
      reasons: new Set(blocked.reasons),
    });
  }
  for (const [batchId, reason] of optionBlockedReasons) {
    const batch = batchInfoMap.get(batchId);
    const existing = blockedByBatchId.get(batchId);
    if (existing) {
      existing.reasons.add(reason);
    } else {
      blockedByBatchId.set(batchId, {
        batchId,
        batchCode: batch?.batchCode ?? `BATCH-${batchId}`,
        reasons: new Set([reason]),
      });
    }
  }

  return {
    supplierIds: sortNumbers([...safeSupplierIds]),
    containerIdsToUpdate,
    rawStockIdsToUpdate: sortNumbers([...rawStockIdToContainer.keys()]),
    sourceIdsToUpdate,
    batchIdsToUpdate,
    availableBaleIdsToUpdate,
    finalizedBaleIdsToUpdate,
    blockedBatches: [...blockedByBatchId.values()]
      .sort((left, right) => left.batchId - right.batchId)
      .map((blocked) => ({
        batchId: blocked.batchId,
        batchCode: blocked.batchCode,
        reasons: [...blocked.reasons].sort(),
      })),
    _safeSupplierRows: safeSupplierRows,
    _sourceInfos: sourceInfos.filter((source) => plan.closureBatchIds.has(source.batchId)),
    _sourceCorrections: sourceCorrections,
    _batchCorrections: batchCorrections,
    _canonicalRateByContainer: canonicalRateByContainer,
    _canonicalTotalUsdByContainer: canonicalTotalUsdByContainer,
    _rawStockIdToContainer: rawStockIdToContainer,
    _fullPreview: fullPreview,
  };
}
