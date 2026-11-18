import {
  FINALIZED_BALE_STATUSES,
  type ReplayQueryExecutor,
  type ReplayWriteScope,
  type ReplayScopeInternal,
  type ReplaySummary,
} from "./types";
import {
  previewHistoricalCostReplayWithExecutor,
  buildBatchConsumptionEvents,
  loadContainerUniverse,
  computeCanonicalCosts,
  computeBatchCorrections,
} from "./read-model";
export {
  buildNotFinalizedClause,
  captureReplaySnapshot,
  computeReplayFingerprint,
  computeReplayWriteScope,
} from "./scopeCaptureReplaySnapshot";

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
    _batchCorrections: [],
    _canonicalRateByContainer: new Map(),
    _canonicalTotalUsdByContainer: new Map(),
    _rawStockIdToContainer: new Map(),
    _fullPreview: { summary: emptySummary(), supplierRows: [], containerRows: [], sourceRows: [], batchRows: [] },
  };
}

export async function buildHistoricalReplayScope(params: {
  companyId: number;
  selectedSupplierIds: Set<number>;
  includeCompletedBatches: boolean;
  includeFinalizedBales: boolean;
  executor: ReplayQueryExecutor;
}): Promise<ReplayWriteScope> {
  const internal = await buildHistoricalReplayScopeInternal({ ...params, lockRows: false });
  return {
    supplierIds: internal.supplierIds,
    containerIdsToUpdate: internal.containerIdsToUpdate,
    rawStockIdsToUpdate: internal.rawStockIdsToUpdate,
    sourceIdsToUpdate: internal.sourceIdsToUpdate,
    batchIdsToUpdate: internal.batchIdsToUpdate,
    availableBaleIdsToUpdate: internal.availableBaleIdsToUpdate,
    finalizedBaleIdsToUpdate: internal.finalizedBaleIdsToUpdate,
    blockedBatches: internal.blockedBatches,
  };
}

