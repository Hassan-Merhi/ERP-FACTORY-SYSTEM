// Extracted from ./securePreview.ts
import type {
  HistoricalReplayPreviewResult,
  ReplayMissingSupplierTimelineRow,
  ReplayQueryExecutor,
  ReplaySafetyGateDetails,
  ReplayUnclassifiedAdjustmentRow,
} from "./types";
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

export async function loadV7SafetyState(
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
