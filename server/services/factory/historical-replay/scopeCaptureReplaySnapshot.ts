// Extracted from ./scope.ts to keep that module under the source-size cap.
import crypto from "crypto";
import { pool } from "../../../db";
import {
  FINALIZED_BALE_STATUSES,
  type HistoricalReplayPreviewResult,
  REPLAY_ALGORITHM_VERSION,
  type ReplayQueryExecutor,
} from "./types";
import {
  buildBatchConsumptionEvents,
  computeBatchCorrections,
  computeCanonicalCosts,
  loadContainerUniverse,
} from "./read-model";

export function computeReplayFingerprint(
  companyId: number,
  supplierIds: number[],
  preview: HistoricalReplayPreviewResult,
  opts: { includeCompletedBatches: boolean; includeFinalizedBales: boolean }
): string {
  const sortedSupplierIds = [...supplierIds].sort((left, right) => left - right);
  const payload = {
    algorithmVersion: REPLAY_ALGORITHM_VERSION,
    companyId,
    supplierIds: sortedSupplierIds,
    includeCompletedBatches: opts.includeCompletedBatches,
    includeFinalizedBales: opts.includeFinalizedBales,
    supplierEndingRates: preview.supplierRows
      .filter((supplier) => sortedSupplierIds.includes(supplier.supplierId))
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
      .filter((source) => source.safeToRepair)
      .sort((left, right) => left.sourceId - right.sourceId)
      .map((source) => ({
        id: source.sourceId,
        supplierId: source.supplierId,
        containerId: source.containerId,
        batchId: source.batchId,
        pricingBasis: source.pricingBasis,
        weightKg: source.weightKg,
        storedCostPerKg: source.storedCostPerKg,
        expectedHistoricalCostPerKg: source.expectedHistoricalCostPerKg,
      })),
    batchData: preview.batchRows
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
      .filter((container) => !container.fxUnresolved && sortedSupplierIds.includes(container.supplierId ?? -1))
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
    summary: {
      sourceMismatches: preview.summary.sourceMismatches,
      batchesToUpdate: preview.summary.batchesToUpdate,
      completedBatchesToUpdate: preview.summary.completedBatchesToUpdate,
      balesToUpdate: preview.summary.balesToUpdate,
      finalizedBalesToUpdate: preview.summary.finalizedBalesToUpdate,
      unresolvedFx: preview.summary.unresolvedFx,
    },
    scopeIds: {
      sortedSupplierIds,
      safeSourceIds: preview.sourceRows
        .filter((source) => source.safeToRepair)
        .map((source) => source.sourceId)
        .sort((a, b) => a - b),
      batchIds: preview.batchRows.map((batch) => batch.batchId).sort((a, b) => a - b),
      containerIds: preview.containerRows
        .filter((container) => !container.fxUnresolved && sortedSupplierIds.includes(container.supplierId ?? -1))
        .map((container) => container.containerId)
        .sort((a, b) => a - b),
    },
  };
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function buildNotFinalizedClause(includeFinalizedBales: boolean): string {
  if (includeFinalizedBales) return `status NOT IN ('DELETED','REMOVED')`;
  return `status NOT IN ('DELETED','REMOVED','${FINALIZED_BALE_STATUSES.join("','")}')
          AND dispatch_batch_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM customer_order_bales WHERE bale_id = fb.id)
          AND NOT EXISTS (SELECT 1 FROM factory_invoice_loading_bales WHERE bale_id = fb.id)`;
}

export async function captureReplaySnapshot(
  client: ReplayQueryExecutor,
  companyId: number,
  supplierIds: number[],
  batchIds: number[],
  sourceIds: number[],
  baleIds: number[]
) {
  const safeSupplierIds = supplierIds.length ? supplierIds : [-1];
  const safeBatchIds = batchIds.length ? batchIds : [-1];
  const safeSourceIds = sourceIds.length ? sourceIds : [-1];
  const safeBaleIds = baleIds.length ? baleIds : [-1];

  const [rawStockResult, sourceResult, batchResult, baleResult, supplierResult, containerResult] = await Promise.all([
    client.query(
      `SELECT frs.id,
              frs.cost_per_kg AS "costPerKg",
              frs.cost_per_kg_usd AS "costPerKgUsd",
              frs.received_kg AS "receivedKg",
              frs.used_kg AS "usedKg",
              frs.container_id AS "containerId"
       FROM factory_raw_stock frs
       JOIN factory_containers fc ON fc.id = frs.container_id
       WHERE frs.company_id = $1
         AND fc.supplier_id = ANY($2)
         AND frs.deleted_at IS NULL`,
      [companyId, safeSupplierIds]
    ),
    client.query(
      `SELECT id,
              cost_per_kg AS "costPerKg",
              total_cost AS "totalCost",
              supplier_id AS "supplierId",
              container_id AS "containerId",
              source_batch_id AS "sourceBatchId",
              weight_kg AS "weightKg",
              quantity_kg AS "quantityKg",
              mix_batch_id AS "mixBatchId"
       FROM factory_mix_batch_sources
       WHERE id = ANY($1)`,
      [safeSourceIds]
    ),
    client.query(
      `SELECT id,
              cost_per_kg AS "costPerKg",
              total_cost AS "totalCost",
              total_weight_kg AS "totalWeightKg",
              status,
              used_kg AS "usedKg",
              company_id AS "companyId"
       FROM factory_mix_batches
       WHERE id = ANY($1)`,
      [safeBatchIds]
    ),
    client.query(
      `SELECT id,
              cost_per_kg AS "costPerKg",
              total_cost AS "totalCost",
              weight_kg AS "weightKg",
              status,
              mix_batch_id AS "mixBatchId",
              location_id AS "locationId",
              company_id AS "companyId"
       FROM factory_bales
       WHERE id = ANY($1) AND company_id = $2`,
      [safeBaleIds, companyId]
    ),
    client.query(
      `SELECT id,
              current_raw_material_cost_per_kg_usd AS "currentRawMaterialCostPerKgUsd"
       FROM factory_suppliers
       WHERE id = ANY($1) AND company_id = $2`,
      [safeSupplierIds, companyId]
    ),
    client.query(
      `SELECT id,
              rate_per_kg_usd AS "ratePerKgUsd",
              final_payable_amount AS "finalPayableAmount",
              final_payable_amount_usd AS "finalPayableAmountUsd",
              supplier_id AS "supplierId",
              status,
              actual_received_kg AS "actualReceivedKg",
              total_kg AS "totalKg"
       FROM factory_containers
       WHERE supplier_id = ANY($1) AND company_id = $2`,
      [safeSupplierIds, companyId]
    ),
  ]);

  return {
    rawStockRows: rawStockResult.rows,
    mixBatchSources: sourceResult.rows,
    mixBatches: batchResult.rows,
    bales: baleResult.rows,
    suppliers: supplierResult.rows,
    containers: containerResult.rows,
  };
}

export async function computeReplayWriteScope(
  companyId: number,
  requestedSupplierIds: number[],
  preview: HistoricalReplayPreviewResult,
  opts: { includeCompletedBatches: boolean; includeFinalizedBales: boolean },
  executor: ReplayQueryExecutor = pool as ReplayQueryExecutor
): Promise<{
  safeSupplierIds: Set<number>;
  containerIds: Set<number>;
  batchIdsToApply: Set<number>;
  sourceIds: Set<number>;
  baleCount: number;
}> {
  const safeSupplierIds = new Set(
    preview.supplierRows
      .filter(
        (supplier) =>
          supplier.safeToRepair &&
          (requestedSupplierIds.length === 0 || requestedSupplierIds.includes(supplier.supplierId))
      )
      .map((supplier) => supplier.supplierId)
  );
  if (safeSupplierIds.size === 0) {
    return { safeSupplierIds, containerIds: new Set(), batchIdsToApply: new Set(), sourceIds: new Set(), baleCount: 0 };
  }

  const { sourceInfos, batchInfoMap } = await buildBatchConsumptionEvents(executor, companyId, safeSupplierIds);
  const universe = await loadContainerUniverse(executor, companyId);
  const canonicals = await computeCanonicalCosts(executor, companyId, universe);
  const canonicalRates = new Map<number, number>();
  for (const canonical of canonicals) {
    if (!canonical.fxUnresolved) canonicalRates.set(canonical.universe.container.id, canonical.canonicalCostPerKgUsd);
  }
  const containerIds = new Set(
    preview.containerRows
      .filter(
        (container) =>
          !container.fxUnresolved && container.supplierId != null && safeSupplierIds.has(container.supplierId)
      )
      .map((container) => container.containerId)
  );
  const expectedRates = new Map<string, number>();
  for (const source of preview.sourceRows) {
    if (source.pricingBasis === "SUPPLIER_LOCKED_RATE" && source.supplierId != null) {
      const key = `${source.supplierId}:${source.batchId}`;
      if (!expectedRates.has(key)) expectedRates.set(key, source.expectedHistoricalCostPerKg);
    }
  }
  const { corrections } = computeBatchCorrections(batchInfoMap, sourceInfos, expectedRates, canonicalRates);
  const correctionIds = new Set(corrections.map((correction) => correction.batchId));
  const batchIdsToApply = new Set(
    preview.batchRows
      .filter((batch) => correctionIds.has(batch.batchId))
      .filter((batch) => opts.includeCompletedBatches || !["COMPLETED", "CLOSED"].includes(batch.status))
      .map((batch) => batch.batchId)
  );
  const sourceIds = new Set(
    preview.sourceRows
      .filter((source) => source.safeToRepair && batchIdsToApply.has(source.batchId))
      .filter((source) => {
        if (source.pricingBasis === "SUPPLIER_LOCKED_RATE" && source.supplierId != null)
          return safeSupplierIds.has(source.supplierId);
        if (source.pricingBasis === "CONTAINER_DIRECT" && source.containerId != null)
          return canonicalRates.has(source.containerId);
        return false;
      })
      .map((source) => source.sourceId)
  );

  let baleCount = 0;
  if (batchIdsToApply.size) {
    const result = await executor.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt
       FROM factory_bales fb
       WHERE fb.mix_batch_id = ANY($1)
         AND fb.company_id = $2
         AND ${buildNotFinalizedClause(opts.includeFinalizedBales)}`,
      [[...batchIdsToApply], companyId]
    );
    baleCount = Number.parseInt(result.rows[0]?.cnt ?? "0", 10);
  }
  return { safeSupplierIds, containerIds, batchIdsToApply, sourceIds, baleCount };
}
