// Extracted from ./source-mismatches.ts to keep that module under the source-size cap.
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import Decimal from "decimal.js";
import { db } from "../../../db";
import { MoneyDecimal, toMoney } from "../../../lib/money";
import {
  factoryContainerCommissions,
  factoryContainerOtherCharges,
  factoryContainers,
  factoryMixBatches,
  factoryMixBatchSources,
  factoryOffloadAdditionalCharges,
  factoryRawStock,
  factorySuppliers,
} from "@shared/schema";
import { computeCorrectContainerCost, COST_SCALE, costEquals } from "./cost-math";

export interface MixBatchSourceCostMismatchRow {
  sourceId: number;
  batchId: number;
  batchCode: string;
  batchStatus: string;
  containerId: number | null;
  containerNumber: string | null;
  containerStatus: string | null;
  supplierId: number | null;
  supplierName: string | null;
  weightKg: number;
  oldCostPerKgUsd: number;
  newCostPerKgUsd: number;
  oldTotalCost: number;
  newTotalCost: number;
  difference: number;
  fixable: boolean;
  reason: string;
  rawStockExists: boolean;
  remainingKg: number;
  fullyUsed: boolean;
}

/** Backward-compat type — all the old fields plus new ones. */
export type ZeroCostSourceRow = MixBatchSourceCostMismatchRow & {
  currentCostPerKg: number;
  correctedCostPerKg: number | null;
};

/**
 * Read-only scan for ALL mix-batch-source rows whose cost doesn't match the
 * container's authoritative corrected USD landed cost. Catches:
 *   - zero cost
 *   - nonzero but incorrect cost
 *   - incorrect totalCost even when costPerKg looks right
 */
