import crypto from "crypto";
import { pool } from "../../../db";
import {
  FINALIZED_BALE_STATUSES,
  REPLAY_ALGORITHM_VERSION,
  type HistoricalReplayPreviewResult,
  type ReplayQueryExecutor,
  type ReplayScopeInternal,
  type ReplaySummary,
  type ReplayWriteScope,
} from "./types";
import {
  buildBatchConsumptionEvents,
  computeCanonicalCosts,
  loadContainerUniverse,
  previewHistoricalCostReplayWithExecutor,
} from "./read-model";
import { buildSelectedSupplierCorrectionPlan } from "./closure";
import { toMoney } from "../../../lib/money";
export { captureReplaySnapshot } from "./scope";

export function buildNotFinalizedClause(includeFinalizedBales: boolean): string {
  if (includeFinalizedBales) return `status NOT IN ('DELETED','REMOVED')`;
  return `status NOT IN ('DELETED','REMOVED','${FINALIZED_BALE_STATUSES.join("','")}')
          AND dispatch_batch_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM customer_order_bales WHERE bale_id = fb.id)
          AND NOT EXISTS (SELECT 1 FROM factory_invoice_loading_bales WHERE bale_id = fb.id)`;
}

function sortNumbers(values: number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

export function normalizeReplayWriteScope(scope: ReplayWriteScope): ReplayWriteScope {
  return {
    supplierIds: sortNumbers(scope.supplierIds),
    containerIdsToUpdate: sortNumbers(scope.containerIdsToUpdate),
    rawStockIdsToUpdate: sortNumbers(scope.rawStockIdsToUpdate),
    sourceIdsToUpdate: sortNumbers(scope.sourceIdsToUpdate),
    batchIdsToUpdate: sortNumbers(scope.batchIdsToUpdate),
    availableBaleIdsToUpdate: sortNumbers(scope.availableBaleIdsToUpdate),
    finalizedBaleIdsToUpdate: sortNumbers(scope.finalizedBaleIdsToUpdate),
    blockedBatches: [...scope.blockedBatches]
      .map((batch) => ({
        batchId: batch.batchId,
        batchCode: batch.batchCode,
        reasons: [...new Set(batch.reasons)].sort(),
      }))
      .sort((left, right) => left.batchId - right.batchId),
  };
}

export function replayWriteScopesEqual(expected: ReplayWriteScope, actual: ReplayWriteScope): boolean {
  return JSON.stringify(normalizeReplayWriteScope(expected)) === JSON.stringify(normalizeReplayWriteScope(actual));
}

export function computeReplayFingerprint(
  companyId: number,
  supplierIds: number[],
  preview: HistoricalReplayPreviewResult,
  opts: { includeCompletedBatches: boolean; includeFinalizedBales: boolean },
  scope?: ReplayWriteScope
): string {
  const normalizedScope = scope ? normalizeReplayWriteScope(scope) : undefined;
  const selectedSupplierIds = sortNumbers(supplierIds);
  const sourceIds = new Set(normalizedScope?.sourceIdsToUpdate ?? preview.sourceRows.map((row) => row.sourceId));
  const batchIds = new Set(normalizedScope?.batchIdsToUpdate ?? preview.batchRows.map((row) => row.batchId));
  const containerIds = new Set(
    normalizedScope?.containerIdsToUpdate ??
      preview.containerRows
        .filter((row) => selectedSupplierIds.includes(row.supplierId ?? -1))
        .map((row) => row.containerId)
  );

  const payload = {
    algorithmVersion: REPLAY_ALGORITHM_VERSION,
    companyId,
    supplierIds: selectedSupplierIds,
    includeCompletedBatches: opts.includeCompletedBatches,
    includeFinalizedBales: opts.includeFinalizedBales,
    scope: normalizedScope,
    supplierEndingRates: preview.supplierRows
      .filter((supplier) => selectedSupplierIds.includes(supplier.supplierId))
      .sort((left, right) => left.supplierId - right.supplierId)
      .map((supplier) => ({
        id: supplier.supplierId,
        endingRate: supplier.endingExpectedRate,
        replayKg: supplier.replayRemainingKg,
        authoritativeKg: supplier.authoritativeRemainingKg,
        currentStoredRate: supplier.currentStoredRate,
        safeToRepair: supplier.safeToRepair,
      })),
    sourceData: preview.sourceRows
      .filter((source) => sourceIds.has(source.sourceId))
      .sort((left, right) => left.sourceId - right.sourceId)
      .map((source) => ({
        id: source.sourceId,
        batchId: source.batchId,
        supplierId: source.supplierId,
        containerId: source.containerId,
        pricingBasis: source.pricingBasis,
        weightKg: source.weightKg,
        storedCostPerKg: source.storedCostPerKg,
        expectedHistoricalCostPerKg: source.expectedHistoricalCostPerKg,
      })),
    batchData: preview.batchRows
      .filter((batch) => batchIds.has(batch.batchId))
      .sort((left, right) => left.batchId - right.batchId)
      .map((batch) => ({
        batchId: batch.batchId,
        status: batch.status,
        storedCostPerKg: batch.storedCostPerKg,
        expectedCostPerKg: batch.expectedCostPerKg,
        storedTotalCost: batch.storedTotalCost,
        expectedTotalCost: batch.expectedTotalCost,
      })),
    containerData: preview.containerRows
      .filter((container) => containerIds.has(container.containerId))
      .sort((left, right) => left.containerId - right.containerId)
      .map((container) => ({
        id: container.containerId,
        supplierId: container.supplierId,
        storedCostPerKgUsd: container.storedCostPerKgUsd,
        canonicalCostPerKgUsd: container.canonicalCostPerKgUsd,
        storedTotalUsd: container.storedTotalUsd,
        canonicalTotalUsd: container.canonicalTotalUsd,
        safeToRepair: container.safeToRepair,
      })),
  };
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
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

export async function buildHistoricalReplayScope(params: {
  companyId: number;
  selectedSupplierIds: Set<number>;
  includeCompletedBatches: boolean;
  includeFinalizedBales: boolean;
  executor: ReplayQueryExecutor;
}): Promise<ReplayWriteScope> {
  const internal = await buildHistoricalReplayScopeInternal({ ...params, lockRows: false });
  return normalizeReplayWriteScope(internal);
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
  const requestedSupplierIds = sortNumbers([...selectedSupplierIds]);
  if (requestedSupplierIds.length === 0) return emptyScope();

  if (lockRows) {
    await executor.query(
      `SELECT id FROM factory_suppliers
       WHERE id = ANY($1) AND company_id = $2
       FOR UPDATE`,
      [requestedSupplierIds, companyId]
    );
    await executor.query(
      `SELECT id FROM factory_containers
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
         AND fc.supplier_id = ANY($2)
         AND frs.deleted_at IS NULL
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
  const canonicals = await computeCanonicalCosts(executor, companyId, universe);
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

  const eligibleClosureBatchIds = new Set<number>();
  for (const batchId of plan.closureBatchIds) {
    const batch = batchInfoMap.get(batchId);
    if (!batch) continue;
    if (!includeCompletedBatches && ["COMPLETED", "CLOSED"].includes(batch.status)) continue;
    eligibleClosureBatchIds.add(batchId);
  }

  const batchCorrections = plan.changedBatchCorrections.filter((correction) =>
    eligibleClosureBatchIds.has(correction.batchId)
  );
  const batchIdsToUpdate = batchCorrections.map((correction) => correction.batchId);
  const sourceCorrections = new Map(
    [...plan.sourceCorrections].filter(([, correction]) => eligibleClosureBatchIds.has(correction.batchId))
  );
  const sourceIdsToUpdate = [...sourceCorrections.keys()];

  const containerIdsToUpdate = canonicals
    .filter((canonical) => {
      const supplierId = canonical.universe.container.supplierId;
      if (canonical.fxUnresolved || supplierId == null || !safeSupplierIds.has(supplierId)) return false;
      return (
        Math.abs(canonical.canonicalCostPerKgUsd - canonical.storedCostPerKgUsd) > 0.000001 ||
        Math.abs(canonical.canonicalTotalUsd - canonical.storedTotalUsd) > 0.01
      );
    })
    .map((canonical) => canonical.universe.container.id);

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
      if (Math.abs(expected - stored) > 0.000001) rawStockIdToContainer.set(row.id, row.container_id);
    }
  }

  const availableBaleIdsToUpdate: number[] = [];
  const finalizedBaleIdsToUpdate: number[] = [];
  if (batchIdsToUpdate.length > 0) {
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
      [batchIdsToUpdate, companyId]
    );
    for (const bale of baleResult.rows) {
      if (bale.is_finalized) finalizedBaleIdsToUpdate.push(bale.id);
      else availableBaleIdsToUpdate.push(bale.id);
    }
  }

  if (lockRows) {
    if (containerIdsToUpdate.length > 0) {
      await executor.query(
        `SELECT id FROM factory_containers
         WHERE id = ANY($1) AND company_id = $2
         FOR UPDATE`,
        [containerIdsToUpdate, companyId]
      );
    }
    if (rawStockIdToContainer.size > 0) {
      await executor.query(
        `SELECT id FROM factory_raw_stock
         WHERE id = ANY($1) AND company_id = $2
         FOR UPDATE`,
        [[...rawStockIdToContainer.keys()], companyId]
      );
    }
    const closureIds = [...eligibleClosureBatchIds];
    if (closureIds.length > 0) {
      await executor.query(
        `SELECT id FROM factory_mix_batches
         WHERE id = ANY($1) AND company_id = $2
         FOR UPDATE`,
        [closureIds, companyId]
      );
    }
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
    const baleIdsToLock = includeFinalizedBales
      ? [...availableBaleIdsToUpdate, ...finalizedBaleIdsToUpdate]
      : availableBaleIdsToUpdate;
    if (baleIdsToLock.length > 0) {
      await executor.query(
        `SELECT id FROM factory_bales
         WHERE id = ANY($1) AND company_id = $2
         FOR UPDATE`,
        [baleIdsToLock, companyId]
      );
    }
  }

  return {
    supplierIds: sortNumbers([...safeSupplierIds]),
    containerIdsToUpdate: sortNumbers(containerIdsToUpdate),
    rawStockIdsToUpdate: sortNumbers([...rawStockIdToContainer.keys()]),
    sourceIdsToUpdate: sortNumbers(sourceIdsToUpdate),
    batchIdsToUpdate: sortNumbers(batchIdsToUpdate),
    availableBaleIdsToUpdate: sortNumbers(availableBaleIdsToUpdate),
    finalizedBaleIdsToUpdate: sortNumbers(finalizedBaleIdsToUpdate),
    blockedBatches: plan.blockedBatches
      .filter((batch) => plan.closureBatchIds.has(batch.batchId))
      .map((batch) => ({
        batchId: batch.batchId,
        batchCode: batch.batchCode,
        reasons: batch.reasons,
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

export async function computeReplayWriteScope(
  companyId: number,
  requestedSupplierIds: number[],
  _preview: HistoricalReplayPreviewResult,
  opts: { includeCompletedBatches: boolean; includeFinalizedBales: boolean },
  executor: ReplayQueryExecutor = pool as ReplayQueryExecutor
): Promise<{
  safeSupplierIds: Set<number>;
  containerIds: Set<number>;
  batchIdsToApply: Set<number>;
  sourceIds: Set<number>;
  baleCount: number;
}> {
  const scope = await buildHistoricalReplayScope({
    companyId,
    selectedSupplierIds: new Set(requestedSupplierIds),
    includeCompletedBatches: opts.includeCompletedBatches,
    includeFinalizedBales: opts.includeFinalizedBales,
    executor,
  });
  return {
    safeSupplierIds: new Set(scope.supplierIds),
    containerIds: new Set(scope.containerIdsToUpdate),
    batchIdsToApply: new Set(scope.batchIdsToUpdate),
    sourceIds: new Set(scope.sourceIdsToUpdate),
    baleCount:
      scope.availableBaleIdsToUpdate.length + (opts.includeFinalizedBales ? scope.finalizedBaleIdsToUpdate.length : 0),
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
