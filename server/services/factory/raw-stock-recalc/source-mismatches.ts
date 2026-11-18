import { eq, and, isNull, sql } from "drizzle-orm";
import Decimal from "decimal.js";
import { db } from "../../../db";
import { toMoney } from "../../../lib/money";
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
import { getMixBatchSourceCostMismatchPreview, type ZeroCostSourceRow } from "./getMixBatchSourceCostMismatchPreview";
export { getMixBatchSourceCostMismatchPreview } from "./getMixBatchSourceCostMismatchPreview";
export type { MixBatchSourceCostMismatchRow, ZeroCostSourceRow } from "./getMixBatchSourceCostMismatchPreview";

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