export async function getMixBatchSourceCostMismatchPreview(
  companyId: number
): Promise<MixBatchSourceCostMismatchRow[]> {
  const rows = await db
    .select({
      src: factoryMixBatchSources,
      batch: factoryMixBatches,
      containerNumber: factoryContainers.containerNumber,
      containerStatus: factoryContainers.status,
      supplierName: factorySuppliers.name,
      supplierLockedRate: factorySuppliers.currentRawMaterialCostPerKgUsd,
      container: factoryContainers,
    })
    .from(factoryMixBatchSources)
    .innerJoin(factoryMixBatches, eq(factoryMixBatchSources.mixBatchId, factoryMixBatches.id))
    .leftJoin(factoryContainers, eq(factoryContainers.id, factoryMixBatchSources.containerId))
    .leftJoin(factorySuppliers, eq(factorySuppliers.id, factoryMixBatchSources.supplierId))
    .where(
      and(
        eq(factoryMixBatches.companyId, companyId),
        isNull(factoryMixBatches.deletedAt),
        sql`${factoryMixBatchSources.weightKg}::numeric > 0`
      )
    );

  if (rows.length === 0) return [];

  const containerIds = [...new Set(rows.map((r) => r.src.containerId).filter((id): id is number => id != null))];

  // Load raw-stock for existence checks
  const rawStockRows = containerIds.length
    ? await db
        .select()
        .from(factoryRawStock)
        .where(
          and(
            inArray(factoryRawStock.containerId, containerIds),
            eq(factoryRawStock.companyId, companyId),
            isNull(factoryRawStock.deletedAt)
          )
        )
    : [];
  const rawStockByContainer = new Map(rawStockRows.map((r) => [r.containerId as number, r]));

  // Load charges for corrected-cost computation
  const [allAdditionalCharges, allCommissions, allOtherCharges] = containerIds.length
    ? await Promise.all([
        db
          .select()
          .from(factoryOffloadAdditionalCharges)
          .where(inArray(factoryOffloadAdditionalCharges.containerId, containerIds)),
        db
          .select()
          .from(factoryContainerCommissions)
          .where(inArray(factoryContainerCommissions.containerId, containerIds)),
        db
          .select()
          .from(factoryContainerOtherCharges)
          .where(inArray(factoryContainerOtherCharges.containerId, containerIds)),
      ])
    : [[], [], []];

  const chargesByContainer = new Map();
  for (const c of allAdditionalCharges) {
    if (!chargesByContainer.has(c.containerId)) chargesByContainer.set(c.containerId, []);
    chargesByContainer.get(c.containerId)!.push(c);
  }
  const commissionByContainer = new Map();
  for (const c of allCommissions) {
    const ex = commissionByContainer.get(c.containerId);
    if (!ex || c.id > ex.id) commissionByContainer.set(c.containerId, c);
  }
  const otherChargesByContainer = new Map();
  for (const oc of allOtherCharges) {
    if (!otherChargesByContainer.has(oc.containerId)) otherChargesByContainer.set(oc.containerId, []);
    otherChargesByContainer.get(oc.containerId)!.push(oc);
  }

  // Compute corrected USD cost per container
  const correctedUsdByContainer = new Map<number, { costPerKgUsd: number; fxUnresolved: boolean }>();
  const uniqueContainers = new Map();
  for (const { container } of rows) {
    if (container && !uniqueContainers.has(container.id)) uniqueContainers.set(container.id, container);
  }
  for (const [cid, container] of uniqueContainers) {
    const computed = computeCorrectContainerCost(
      container,
      chargesByContainer.get(cid) || [],
      commissionByContainer.get(cid) || null,
      otherChargesByContainer.get(cid) || []
    );
    correctedUsdByContainer.set(cid, { costPerKgUsd: computed.costPerKgUsd, fxUnresolved: computed.fxUnresolved });
  }

  const result: MixBatchSourceCostMismatchRow[] = [];

  for (const { src, batch, containerNumber, containerStatus, supplierName, supplierLockedRate, container } of rows) {
    const weightKg = toMoney(src.weightKg).toNumber();
    const oldCostPerKgUsd = toMoney(src.costPerKg).toNumber();
    const oldTotalCost = toMoney(src.totalCost).toNumber();

    if (src.containerId == null) {
      // Supplier-type source (no specific container). Compare against the supplier's
      // current locked rate — this is the corrected receipt-weighted average computed
      // after a recalc apply. If the locked rate differs from the stored source cost,
      // the source is stale and can be auto-fixed.
      const lockedRate = toMoney(supplierLockedRate as string).toNumber();
      const newTotalCost =
        lockedRate > 0
          ? new Decimal(weightKg).times(new Decimal(lockedRate)).toDecimalPlaces(COST_SCALE).toNumber()
          : 0;
      const isStale = lockedRate > 0 && !costEquals(oldCostPerKgUsd, lockedRate);
      if (!isStale) {
        // Source cost matches the current supplier locked rate — no mismatch to report.
        continue;
      }
      result.push({
        sourceId: src.id,
        batchId: batch.id,
        batchCode: batch.batchCode,
        batchStatus: batch.status,
        containerId: null,
        containerNumber: null,
        containerStatus: null,
        supplierId: src.supplierId,
        supplierName: supplierName || null,
        weightKg,
        oldCostPerKgUsd,
        newCostPerKgUsd: lockedRate,
        oldTotalCost,
        newTotalCost,
        difference: new Decimal(lockedRate).minus(new Decimal(oldCostPerKgUsd)).toDecimalPlaces(COST_SCALE).toNumber(),
        fixable: true,
        reason: `Source cost differs from supplier's corrected locked rate (diff: ${(lockedRate - oldCostPerKgUsd).toFixed(COST_SCALE)}).`,
        rawStockExists: false,
        remainingKg: 0,
        fullyUsed: false,
      });
      continue;
    }

    const corrected = correctedUsdByContainer.get(src.containerId);
    if (!corrected) continue;

    if (corrected.fxUnresolved) {
      result.push({
        sourceId: src.id,
        batchId: batch.id,
        batchCode: batch.batchCode,
        batchStatus: batch.status,
        containerId: src.containerId,
        containerNumber: containerNumber || null,
        containerStatus: containerStatus || null,
        supplierId: src.supplierId,
        supplierName: supplierName || null,
        weightKg,
        oldCostPerKgUsd,
        newCostPerKgUsd: 0,
        oldTotalCost,
        newTotalCost: 0,
        difference: 0,
        fixable: false,
        reason: "Container FX rate is unresolved — cannot determine authoritative USD cost.",
        rawStockExists: rawStockByContainer.has(src.containerId),
        remainingKg: 0,
        fullyUsed: false,
      });
      continue;
    }

    const newCostPerKgUsd = corrected.costPerKgUsd;
    const newTotalCost = new Decimal(weightKg)
      .times(new Decimal(newCostPerKgUsd))
      .toDecimalPlaces(COST_SCALE)
      .toNumber();

    if (costEquals(oldCostPerKgUsd, newCostPerKgUsd) && costEquals(oldTotalCost, newTotalCost)) continue;

    const rawStock = rawStockByContainer.get(src.containerId);
    const containerReceivedKg = toMoney(container?.actualReceivedKg).toNumber();
    const rawStockUsedKg = rawStock ? toMoney(rawStock.usedKg).toNumber() : containerReceivedKg;
    const remainingKg = rawStock
      ? MoneyDecimal.max(0, toMoney(rawStock.receivedKg).minus(rawStockUsedKg)).toNumber()
      : 0;

    result.push({
      sourceId: src.id,
      batchId: batch.id,
      batchCode: batch.batchCode,
      batchStatus: batch.status,
      containerId: src.containerId,
      containerNumber: containerNumber || null,
      containerStatus: containerStatus || null,
      supplierId: src.supplierId,
      supplierName: supplierName || null,
      weightKg,
      oldCostPerKgUsd,
      newCostPerKgUsd,
      oldTotalCost,
      newTotalCost,
      difference: new Decimal(newCostPerKgUsd)
        .minus(new Decimal(oldCostPerKgUsd))
        .toDecimalPlaces(COST_SCALE)
        .toNumber(),
      fixable: newCostPerKgUsd > 0,
      reason:
        oldCostPerKgUsd === 0
          ? "Source has zero cost — container's authoritative USD landed cost is known."
          : `Source cost differs from container's authoritative USD landed cost (diff: ${(newCostPerKgUsd - oldCostPerKgUsd).toFixed(COST_SCALE)}).`,
      rawStockExists: !!rawStock,
      remainingKg,
      fullyUsed: containerReceivedKg > 0 && remainingKg === 0,
    });
  }

  return result.sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference));
}
