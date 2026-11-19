import Decimal from "decimal.js";
import { pool } from "../../../db";
import type {
  HistoricalReplayPreviewResult,
  ReplayMissingSupplierTimelineRow,
  ReplayQueryExecutor,
  ReplaySafetyGateDetails,
  ReplayUnclassifiedAdjustmentRow,
} from "./types";
import { previewHistoricalCostReplayWithExecutor as previewHistoricalCostReplayWithExecutorBase } from "./read-model";
import { loadReplayAuthoritativeInputDigest, type ReplayPreviewWithAuthoritativeDigest } from "./fingerprint";
import { normalizePreviewPersistedContainerTotals } from "./canonicalCostsV6";
import {
  applyReceiptAdjustmentAmbiguityBlocks,
  findReceiptAdjustmentAmbiguitySupplierIds,
} from "./timelineAmbiguityV6";
import { loadMissingSupplierTimelineRows } from "./missingSupplierTimelineV7";
import { toMoney } from "../../../lib/money";

interface SourceSafetyRow {
  source_id: number;
  batch_id: number;
  batch_code: string;
  source_batch_id: number | null;
  supplier_id: number | null;
  container_id: number | null;
  inventory_supplier_id: number | null;
  weight_kg: string;
  upstream_exists: boolean;
}

function addBlockedReason(
  map: Map<number, { batchId: number; batchCode: string; reasons: Set<string> }>,
  batchId: number,
  batchCode: string,
  reason: string
): void {
  const current = map.get(batchId) ?? { batchId, batchCode, reasons: new Set<string>() };
  current.reasons.add(reason);
  map.set(batchId, current);
}

function findCycleBatchIds(rows: SourceSafetyRow[]): Set<number> {
  const upstreamsByBatch = new Map<number, Set<number>>();
  for (const row of rows) {
    if (row.source_batch_id == null || !row.upstream_exists) continue;
    const upstreams = upstreamsByBatch.get(row.batch_id) ?? new Set<number>();
    upstreams.add(row.source_batch_id);
    upstreamsByBatch.set(row.batch_id, upstreams);
  }

  const visiting = new Set<number>();
  const visited = new Set<number>();
  const cycleIds = new Set<number>();
  const stack: number[] = [];

  const visit = (batchId: number): void => {
    if (visited.has(batchId)) return;
    if (visiting.has(batchId)) {
      const start = stack.lastIndexOf(batchId);
      for (const id of stack.slice(Math.max(0, start))) cycleIds.add(id);
      cycleIds.add(batchId);
      return;
    }

    visiting.add(batchId);
    stack.push(batchId);
    for (const upstream of upstreamsByBatch.get(batchId) ?? []) visit(upstream);
    stack.pop();
    visiting.delete(batchId);
    visited.add(batchId);
  };

  for (const batchId of upstreamsByBatch.keys()) visit(batchId);
  return cycleIds;
}

