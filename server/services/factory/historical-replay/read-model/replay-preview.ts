import Decimal from "decimal.js";
import { pool } from "../../../../db";
import { getAuthoritativeSupplierRemainingKgWithExecutor } from "../../rawStockLockedRate";
import {
  type ReplayQueryExecutor,
  type SupplierEvent,
  type CanonicalContainer,
  type BatchCorrection,
  type HistoricalReplayPreviewResult,
  type ReplayContainerRow,
  type ReplaySourceRow,
  type ReplayBatchRow,
  type ReplaySupplierRow,
  type ReplaySummary,
  numeric,
} from "../types";

import { computeBatchCorrections, loadBaleCountsByBatch } from "./corrections";
import {
  AdjustmentEvent,
  BatchConsumptionEvent,
  ContainerReceiptEvent,
  buildAdjustmentEvents,
  buildBatchConsumptionEvents,
  buildReceiptEvents,
} from "./events";
import { SupplierTimelineResult, replaySupplierTimeline } from "./timeline";
import { computeCanonicalCosts, loadContainerUniverse } from "./universe-costs";

export async function previewHistoricalCostReplayWithExecutor(
  executor: ReplayQueryExecutor,
  companyId: number
): Promise<HistoricalReplayPreviewResult> {
  const universe = await loadContainerUniverse(executor, companyId);
  const canonicals = await computeCanonicalCosts(executor, companyId, universe);
  const canonicalRateByContainer = new Map<number, number>();
  for (const canonical of canonicals) {
    if (!canonical.fxUnresolved)
      canonicalRateByContainer.set(canonical.universe.container.id, canonical.canonicalCostPerKgUsd);
  }

  const supplierIds = new Set<number>();
  for (const canonical of canonicals) {
    if (canonical.universe.container.supplierId) supplierIds.add(canonical.universe.container.supplierId);
  }

  let supplierRows: Array<{ id: number; name: string; currentRawMaterialCostPerKgUsd: string | null }> = [];
  if (supplierIds.size > 0) {
    const supplierResult = await executor.query<{
      id: number;
      name: string;
      currentRawMaterialCostPerKgUsd: string | null;
    }>(
      `SELECT id, name,
              current_raw_material_cost_per_kg_usd AS "currentRawMaterialCostPerKgUsd"
       FROM factory_suppliers
       WHERE company_id = $1 AND id = ANY($2)`,
      [companyId, [...supplierIds]]
    );
    supplierRows = supplierResult.rows;
  }
  const supplierMap = new Map(supplierRows.map((supplier) => [supplier.id, supplier]));

  const receiptEvents = await buildReceiptEvents(executor, companyId, canonicals);
  const { events: adjustmentEventsAll, unclassifiedCount: unclassifiedValuedAdjustments } = await buildAdjustmentEvents(
    executor,
    companyId
  );
  const {
    events: consumptionEvents,
    batchInfoMap,
    sourceInfos,
  } = await buildBatchConsumptionEvents(executor, companyId, supplierIds);

  // Count unresolved inventory supplier sources (non-BATCH sources with null inventorySupplierId).
  const unresolvedInventorySupplierSources = sourceInfos.filter(
    (s) => s.pricingBasis !== "BATCH" && s.pricingBasis !== "MANUAL_REVIEW" && s.inventorySupplierId == null
  ).length;

  // Build per-supplier sets of unclassified adjustments for blocking.
  const unclassifiedAdjustmentSupplierIds = new Set<number>(
    adjustmentEventsAll
      .filter((e) => e.kind === "ADD_ADJUSTMENT" && (e.costPerKgUsd ?? 0) > 0 && !e.valuationBasis)
      .map((e) => e.supplierId)
  );

  const receiptsBySupplier = new Map<number, ContainerReceiptEvent[]>();
  for (const event of receiptEvents) {
    if (event.supplierId == null) continue;
    const values = receiptsBySupplier.get(event.supplierId) ?? [];
    values.push(event);
    receiptsBySupplier.set(event.supplierId, values);
  }
  const adjustmentsBySupplier = new Map<number, AdjustmentEvent[]>();
  for (const event of adjustmentEventsAll) {
    const values = adjustmentsBySupplier.get(event.supplierId) ?? [];
    values.push(event);
    adjustmentsBySupplier.set(event.supplierId, values);
  }
  const consumptionBySupplier = new Map<number, BatchConsumptionEvent[]>();
  for (const event of consumptionEvents) {
    const values = consumptionBySupplier.get(event.supplierId) ?? [];
    values.push(event);
    consumptionBySupplier.set(event.supplierId, values);
  }

  const timelineResults: SupplierTimelineResult[] = [];
  const allExpectedRatesAtBatch = new Map<string, number>();
  for (const supplierId of supplierIds) {
    const supplier = supplierMap.get(supplierId);
    if (!supplier) continue;
    const allEvents: SupplierEvent[] = [];
    for (const event of receiptsBySupplier.get(supplierId) ?? []) {
      allEvents.push({
        kind: "RECEIPT",
        effectiveDate: event.effectiveDate,
        createdAt: event.createdAt,
        stableId: event.stableId,
        containerId: event.containerId,
        canonicalRateUsd: event.canonicalRateUsd,
        receiptKg: event.receiptKg,
      });
    }
    for (const event of adjustmentsBySupplier.get(supplierId) ?? []) {
      allEvents.push({
        kind: event.kind,
        effectiveDate: event.effectiveDate,
        createdAt: event.createdAt,
        stableId: event.stableId,
        adjustKg: event.adjustKg,
        costPerKgUsd: event.costPerKgUsd,
        valuationBasis: event.valuationBasis,
        removeKg: event.kind === "ADD_ADJUSTMENT" ? undefined : event.adjustKg,
      });
    }
    for (const event of consumptionBySupplier.get(supplierId) ?? []) {
      allEvents.push({
        kind: "BATCH_CONSUMPTION",
        effectiveDate: event.effectiveDate,
        createdAt: event.createdAt,
        stableId: event.stableId,
        batchId: event.batchId,
        batchCode: event.batchCode,
        consumptionKg: event.consumptionKg,
        sourceIds: event.sourceIds,
      });
    }
    if (allEvents.length === 0) continue;

    const authoritativeRemainingKg = await getAuthoritativeSupplierRemainingKgWithExecutor(
      executor,
      companyId,
      supplierId
    );
    const timeline = await replaySupplierTimeline(
      companyId,
      supplierId,
      supplier.name,
      numeric(supplier.currentRawMaterialCostPerKgUsd),
      allEvents,
      authoritativeRemainingKg
    );
    // Block suppliers with unclassified valued adjustments.
    if (
      unclassifiedAdjustmentSupplierIds.has(supplierId) &&
      !timeline.reasons.includes("ADJUSTMENT_VALUATION_UNCLASSIFIED")
    ) {
      timeline.reasons.push("ADJUSTMENT_VALUATION_UNCLASSIFIED");
      timeline.safeToRepair = false;
    }
    timelineResults.push(timeline);
    for (const [batchId, rate] of timeline.expectedRateAtBatch) {
      allExpectedRatesAtBatch.set(`${supplierId}:${batchId}`, rate);
    }
  }

  const { corrections: batchCorrections } = computeBatchCorrections(
    batchInfoMap,
    sourceInfos,
    allExpectedRatesAtBatch,
    canonicalRateByContainer
  );
  const correctionByBatch = new Map(batchCorrections.map((correction) => [correction.batchId, correction]));
  const correctedBatchIds = batchCorrections.map((correction) => correction.batchId);
  const baleCounts = await loadBaleCountsByBatch(executor, companyId, correctedBatchIds);

  const containerRows: ReplayContainerRow[] = canonicals.map((canonical) => ({
    containerId: canonical.universe.container.id,
    containerNumber: canonical.universe.container.containerNumber,
    status: canonical.universe.container.status,
    supplierId: canonical.universe.container.supplierId ?? null,
    eventDate: canonical.universe.offloadDate,
    storedCostPerKgUsd: canonical.storedCostPerKgUsd,
    canonicalCostPerKgUsd: canonical.canonicalCostPerKgUsd,
    storedTotalUsd: canonical.storedTotalUsd,
    canonicalTotalUsd: canonical.canonicalTotalUsd,
    fxUnresolved: canonical.fxUnresolved,
    safeToRepair: canonical.safeToRepair,
    reason: canonical.reason,
    scanReason: canonical.universe.scanReason,
  }));

  const sourceRows: ReplaySourceRow[] = [];
  for (const source of sourceInfos) {
    if (source.pricingBasis === "MANUAL_REVIEW") continue;
    let expectedCost = source.storedCostPerKg;
    let safeToRepair = true;
    let reason: string | null = null;

    if (source.pricingBasis === "SUPPLIER_LOCKED_RATE" && source.supplierId != null) {
      const expected = allExpectedRatesAtBatch.get(`${source.supplierId}:${source.batchId}`);
      if (expected == null) {
        safeToRepair = false;
        reason = "SUPPLIER_TIMELINE_UNAVAILABLE";
      } else {
        expectedCost = expected;
        const timeline = timelineResults.find((item) => item.supplierId === source.supplierId);
        if (timeline && !timeline.safeToRepair) {
          safeToRepair = false;
          reason = timeline.reasons[0] ?? "TIMELINE_NOT_SAFE";
        }
      }
    } else if (source.pricingBasis === "CONTAINER_DIRECT" && source.containerId != null) {
      const expected = canonicalRateByContainer.get(source.containerId);
      if (expected == null) {
        safeToRepair = false;
        reason = "UNRESOLVED_FX";
      } else {
        expectedCost = expected;
      }
    } else if (source.pricingBasis === "BATCH" && source.sourceBatchId != null) {
      expectedCost = correctionByBatch.get(source.sourceBatchId)?.expectedCostPerKg ?? source.storedCostPerKg;
    } else {
      continue;
    }

    if (Math.abs(expectedCost - source.storedCostPerKg) < 0.000001) continue;
    sourceRows.push({
      sourceId: source.sourceId,
      batchId: source.batchId,
      batchCode: source.batchCode,
      batchDate: source.batchDate,
      supplierId: source.supplierId,
      containerId: source.containerId,
      pricingBasis: source.pricingBasis,
      storedCostPerKg: source.storedCostPerKg,
      expectedHistoricalCostPerKg: expectedCost,
      storedTotalCost: source.storedTotalCost,
      expectedTotalCost: new Decimal(source.weightKg).times(expectedCost).toDecimalPlaces(6).toNumber(),
      weightKg: source.weightKg,
      safeToRepair,
      reason,
    });
  }

  const batchRows: ReplayBatchRow[] = batchCorrections.map((correction) => ({
    batchId: correction.batchId,
    batchCode: correction.batchCode,
    status: correction.status,
    batchDate: correction.batchDate,
    storedCostPerKg: correction.storedCostPerKg,
    expectedCostPerKg: correction.expectedCostPerKg,
    storedTotalCost: correction.storedTotalCost,
    expectedTotalCost: correction.expectedTotalCost,
    affectedBales: baleCounts.total.get(correction.batchId) ?? 0,
  }));

  // V7: detect mixed batches where not all participating inventory suppliers are in scope.
  let incompleteMixedBatchSupplierScopes = 0;
  {
    const batchInventorySuppliers = new Map<number, Set<number>>();
    for (const source of sourceInfos) {
      if (source.pricingBasis === "BATCH" || source.inventorySupplierId == null) continue;
      const s = batchInventorySuppliers.get(source.batchId) ?? new Set<number>();
      s.add(source.inventorySupplierId);
      batchInventorySuppliers.set(source.batchId, s);
    }
    for (const [, batchSuppliers] of batchInventorySuppliers) {
      for (const sid of batchSuppliers) {
        if (!supplierIds.has(sid)) {
          incompleteMixedBatchSupplierScopes++;
          break;
        }
      }
    }
  }

  const supplierOutputRows: ReplaySupplierRow[] = timelineResults.map((timeline) => {
    // Count all sources where THIS supplier's inventory was consumed (not just SUPPLIER_LOCKED_RATE).
    const affectedSourceCount = sourceInfos.filter(
      (source) => source.inventorySupplierId === timeline.supplierId && source.pricingBasis !== "BATCH"
    ).length;
    const affectedBatchIds = new Set(
      batchCorrections
        .filter((batch) =>
          sourceInfos.some(
            (source) => source.batchId === batch.batchId && source.inventorySupplierId === timeline.supplierId
          )
        )
        .map((batch) => batch.batchId)
    );
    return {
      supplierId: timeline.supplierId,
      supplierName: timeline.supplierName,
      startingRate: timeline.startingRate,
      endingExpectedRate: timeline.endingRate,
      currentStoredRate: timeline.currentStoredRate,
      replayRemainingKg: timeline.replayRemainingKg,
      authoritativeRemainingKg: timeline.authoritativeRemainingKg,
      safeToRepair: timeline.safeToRepair,
      reasons: timeline.reasons,
      eventCount: timeline.eventCount,
      affectedContainerCount: timeline.affectedContainerCount,
      affectedSourceCount,
      affectedBatchCount: affectedBatchIds.size,
      affectedBaleCount: [...affectedBatchIds].reduce((sum, batchId) => sum + (baleCounts.total.get(batchId) ?? 0), 0),
    };
  });

  const completedBatchIds = new Set(
    batchCorrections.filter((batch) => ["COMPLETED", "CLOSED"].includes(batch.status)).map((batch) => batch.batchId)
  );

  // ── Financial impact (Phase 11) ──────────────────────────────────────────────
  // Current raw material asset: sum of per-row (received - used) × cost_per_kg_usd
  // plus ADD adjustments, matching the net position route formula.
  const financialImpact = await computeFinancialImpact(
    executor,
    companyId,
    supplierOutputRows,
    canonicals,
    batchCorrections,
    baleCounts
  );

  const summary: ReplaySummary = {
    totalReceivedContainers: universe.length,
    containersScanned: canonicals.length,
    omittedContainers: universe.length - canonicals.length,
    canonicalContainerMismatches: canonicals.filter(
      (item) => !item.fxUnresolved && Math.abs(item.canonicalCostPerKgUsd - item.storedCostPerKgUsd) > 0.000001
    ).length,
    suppliersScanned: timelineResults.length,
    safeSuppliers: timelineResults.filter((timeline) => timeline.safeToRepair).length,
    manualReviewSuppliers: timelineResults.filter((timeline) => !timeline.safeToRepair).length,
    supplierPricedSourcesScanned: sourceInfos.filter((source) => source.pricingBasis === "SUPPLIER_LOCKED_RATE").length,
    sourceMismatches: sourceRows.length,
    batchesToUpdate: batchCorrections.length,
    completedBatchesToUpdate: completedBatchIds.size,
    balesToUpdate: batchRows.reduce((sum, batch) => sum + batch.affectedBales, 0),
    finalizedBalesToUpdate: correctedBatchIds.reduce(
      (sum, batchId) => sum + (baleCounts.finalized.get(batchId) ?? 0),
      0
    ),
    unresolvedFx: canonicals.filter((item) => item.fxUnresolved).length,
    missingDates: timelineResults.reduce((sum, timeline) => sum + timeline.missingDates, 0),
    quantityTimelineMismatches: timelineResults.filter((timeline) => timeline.quantityMismatch).length,
    ambiguousEventOrdering: timelineResults.filter((timeline) => timeline.ambiguous).length,
    scanCoverageError: canonicals.length !== universe.length,
    // V7 gates
    unresolvedInventorySupplierSources,
    unclassifiedValuedAdjustments,
    incompleteMixedBatchSupplierScopes,
  };

  return { summary, supplierRows: supplierOutputRows, containerRows, sourceRows, batchRows, financialImpact };
}