export async function buildHistoricalReplayScopeInternal(params: {
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
  const supplierIdArray = [...selectedSupplierIds];
  if (supplierIdArray.length === 0) return emptyScope();

  if (lockRows) {
    await executor.query(`SELECT id FROM factory_suppliers WHERE id = ANY($1) AND company_id = $2 FOR UPDATE`, [
      supplierIdArray,
      companyId,
    ]);
    await executor.query(
      `SELECT id FROM factory_containers
       WHERE supplier_id = ANY($1) AND company_id = $2 AND deleted_at IS NULL
       FOR UPDATE`,
      [supplierIdArray, companyId]
    );
    await executor.query(
      `SELECT frs.id
       FROM factory_raw_stock frs
       JOIN factory_containers fc ON fc.id = frs.container_id
       WHERE frs.company_id = $1
         AND fc.supplier_id = ANY($2)
         AND frs.deleted_at IS NULL
       FOR UPDATE OF frs`,
      [companyId, supplierIdArray]
    );
    await executor.query(
      `SELECT mb.id
       FROM factory_mix_batches mb
       WHERE mb.company_id = $1
         AND mb.deleted_at IS NULL
         AND EXISTS (
           SELECT 1
           FROM factory_mix_batch_sources mbs
           WHERE mbs.mix_batch_id = mb.id
             AND mbs.supplier_id = ANY($2)
         )
       FOR UPDATE OF mb`,
      [companyId, supplierIdArray]
    );
    await executor.query(
      `SELECT mbs.id
       FROM factory_mix_batch_sources mbs
       JOIN factory_mix_batches mb ON mb.id = mbs.mix_batch_id
       WHERE mb.company_id = $1 AND mbs.supplier_id = ANY($2)
       FOR UPDATE OF mbs`,
      [companyId, supplierIdArray]
    );
  }

  const fullPreview = await previewHistoricalCostReplayWithExecutor(executor, companyId);
  const safeSupplierRows = fullPreview.supplierRows.filter(
    (supplier) => supplier.safeToRepair && selectedSupplierIds.has(supplier.supplierId)
  );
  const safeSupplierIds = new Set(safeSupplierRows.map((supplier) => supplier.supplierId));
  if (safeSupplierIds.size === 0) return { ...emptyScope(), _fullPreview: fullPreview };

  const expectedRates = new Map<string, number>();
  for (const source of fullPreview.sourceRows) {
    if (
      source.pricingBasis === "SUPPLIER_LOCKED_RATE" &&
      source.supplierId != null &&
      safeSupplierIds.has(source.supplierId)
    ) {
      const key = `${source.supplierId}:${source.batchId}`;
      if (!expectedRates.has(key)) expectedRates.set(key, source.expectedHistoricalCostPerKg);
    }
  }

  const { sourceInfos, batchInfoMap } = await buildBatchConsumptionEvents(executor, companyId, safeSupplierIds);
  const universe = await loadContainerUniverse(executor, companyId);
  const canonicals = await computeCanonicalCosts(executor, companyId, universe);
  const canonicalRateByContainer = new Map<number, number>();
  const canonicalTotalUsdByContainer = new Map<number, number>();
  for (const canonical of canonicals) {
    if (canonical.fxUnresolved) continue;
    canonicalRateByContainer.set(canonical.universe.container.id, canonical.canonicalCostPerKgUsd);
    canonicalTotalUsdByContainer.set(canonical.universe.container.id, canonical.canonicalTotalUsd);
  }

  const { corrections: batchCorrections, blockedBatches } = computeBatchCorrections(
    batchInfoMap,
    sourceInfos,
    expectedRates,
    canonicalRateByContainer
  );
  const batchIdsToUpdate = new Set(
    batchCorrections
      .filter((correction) => includeCompletedBatches || !["COMPLETED", "CLOSED"].includes(correction.status))
      .map((correction) => correction.batchId)
  );
  const sourceIdsToUpdate = sourceInfos
    .filter((source) => batchIdsToUpdate.has(source.batchId))
    .filter((source) => {
      if (source.pricingBasis === "SUPPLIER_LOCKED_RATE" && source.supplierId != null) {
        return safeSupplierIds.has(source.supplierId);
      }
      if (source.pricingBasis === "CONTAINER_DIRECT" && source.containerId != null) {
        return canonicalRateByContainer.has(source.containerId);
      }
      return false;
    })
    .map((source) => source.sourceId);

  const containerIdsToUpdate = canonicals
    .filter((canonical) => !canonical.fxUnresolved)
    .filter((canonical) => {
      const supplierId = canonical.universe.container.supplierId;
      return supplierId != null && safeSupplierIds.has(supplierId);
    })
    .map((canonical) => canonical.universe.container.id);

  const rawStockIdToContainer = new Map<number, number>();
  if (containerIdsToUpdate.length > 0) {
    const rawStockResult = await executor.query<{ id: number; container_id: number }>(
      `SELECT id, container_id
       FROM factory_raw_stock
       WHERE company_id = $1
         AND container_id = ANY($2)
         AND deleted_at IS NULL`,
      [companyId, containerIdsToUpdate]
    );
    for (const row of rawStockResult.rows) rawStockIdToContainer.set(row.id, row.container_id);
    if (lockRows && rawStockIdToContainer.size > 0) {
      await executor.query(`SELECT id FROM factory_raw_stock WHERE id = ANY($1) AND company_id = $2 FOR UPDATE`, [
        [...rawStockIdToContainer.keys()],
        companyId,
      ]);
    }
  }

  const batchIdArray = [...batchIdsToUpdate];
  const availableBaleIdsToUpdate: number[] = [];
  const finalizedBaleIdsToUpdate: number[] = [];
  if (batchIdArray.length > 0) {
    const finalizedIn = FINALIZED_BALE_STATUSES.map((status) => `'${status}'`).join(",");
    const baleResult = await executor.query<{ id: number; is_finalized: boolean }>(
      `SELECT fb.id,
              (fb.status IN (${finalizedIn})
                OR fb.dispatch_batch_id IS NOT NULL
                OR EXISTS (SELECT 1 FROM customer_order_bales cob WHERE cob.bale_id = fb.id)
                OR EXISTS (SELECT 1 FROM factory_invoice_loading_bales filb WHERE filb.bale_id = fb.id)
              ) AS is_finalized
       FROM factory_bales fb
       WHERE fb.mix_batch_id = ANY($1)
         AND fb.company_id = $2
         AND fb.status NOT IN ('DELETED','REMOVED')`,
      [batchIdArray, companyId]
    );
    for (const bale of baleResult.rows) {
      if (bale.is_finalized) finalizedBaleIdsToUpdate.push(bale.id);
      else availableBaleIdsToUpdate.push(bale.id);
    }

    if (lockRows) {
      const baleIdsToLock = includeFinalizedBales
        ? [...availableBaleIdsToUpdate, ...finalizedBaleIdsToUpdate]
        : availableBaleIdsToUpdate;
      if (baleIdsToLock.length > 0) {
        await executor.query(`SELECT id FROM factory_bales WHERE id = ANY($1) AND company_id = $2 FOR UPDATE`, [
          baleIdsToLock,
          companyId,
        ]);
      }
      await executor.query(`SELECT id FROM factory_mix_batches WHERE id = ANY($1) AND company_id = $2 FOR UPDATE`, [
        batchIdArray,
        companyId,
      ]);
      if (sourceIdsToUpdate.length > 0) {
        await executor.query(
          `SELECT mbs.id
           FROM factory_mix_batch_sources mbs
           JOIN factory_mix_batches mb ON mb.id = mbs.mix_batch_id
           WHERE mbs.id = ANY($1) AND mb.company_id = $2
           FOR UPDATE OF mbs`,
          [sourceIdsToUpdate, companyId]
        );
      }
    }
  }

  return {
    supplierIds: [...safeSupplierIds],
    containerIdsToUpdate,
    rawStockIdsToUpdate: [...rawStockIdToContainer.keys()],
    sourceIdsToUpdate,
    batchIdsToUpdate: batchIdArray,
    availableBaleIdsToUpdate,
    finalizedBaleIdsToUpdate,
    blockedBatches,
    _safeSupplierRows: safeSupplierRows,
    _sourceInfos: sourceInfos,
    _batchCorrections: batchCorrections,
    _canonicalRateByContainer: canonicalRateByContainer,
    _canonicalTotalUsdByContainer: canonicalTotalUsdByContainer,
    _rawStockIdToContainer: rawStockIdToContainer,
    _fullPreview: fullPreview,
  };
}

export async function classifyBalesByFinalization(
  baleIds: number[],
  includeFinalizedBales: boolean,
  executor: ReplayQueryExecutor
): Promise<{ availableIds: number[]; finalizedIds: number[] }> {
  if (baleIds.length === 0) return { availableIds: [], finalizedIds: [] };
  const finalizedIn = FINALIZED_BALE_STATUSES.map((status) => `'${status}'`).join(",");
  const result = await executor.query<{ id: number; is_finalized: boolean }>(
    `SELECT fb.id,
            (fb.status IN (${finalizedIn})
              OR fb.dispatch_batch_id IS NOT NULL
              OR EXISTS (SELECT 1 FROM customer_order_bales cob WHERE cob.bale_id = fb.id)
              OR EXISTS (SELECT 1 FROM factory_invoice_loading_bales filb WHERE filb.bale_id = fb.id)
            ) AS is_finalized
     FROM factory_bales fb
     WHERE fb.id = ANY($1)`,
    [baleIds]
  );
  const availableIds: number[] = [];
  const finalizedIds: number[] = [];
  for (const row of result.rows) {
    if (row.is_finalized) {
      finalizedIds.push(row.id);
      if (includeFinalizedBales) availableIds.push(row.id);
    } else {
      availableIds.push(row.id);
    }
  }
  return { availableIds, finalizedIds };
}