async function loadV7SafetyState(
  executor: ReplayQueryExecutor,
  companyId: number,
  preview: HistoricalReplayPreviewResult
): Promise<{
  gateDetails: ReplaySafetyGateDetails;
  blockedBatches: Array<{ batchId: number; batchCode: string; reasons: string[] }>;
  unclassifiedAdjustmentRows: ReplayUnclassifiedAdjustmentRow[];
  missingSupplierTimelineRows: ReplayMissingSupplierTimelineRow[];
}> {
  const [sourceResult, adjustmentResult, missingSupplierTimelineRows] = await Promise.all([
    executor.query<SourceSafetyRow>(
      `SELECT mbs.id AS source_id,
              mbs.mix_batch_id AS batch_id,
              mb.batch_code,
              mbs.source_batch_id,
              mbs.supplier_id,
              mbs.container_id,
              mbs.inventory_supplier_id,
              mbs.weight_kg,
              (upstream.id IS NOT NULL) AS upstream_exists
       FROM factory_mix_batch_sources mbs
       JOIN factory_mix_batches mb
         ON mb.id = mbs.mix_batch_id
        AND mb.company_id = $1
        AND mb.deleted_at IS NULL
       LEFT JOIN factory_mix_batches upstream
         ON upstream.id = mbs.source_batch_id
        AND upstream.company_id = $1
        AND upstream.deleted_at IS NULL
       ORDER BY mbs.mix_batch_id, mbs.id`,
      [companyId]
    ),
    executor.query<{
      adjustment_id: number;
      supplier_id: number;
      supplier_name: string;
      date: string;
      kg: string;
      cost_per_kg: string;
      currency_code: string | null;
      reference: string | null;
      notes: string | null;
    }>(
      `SELECT a.id AS adjustment_id,
              a.supplier_id,
              s.name AS supplier_name,
              a.date,
              a.kg,
              a.cost_per_kg,
              a.currency_code,
              a.reference,
              a.notes
       FROM factory_raw_material_adjustments a
       JOIN factory_suppliers s
         ON s.id = a.supplier_id
        AND s.company_id = a.company_id
       WHERE a.company_id = $1
         AND a.deleted_at IS NULL
         AND UPPER(a.type) = 'ADD'
         AND COALESCE(a.cost_per_kg, 0) > 0
         AND a.valuation_basis IS NULL
       ORDER BY a.date, a.id`,
      [companyId]
    ),
    loadMissingSupplierTimelineRows(
      executor,
      companyId,
      preview.supplierRows.map((row) => row.supplierId)
    ),
  ]);

  const blockedByBatchId = new Map<number, { batchId: number; batchCode: string; reasons: Set<string> }>();

  let unresolvedInventorySupplierSources = 0;
  const previewSupplierIds = new Set(preview.supplierRows.map((row) => row.supplierId));
  const incompleteBatchIds = new Set<number>();

  for (const row of sourceResult.rows) {
    const weight = toMoney(row.weight_kg).toNumber();
    if (weight <= 0) {
      addBlockedReason(blockedByBatchId, row.batch_id, row.batch_code, "ZERO_WEIGHT_SOURCE");
    }

    if (row.source_batch_id != null) {
      if (!row.upstream_exists) {
        addBlockedReason(blockedByBatchId, row.batch_id, row.batch_code, "UPSTREAM_BATCH_MISSING");
      }
      continue;
    }

    if (row.inventory_supplier_id == null) {
      unresolvedInventorySupplierSources += 1;
      addBlockedReason(blockedByBatchId, row.batch_id, row.batch_code, "INVENTORY_SUPPLIER_UNRESOLVED");
    } else if (!previewSupplierIds.has(row.inventory_supplier_id)) {
      incompleteBatchIds.add(row.batch_id);
      addBlockedReason(blockedByBatchId, row.batch_id, row.batch_code, "MIXED_BATCH_SUPPLIER_SCOPE_INCOMPLETE");
    }

    if (row.supplier_id == null && row.container_id == null) {
      addBlockedReason(blockedByBatchId, row.batch_id, row.batch_code, "MANUAL_REVIEW_SOURCE");
    }
  }

  for (const cycleBatchId of findCycleBatchIds(sourceResult.rows)) {
    const row = sourceResult.rows.find((item) => item.batch_id === cycleBatchId);
    addBlockedReason(
      blockedByBatchId,
      cycleBatchId,
      row?.batch_code ?? `BATCH-${cycleBatchId}`,
      "BATCH_DEPENDENCY_CYCLE"
    );
  }

  for (const row of preview.sourceRows) {
    if (!row.safeToRepair && row.reason) {
      addBlockedReason(blockedByBatchId, row.batchId, row.batchCode, row.reason);
    }
  }

  const unclassifiedAdjustmentRows: ReplayUnclassifiedAdjustmentRow[] = adjustmentResult.rows.map((row) => ({
    adjustmentId: row.adjustment_id,
    supplierId: row.supplier_id,
    supplierName: row.supplier_name,
    date: row.date,
    kg: toMoney(row.kg).toNumber(),
    costPerKg: toMoney(row.cost_per_kg).toNumber(),
    currencyCode: row.currency_code || "USD",
    reference: row.reference,
    notes: row.notes,
  }));

  const blockedBatches = [...blockedByBatchId.values()]
    .sort((left, right) => left.batchId - right.batchId)
    .map((row) => ({
      batchId: row.batchId,
      batchCode: row.batchCode,
      reasons: [...row.reasons].sort(),
    }));

  const gateDetails: ReplaySafetyGateDetails = {
    unresolvedInventorySupplierSources,
    unclassifiedValuedAdjustments: unclassifiedAdjustmentRows.length,
    unresolvedFx: preview.summary.unresolvedFx,
    missingDates: preview.summary.missingDates,
    quantityTimelineMismatches: preview.summary.quantityTimelineMismatches,
    ambiguousEventOrdering: preview.summary.ambiguousEventOrdering,
    incompleteMixedBatchSupplierScopes: incompleteBatchIds.size,
    missingSupplierTimelines: missingSupplierTimelineRows.length,
    blockedBatches: blockedBatches.length,
    scanCoverageError: preview.summary.scanCoverageError,
  };

  return {
    gateDetails,
    blockedBatches,
    unclassifiedAdjustmentRows,
    missingSupplierTimelineRows,
  };
}

