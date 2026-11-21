// Extracted from ./replay-preview.ts
import Decimal from "decimal.js";
import { getAuthoritativeSupplierRemainingKgWithExecutor } from "../../rawStockLockedRate";
import {
  type ReplayQueryExecutor,
  type SupplierEvent,
  type ReplayContainerRow,
  type ReplaySourceRow,
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

export async function previewHistoricalCostReplayWithExecutorPart1(executor: ReplayQueryExecutor, companyId: number) {
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
  return {
    universe,
    canonicals,
    supplierIds,
    unclassifiedValuedAdjustments,
    sourceInfos,
    unresolvedInventorySupplierSources,
    timelineResults,
    batchCorrections,
    correctedBatchIds,
    baleCounts,
    containerRows,
    sourceRows,
  };
}
