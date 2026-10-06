import { eq, and, isNull, sql, inArray } from "drizzle-orm";
import Decimal from "decimal.js";
import { db } from "../../../db";
import { MoneyDecimal, toMoney } from "../../../lib/money";
import {
  factoryContainers,
  factoryRawStock,
  factoryOffloadAdditionalCharges,
  factoryContainerCommissions,
  factoryContainerOtherCharges,
  factorySuppliers,
  factoryMixBatchSources,
  factoryMixBatches,
} from "@shared/schema";
import { recomputeBatchAndCascadeBales } from "../rawStockCostCascade";
import { COST_SCALE, computeCorrectContainerCost, costEquals, costRound } from "./cost-math";

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

/** Backward-compat: returns only zero-cost rows from the full mismatch scan. */
export async function getZeroCostMixBatchSourcesPreview(companyId: number): Promise<ZeroCostSourceRow[]> {
  const all = await getMixBatchSourceCostMismatchPreview(companyId);
  return all
    .filter((r) => r.oldCostPerKgUsd === 0)
    .map((r) => ({
      ...r,
      currentCostPerKg: r.oldCostPerKgUsd,
      correctedCostPerKg: r.newCostPerKgUsd > 0 ? r.newCostPerKgUsd : null,
    }));
}

// ─────────────────────────────────────────────────────────────────────────────
// applyZeroCostMixBatchSourcesFix
// ─────────────────────────────────────────────────────────────────────────────

const ZERO_COST_SOURCE_LOCK_NAMESPACE = 9002;

export interface ZeroCostSourceFixResult {
  sourceId: number;
  batchId: number;
  batchCode: string;
  applied: boolean;
  skippedReason?: string;
  costPerKgApplied?: number;
  affectedBales: number;
}

/**
 * Apply the fix for a specific set of mix-batch-source rows (zero-cost or
 * any mismatch). Container-linked sources use the container's authoritative
 * USD cost/kg (costPerKgUsd, not costPerKg). Manual rates only for no-container sources.
 */
