import { eq, and, isNull, sql, inArray } from "drizzle-orm";
import Decimal from "decimal.js";
import { db } from "../../../db";
import { factoryContainers, factoryMixBatchSources, factoryMixBatches, factoryBales } from "@shared/schema";
import { COST_SCALE, costEquals } from "./cost-math";
import { COMPLETED_BATCH_STATUSES, OPEN_BATCH_STATUSES, RecalcRow, getRawStockRecalcPreview } from "./preview";
import { toMoney } from "../../../lib/money";

export interface BatchSourceChange {
  sourceId: number;
  containerId: number | null;
  containerNumber: string | null;
  weightKg: number;
  oldCostPerKgUsd: number;
  newCostPerKgUsd: number;
  oldTotalCost: number;
  newTotalCost: number;
  changed: boolean;
}

export interface BatchCostPreviewResult {
  newCostPerKg: Decimal;
  newTotalCost: Decimal;
  totalWeightKg: Decimal;
  weightKgFromSelectedContainers: Decimal;
  sourceChanges: BatchSourceChange[];
}

/**
 * Pure Decimal.js weighted-average recompute for ONE batch, given a map of
 * corrected USD costs for the containers being repaired.
 * Sources whose container is NOT in the map keep their current stored cost.
 * Mirrors the exact arithmetic that recomputeBatchAndCascadeBales uses — so
 * preview === apply.
 */
