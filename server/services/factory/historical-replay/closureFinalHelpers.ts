// Extracted from ./closureFinal.ts
import type { BatchCorrection, BlockedBatch, SourceCorrection, SourceInfo } from "./types";

export interface SelectedSupplierCorrectionPlan {
  rootBatchIds: Set<number>;
  closureBatchIds: Set<number>;
  allBatchPlans: BatchCorrection[];
  changedBatchCorrections: BatchCorrection[];
  sourceCorrections: Map<number, SourceCorrection>;
  blockedBatches: BlockedBatch[];
}

export function buildSelectedSupplierBatchClosure(
  sourceInfos: SourceInfo[],
  selectedSupplierIds: Set<number>
): { rootBatchIds: Set<number>; closureBatchIds: Set<number> } {
  // Phase V7: use inventorySupplierId (explicit ownership) for root batch detection.
  // This captures CONTAINER_DIRECT sources (supplierId=null, containerId set) that
  // were previously skipped when they belonged to a supplier's inventory.
  const rootBatchIds = new Set<number>();
  for (const source of sourceInfos) {
    if (source.pricingBasis === "BATCH" || source.pricingBasis === "MANUAL_REVIEW") continue;
    const inventorySupplierId = source.inventorySupplierId;
    if (inventorySupplierId != null && selectedSupplierIds.has(inventorySupplierId)) {
      rootBatchIds.add(source.batchId);
    }
  }

  const dependentsByUpstream = new Map<number, Set<number>>();
  for (const source of sourceInfos) {
    if (source.pricingBasis !== "BATCH" || source.sourceBatchId == null) continue;
    const dependents = dependentsByUpstream.get(source.sourceBatchId) ?? new Set<number>();
    dependents.add(source.batchId);
    dependentsByUpstream.set(source.sourceBatchId, dependents);
  }

  const closureBatchIds = new Set(rootBatchIds);
  const queue = [...rootBatchIds];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const dependent of dependentsByUpstream.get(current) ?? []) {
      if (closureBatchIds.has(dependent)) continue;
      closureBatchIds.add(dependent);
      queue.push(dependent);
    }
  }

  // Phase V7 (Phase 8): Multi-supplier closure expansion.
  // When a batch contains sources from multiple inventory suppliers, ALL of them
  // must be in the selected scope for the batch to be correctly repriced.
  // Any participating inventory supplier not in selectedSupplierIds causes
  // MIXED_BATCH_SUPPLIER_SCOPE_INCOMPLETE in the summary; this closure does not
  // silently expand scope (that would be a scope change beyond user intent).
  // Downstream batches that depend exclusively on blocked-scope batches remain in
  // closureBatchIds so the correctness violation is visible in the plan.

  return { rootBatchIds, closureBatchIds };
}

export function needsBatchUpdate(correction: BatchCorrection): boolean {
  return (
    Math.abs(correction.expectedCostPerKg - correction.storedCostPerKg) > 0.000001 ||
    Math.abs(correction.expectedTotalCost - correction.storedTotalCost) > 0.01
  );
}