async function computeManualRawMaterialAsset(executor: ReplayQueryExecutor, companyId: number): Promise<number> {
  const [rawResult, adjustmentResult] = await Promise.all([
    executor.query<{ remaining_value_usd: string }>(
      `SELECT COALESCE(SUM(
          (frs.received_kg::numeric - frs.used_kg::numeric) *
          COALESCE(NULLIF(frs.cost_per_kg_usd::numeric, 0), frs.cost_per_kg::numeric, 0)
        ), 0) AS remaining_value_usd
       FROM factory_raw_stock frs
       JOIN factory_containers fc ON fc.id = frs.container_id
       WHERE frs.company_id = $1
         AND fc.company_id = $1
         AND fc.supplier_id IS NULL
         AND fc.status != 'DELETED'
         AND frs.deleted_at IS NULL
         AND fc.deleted_at IS NULL`,
      [companyId]
    ),
    executor.query<{
      id: number;
      type: string;
      kg: string;
      cost_per_kg: string;
      material_label: string | null;
    }>(
      `SELECT id, type, kg, cost_per_kg, material_label
       FROM factory_raw_material_adjustments
       WHERE company_id = $1
         AND supplier_id IS NULL
         AND deleted_at IS NULL
       ORDER BY date, created_at, id`,
      [companyId]
    ),
  ]);

  let total = new Decimal(rawResult.rows[0]?.remaining_value_usd ?? 0);
  const buckets = new Map<string, { kg: Decimal; value: Decimal }>();

  for (const row of adjustmentResult.rows) {
    const type = String(row.type).toUpperCase();
    if (type === "DEDUCT") continue;
    const key = row.material_label || "unknown";
    const bucket = buckets.get(key) ?? { kg: new Decimal(0), value: new Decimal(0) };
    const kg = new Decimal(row.kg ?? 0);
    const cost = new Decimal(row.cost_per_kg ?? 0);

    if (type === "ADD") {
      bucket.kg = bucket.kg.plus(kg);
      bucket.value = bucket.value.plus(kg.times(cost));
    } else if (kg.gt(0)) {
      const average = bucket.kg.gt(0) ? bucket.value.div(bucket.kg) : new Decimal(0);
      bucket.kg = bucket.kg.minus(kg);
      bucket.value = bucket.value.minus(kg.times(average));
    }
    buckets.set(key, bucket);
  }

  for (const bucket of buckets.values()) total = total.plus(bucket.value);
  return total.toDecimalPlaces(2).toNumber();
}

function allSafetyGatesPassed(details: ReplaySafetyGateDetails): boolean {
  return (
    details.unresolvedInventorySupplierSources === 0 &&
    details.unclassifiedValuedAdjustments === 0 &&
    details.unresolvedFx === 0 &&
    details.missingDates === 0 &&
    details.quantityTimelineMismatches === 0 &&
    details.ambiguousEventOrdering === 0 &&
    details.incompleteMixedBatchSupplierScopes === 0 &&
    details.missingSupplierTimelines === 0 &&
    details.blockedBatches === 0 &&
    details.scanCoverageError === false
  );
}