export async function applyZeroCostMixBatchSourcesFix(
  companyId: number,
  sourceIds: number[],
  opts: {
    manualRates?: Record<number, number>;
    onAudit?: (
      tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
      result: ZeroCostSourceFixResult
    ) => Promise<void>;
  } = {}
): Promise<ZeroCostSourceFixResult[]> {
  const results: ZeroCostSourceFixResult[] = [];

  for (const sourceId of sourceIds) {
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${ZERO_COST_SOURCE_LOCK_NAMESPACE}, ${sourceId})`);

      const [src] = await tx
        .select()
        .from(factoryMixBatchSources)
        .where(and(eq(factoryMixBatchSources.id, sourceId)))
        .for("update");
      if (!src) return null;

      const [batch] = await tx
        .select()
        .from(factoryMixBatches)
        .where(and(eq(factoryMixBatches.id, src.mixBatchId), eq(factoryMixBatches.companyId, companyId)));
      if (!batch) return null;

      const weightKg = toMoney(src.weightKg).toNumber();
      if (weightKg <= 0) {
        return {
          sourceId,
          batchId: batch.id,
          batchCode: batch.batchCode,
          applied: false,
          skippedReason: "Source has zero weight.",
          affectedBales: 0,
        } as ZeroCostSourceFixResult;
      }

      let correctedCostPerKgUsd: number | null = null;

      if (src.containerId != null) {
        // Container-linked: use costPerKgUsd (mix-batch sources are USD-denominated)
        const [rawStock] = await tx
          .select()
          .from(factoryRawStock)
          .where(
            and(
              eq(factoryRawStock.containerId, src.containerId),
              eq(factoryRawStock.companyId, companyId),
              isNull(factoryRawStock.deletedAt)
            )
          );

        if (rawStock) {
          correctedCostPerKgUsd = toMoney(rawStock.costPerKgUsd).toNumber();
        } else {
          // No active raw-stock: derive from container record
          const [container] = await tx
            .select()
            .from(factoryContainers)
            .where(and(eq(factoryContainers.id, src.containerId), eq(factoryContainers.companyId, companyId)));
          if (container) {
            const [addl, comms, ocs] = await Promise.all([
              tx
                .select()
                .from(factoryOffloadAdditionalCharges)
                .where(
                  and(
                    eq(factoryOffloadAdditionalCharges.containerId, src.containerId),
                    eq(factoryOffloadAdditionalCharges.companyId, companyId)
                  )
                ),
              tx
                .select()
                .from(factoryContainerCommissions)
                .where(
                  and(
                    eq(factoryContainerCommissions.containerId, src.containerId),
                    eq(factoryContainerCommissions.companyId, companyId)
                  )
                ),
              tx
                .select()
                .from(factoryContainerOtherCharges)
                .where(
                  and(
                    eq(factoryContainerOtherCharges.containerId, src.containerId),
                    eq(factoryContainerOtherCharges.companyId, companyId)
                  )
                ),
            ]);
            const comm = comms.sort((a, b) => b.id - a.id)[0] || null;
            const computed = computeCorrectContainerCost(container, addl, comm, ocs);
            if (!computed.fxUnresolved && computed.costPerKgUsd > 0) {
              correctedCostPerKgUsd = computed.costPerKgUsd;
            }
          }
        }

        if (!correctedCostPerKgUsd || correctedCostPerKgUsd <= 0) {
          return {
            sourceId,
            batchId: batch.id,
            batchCode: batch.batchCode,
            applied: false,
            skippedReason: "Container has no resolvable USD cost.",
            affectedBales: 0,
          } as ZeroCostSourceFixResult;
        }
      } else {
        // Supplier-type source (containerId=null): prefer the supplier's current
        // locked rate (set by recomputeSupplierRates after a recalc apply). Fall
        // back to a manually supplied rate if available.
        const manualRate = opts.manualRates?.[sourceId];
        if (src.supplierId != null) {
          const [supplierRow] = await tx
            .select({ currentRawMaterialCostPerKgUsd: factorySuppliers.currentRawMaterialCostPerKgUsd })
            .from(factorySuppliers)
            .where(and(eq(factorySuppliers.id, src.supplierId), eq(factorySuppliers.companyId, companyId)));
          const lockedRate = toMoney(supplierRow?.currentRawMaterialCostPerKgUsd as string).toNumber();
          if (lockedRate > 0) {
            correctedCostPerKgUsd = lockedRate;
          } else if (manualRate && manualRate > 0) {
            correctedCostPerKgUsd = manualRate;
          } else {
            return {
              sourceId,
              batchId: batch.id,
              batchCode: batch.batchCode,
              applied: false,
              skippedReason: "Supplier has no corrected locked rate yet — run Recompute Supplier Rates first.",
              affectedBales: 0,
            } as ZeroCostSourceFixResult;
          }
        } else if (manualRate && manualRate > 0) {
          correctedCostPerKgUsd = manualRate;
        } else {
          return {
            sourceId,
            batchId: batch.id,
            batchCode: batch.batchCode,
            applied: false,
            skippedReason: "Direct-from-supplier source — requires a manually entered cost/kg.",
            affectedBales: 0,
          } as ZeroCostSourceFixResult;
        }
      }

      // Idempotency check
      const newTotalCost = new Decimal(weightKg)
        .times(new Decimal(correctedCostPerKgUsd))
        .toDecimalPlaces(COST_SCALE)
        .toFixed(COST_SCALE);
      if (costEquals(src.costPerKg, correctedCostPerKgUsd) && costEquals(src.totalCost, newTotalCost)) {
        return {
          sourceId,
          batchId: batch.id,
          batchCode: batch.batchCode,
          applied: false,
          skippedReason: "Source cost already matches — idempotent no-op.",
          affectedBales: 0,
        } as ZeroCostSourceFixResult;
      }

      await tx
        .update(factoryMixBatchSources)
        .set({
          costPerKg: costRound(correctedCostPerKgUsd),
          totalCost: newTotalCost,
        })
        .where(eq(factoryMixBatchSources.id, sourceId));

      const { bales } = await recomputeBatchAndCascadeBales(tx, companyId, batch.id);

      const fixResult: ZeroCostSourceFixResult = {
        sourceId,
        batchId: batch.id,
        batchCode: batch.batchCode,
        applied: true,
        costPerKgApplied: correctedCostPerKgUsd,
        affectedBales: bales.length,
      };

      if (opts.onAudit) {
        await opts.onAudit(tx, fixResult);
      }

      return fixResult;
    });

    if (result) results.push(result);
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// getFullAuditScan
// ─────────────────────────────────────────────────────────────────────────────