export function calculateBatchCostPreview(
  allSources: Array<{ src: typeof factoryMixBatchSources.$inferSelect; containerNumber: string | null }>,
  correctedCostUsdByContainer: Map<number, Decimal>
): BatchCostPreviewResult {
  let dTotalCost = new Decimal(0);
  let dTotalWeight = new Decimal(0);
  let dWeightFromSelected = new Decimal(0);
  const sourceChanges: BatchSourceChange[] = [];

  for (const { src, containerNumber } of allSources) {
    const dWeight = new Decimal(src.weightKg || "0");
    const correctedUsd = src.containerId != null ? correctedCostUsdByContainer.get(src.containerId) : undefined;
    const oldCostPerKgUsd = toMoney(src.costPerKg).toNumber();
    const dEffectiveCost = correctedUsd !== undefined ? correctedUsd : new Decimal(oldCostPerKgUsd);
    const dSourceTotalCost = dWeight.times(dEffectiveCost);
    const oldTotalCost = toMoney(src.totalCost).toNumber();

    dTotalCost = dTotalCost.plus(dSourceTotalCost);
    dTotalWeight = dTotalWeight.plus(dWeight);
    if (correctedUsd !== undefined) {
      dWeightFromSelected = dWeightFromSelected.plus(dWeight);
    }

    sourceChanges.push({
      sourceId: src.id,
      containerId: src.containerId,
      containerNumber: containerNumber || null,
      weightKg: dWeight.toNumber(),
      oldCostPerKgUsd,
      newCostPerKgUsd: dEffectiveCost.toDecimalPlaces(COST_SCALE).toNumber(),
      oldTotalCost,
      newTotalCost: dSourceTotalCost.toDecimalPlaces(COST_SCALE).toNumber(),
      changed: correctedUsd !== undefined && !costEquals(oldCostPerKgUsd, dEffectiveCost.toNumber()),
    });
  }

  const newCostPerKg = dTotalWeight.gt(0) ? dTotalCost.div(dTotalWeight).toDecimalPlaces(COST_SCALE) : new Decimal(0);

  return {
    newCostPerKg,
    newTotalCost: dTotalCost,
    totalWeightKg: dTotalWeight,
    weightKgFromSelectedContainers: dWeightFromSelected,
    sourceChanges,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// getAffectedMixBatchesPreview
// ─────────────────────────────────────────────────────────────────────────────

export interface AffectedMixBatchPreviewRow {
  batchId: number;
  batchCode: string;
  name: string | null;
  status: string;
  batchDate: string | null;
  wasCompleted: boolean;
  totalWeightKg: number;
  weightKgFromSelectedContainers: number;
  oldCostPerKg: number;
  newCostPerKg: number;
  oldTotalCost: number;
  newTotalCost: number;
  costDifferencePerKg: number;
  totalCostDifference: number;
  diffPct: number;
  baleCount: number;
  sourceContainerNumbers: string[];
  sourceChanges: BatchSourceChange[];
}

export async function getAffectedMixBatchesPreview(
  companyId: number,
  containerIds: number[],
  includeCompletedBatches: boolean,
  previewRows?: RecalcRow[]
): Promise<AffectedMixBatchPreviewRow[]> {
  if (containerIds.length === 0) return [];

  const preview = previewRows ?? (await getRawStockRecalcPreview(companyId));

  // Build corrected USD cost map — use costPerKgUsd (sources are USD-denominated)
  const correctedCostUsdByContainer = new Map<number, Decimal>(
    preview
      .filter((r) => containerIds.includes(r.containerId) && !r.fxUnresolved)
      .map((r) => [r.containerId, new Decimal(r.next.costPerKgUsd)])
  );
  if (correctedCostUsdByContainer.size === 0) return [];

  const statusFilter = includeCompletedBatches
    ? [...OPEN_BATCH_STATUSES, ...COMPLETED_BATCH_STATUSES]
    : OPEN_BATCH_STATUSES;

  const sourceRows = await db
    .select({
      src: factoryMixBatchSources,
      batch: factoryMixBatches,
      containerNumber: factoryContainers.containerNumber,
    })
    .from(factoryMixBatchSources)
    .innerJoin(factoryMixBatches, eq(factoryMixBatchSources.mixBatchId, factoryMixBatches.id))
    .leftJoin(factoryContainers, eq(factoryContainers.id, factoryMixBatchSources.containerId))
    .where(
      and(
        inArray(factoryMixBatchSources.containerId, [...correctedCostUsdByContainer.keys()]),
        eq(factoryMixBatches.companyId, companyId),
        inArray(factoryMixBatches.status, statusFilter),
        isNull(factoryMixBatches.deletedAt)
      )
    );

  const touchedBatchIds = [...new Set(sourceRows.map((r) => r.batch.id))];
  if (touchedBatchIds.length === 0) return [];

  const [allSourcesForTouchedBatches, baleCounts] = await Promise.all([
    db
      .select({ src: factoryMixBatchSources, containerNumber: factoryContainers.containerNumber })
      .from(factoryMixBatchSources)
      .leftJoin(factoryContainers, eq(factoryContainers.id, factoryMixBatchSources.containerId))
      .where(inArray(factoryMixBatchSources.mixBatchId, touchedBatchIds)),
    db
      .select({ mixBatchId: factoryBales.mixBatchId, count: sql<number>`count(*)` })
      .from(factoryBales)
      .where(
        and(
          inArray(factoryBales.mixBatchId, touchedBatchIds),
          eq(factoryBales.companyId, companyId),
          sql`${factoryBales.status} NOT IN ('DELETED','REMOVED')`
        )
      )
      .groupBy(factoryBales.mixBatchId),
  ]);

  const baleCountByBatch = new Map(baleCounts.map((b) => [b.mixBatchId as number, Number(b.count)]));
  const batchById = new Map(sourceRows.map((r) => [r.batch.id, r.batch]));

  const results: AffectedMixBatchPreviewRow[] = [];
  for (const batchId of touchedBatchIds) {
    const batch = batchById.get(batchId)!;
    const sourcesForBatch = allSourcesForTouchedBatches.filter((r) => r.src.mixBatchId === batchId);
    const calc = calculateBatchCostPreview(sourcesForBatch, correctedCostUsdByContainer);

    const oldCostPerKg = toMoney(batch.costPerKg).toNumber();
    const newCostPerKg = calc.newCostPerKg.toNumber();
    const oldTotalCost = calc.totalWeightKg.times(new Decimal(oldCostPerKg)).toNumber();
    const newTotalCost = calc.newTotalCost.toNumber();
    const diffPct = oldCostPerKg > 0 ? ((newCostPerKg - oldCostPerKg) / oldCostPerKg) * 100 : 0;

    const containerNumbers = new Set<string>();
    for (const { src, containerNumber } of sourcesForBatch) {
      if (containerNumber && src.containerId != null && correctedCostUsdByContainer.has(src.containerId)) {
        containerNumbers.add(containerNumber);
      }
    }

    results.push({
      batchId,
      batchCode: batch.batchCode,
      name: batch.name,
      status: batch.status,
      batchDate: batch.batchDate ? String(batch.batchDate) : null,
      wasCompleted: COMPLETED_BATCH_STATUSES.includes(batch.status),
      totalWeightKg: calc.totalWeightKg.toNumber(),
      weightKgFromSelectedContainers: calc.weightKgFromSelectedContainers.toNumber(),
      oldCostPerKg,
      newCostPerKg,
      oldTotalCost,
      newTotalCost,
      costDifferencePerKg: new Decimal(newCostPerKg)
        .minus(new Decimal(oldCostPerKg))
        .toDecimalPlaces(COST_SCALE)
        .toNumber(),
      totalCostDifference: new Decimal(newTotalCost)
        .minus(new Decimal(oldTotalCost))
        .toDecimalPlaces(COST_SCALE)
        .toNumber(),
      diffPct,
      baleCount: baleCountByBatch.get(batchId) || 0,
      sourceContainerNumbers: [...containerNumbers],
      sourceChanges: calc.sourceChanges,
    });
  }

  results.sort((a, b) => Math.abs(b.diffPct) - Math.abs(a.diffPct));
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// applyRawStockRecalc
// ─────────────────────────────────────────────────────────────────────────────