export async function previewHistoricalCostReplayWithExecutor(
  executor: ReplayQueryExecutor,
  companyId: number
): Promise<ReplayPreviewWithAuthoritativeDigest> {
  const [basePreview, authoritative, ambiguousSupplierIds] = await Promise.all([
    previewHistoricalCostReplayWithExecutorBase(executor, companyId),
    loadReplayAuthoritativeInputDigest(executor, companyId),
    findReceiptAdjustmentAmbiguitySupplierIds(executor, companyId),
  ]);
  const persistedTargetPreview = await normalizePreviewPersistedContainerTotals(executor, companyId, basePreview);
  const preview = applyReceiptAdjustmentAmbiguityBlocks(persistedTargetPreview, ambiguousSupplierIds);

  const [safety, manualRawMaterialAsset] = await Promise.all([
    loadV7SafetyState(executor, companyId, preview),
    computeManualRawMaterialAsset(executor, companyId),
  ]);
  preview.summary.unresolvedInventorySupplierSources = safety.gateDetails.unresolvedInventorySupplierSources;
  preview.summary.unclassifiedValuedAdjustments = safety.gateDetails.unclassifiedValuedAdjustments;
  preview.summary.incompleteMixedBatchSupplierScopes = safety.gateDetails.incompleteMixedBatchSupplierScopes;
  preview.summary.missingSupplierTimelines = safety.gateDetails.missingSupplierTimelines;
  preview.summary.blockedBatches = safety.gateDetails.blockedBatches;
  preview.blockedBatches = safety.blockedBatches;
  preview.unclassifiedAdjustmentRows = safety.unclassifiedAdjustmentRows;
  preview.missingSupplierTimelineRows = safety.missingSupplierTimelineRows;

  if (preview.financialImpact) {
    const supplierImpacts = preview.supplierRows.map((row) => {
      const currentValue = new Decimal(row.authoritativeRemainingKg)
        .times(row.currentStoredRate)
        .toDecimalPlaces(2)
        .toNumber();
      const projectedValue = new Decimal(row.replayRemainingKg)
        .times(row.endingExpectedRate)
        .toDecimalPlaces(2)
        .toNumber();
      return {
        supplierId: row.supplierId,
        supplierName: row.supplierName,
        authoritativeRemainingKg: row.authoritativeRemainingKg,
        replayRemainingKg: row.replayRemainingKg,
        currentStoredRate: row.currentStoredRate,
        endingExpectedRate: row.endingExpectedRate,
        currentValue,
        projectedValue,
        valueDifference: new Decimal(projectedValue).minus(currentValue).toDecimalPlaces(2).toNumber(),
      };
    });
    const currentSupplierAsset = supplierImpacts.reduce((sum, row) => sum.plus(row.currentValue), new Decimal(0));
    const projectedSupplierAsset = supplierImpacts.reduce((sum, row) => sum.plus(row.projectedValue), new Decimal(0));
    const currentRawMaterialAsset = currentSupplierAsset.plus(manualRawMaterialAsset).toDecimalPlaces(2).toNumber();
    const projectedRawMaterialAsset = projectedSupplierAsset.plus(manualRawMaterialAsset).toDecimalPlaces(2).toNumber();
    const rawMaterialDifference = new Decimal(projectedRawMaterialAsset)
      .minus(currentRawMaterialAsset)
      .toDecimalPlaces(2)
      .toNumber();

    preview.financialImpact.supplierImpacts = supplierImpacts;
    preview.financialImpact.currentRawMaterialAsset = currentRawMaterialAsset;
    preview.financialImpact.projectedRawMaterialAsset = projectedRawMaterialAsset;
    preview.financialImpact.rawMaterialDifference = rawMaterialDifference;
    preview.financialImpact.safetyGateDetails = safety.gateDetails;
    preview.financialImpact.allSafetyGatesPassed = allSafetyGatesPassed(safety.gateDetails);
    preview.financialImpact.otherLedgerEffect = 0;
    if (preview.financialImpact.currentNetPosition != null) {
      preview.financialImpact.projectedNetPosition = new Decimal(preview.financialImpact.currentNetPosition)
        .plus(rawMaterialDifference)
        .toDecimalPlaces(2)
        .toNumber();
    }
  }

  return Object.assign(preview, {
    authoritativeInputDigest: authoritative.digest,
    authoritativeInputCounts: authoritative.counts,
  });
}

export async function previewHistoricalCostReplay(companyId: number): Promise<ReplayPreviewWithAuthoritativeDigest> {
  return previewHistoricalCostReplayWithExecutor(pool as ReplayQueryExecutor, companyId);
}