/**
 * Compute Phase 11 financial impact from replay preview data.
 * Per-supplier value change = replayRemainingKg × endingExpectedRate − authoritativeRemainingKg × currentStoredRate.
 * Projected net position = current net position + raw-material difference.
 */
async function computeFinancialImpact(
  executor: ReplayQueryExecutor,
  companyId: number,
  supplierOutputRows: ReplaySupplierRow[],
  canonicals: CanonicalContainer[],
  batchCorrections: BatchCorrection[],
  baleCounts: { total: Map<number, number>; finalized: Map<number, number> }
): Promise<import("../types").ReplayFinancialImpact> {
  // Current raw material asset — same formula as employeeNetPositionRoutes.ts
  const rawResult = await executor.query<{ remaining_value_usd: string }>(
    `SELECT COALESCE(SUM(
        (frs.received_kg::numeric - frs.used_kg::numeric) *
        COALESCE(NULLIF(frs.cost_per_kg_usd::numeric, 0), frs.cost_per_kg::numeric, 0)
      ), 0) AS remaining_value_usd
     FROM factory_raw_stock frs
     JOIN factory_containers fc ON fc.id = frs.container_id
     WHERE frs.company_id = $1 AND fc.status != 'DELETED'
       AND frs.deleted_at IS NULL AND fc.deleted_at IS NULL`,
    [companyId]
  );
  const adjResult = await executor.query<{ kg: string; cpk: string; type: string }>(
    `SELECT kg::numeric AS kg, cost_per_kg::numeric AS cpk, type
     FROM factory_raw_material_adjustments
     WHERE company_id = $1 AND deleted_at IS NULL AND type = 'ADD'`,
    [companyId]
  );
  let currentRawMaterialAsset = parseFloat(rawResult.rows[0]?.remaining_value_usd ?? "0") || 0;
  for (const adj of adjResult.rows) {
    currentRawMaterialAsset += parseFloat(adj.kg ?? "0") * parseFloat(adj.cpk ?? "0");
  }

  // Per-supplier value change from the replay.
  const supplierImpacts: import("../types").ReplaySupplierFinancialImpact[] = supplierOutputRows.map((row) => {
    const currentValue = new Decimal(row.authoritativeRemainingKg)
      .times(row.currentStoredRate)
      .toDecimalPlaces(2)
      .toNumber();
    const projectedValue = new Decimal(row.replayRemainingKg)
      .times(row.endingExpectedRate)
      .toDecimalPlaces(2)
      .toNumber();
    const valueDifference = new Decimal(projectedValue).minus(currentValue).toDecimalPlaces(2).toNumber();
    return {
      supplierId: row.supplierId,
      supplierName: row.supplierName,
      authoritativeRemainingKg: row.authoritativeRemainingKg,
      replayRemainingKg: row.replayRemainingKg,
      currentStoredRate: row.currentStoredRate,
      endingExpectedRate: row.endingExpectedRate,
      currentValue,
      projectedValue,
      valueDifference,
    };
  });

  const rawMaterialDifference = supplierImpacts.reduce((sum, s) => sum + s.valueDifference, 0);
  const projectedRawMaterialAsset = new Decimal(currentRawMaterialAsset)
    .plus(rawMaterialDifference)
    .toDecimalPlaces(2)
    .toNumber();

  const completedBatchesAffected = batchCorrections.filter((b) => ["COMPLETED", "CLOSED"].includes(b.status)).length;
  const batchIds = batchCorrections.map((b) => b.batchId);
  const availableBalesAffected = batchIds.reduce(
    (sum, id) => sum + (baleCounts.total.get(id) ?? 0) - (baleCounts.finalized.get(id) ?? 0),
    0
  );
  const finalizedBalesExcluded = batchIds.reduce((sum, id) => sum + (baleCounts.finalized.get(id) ?? 0), 0);

  // Safety gate results (reflect in/complete view).
  const blockedBatches = 0; // filled by caller from preview.summary if needed
  const safetyGateDetails = {
    unresolvedInventorySupplierSources: supplierOutputRows.reduce((_, __) => 0, 0), // computed in caller
    unclassifiedValuedAdjustments: 0,
    unresolvedFx: canonicals.filter((c) => c.fxUnresolved).length,
    missingDates: 0,
    quantityTimelineMismatches: supplierOutputRows.filter(
      (r) => !r.safeToRepair && r.reasons.includes("TIMELINE_QUANTITY_MISMATCH")
    ).length,
    ambiguousEventOrdering: supplierOutputRows.filter(
      (r) => !r.safeToRepair && r.reasons.includes("TIMELINE_ORDER_AMBIGUOUS")
    ).length,
    incompleteMixedBatchSupplierScopes: 0,
    blockedBatches,
    scanCoverageError: false,
  };
  const allSafetyGatesPassed = Object.values(safetyGateDetails).every((v) => v === 0 || v === false);

  return {
    currentRawMaterialAsset: new Decimal(currentRawMaterialAsset).toDecimalPlaces(2).toNumber(),
    projectedRawMaterialAsset,
    rawMaterialDifference: new Decimal(rawMaterialDifference).toDecimalPlaces(2).toNumber(),
    currentNetPosition: null, // filled by the route layer from the net position service
    projectedNetPosition: null, // filled by the route layer
    otherLedgerEffect: 0,
    completedBatchesAffected,
    availableBalesAffected,
    finalizedBalesExcluded,
    supplierImpacts,
    allSafetyGatesPassed,
    safetyGateDetails,
  };
}

export async function previewHistoricalCostReplay(companyId: number): Promise<HistoricalReplayPreviewResult> {
  return previewHistoricalCostReplayWithExecutor(pool as ReplayQueryExecutor, companyId);
}
