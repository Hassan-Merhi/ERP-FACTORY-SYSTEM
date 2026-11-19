// Extracted from ./mixBatchEditReview.ts
import { MoneyDecimal, toMoney } from "../../lib/money";
import { sameMixEditSources, type MixEditSelection } from "./mixBatchEditRequest";

export interface MixBatchForSourceReview {
  id: number;
  companyId: number;
  batchCode: string;
  name?: string | null;
  notes?: string | null;
  status: string;
  deletedAt: Date | null;
  updatedAt: Date | null;
  totalWeightKg: string;
  totalCost: string;
  usedKg: string;
  costPerKg: string;
  batchDate?: string | null;
}

export interface MixSourceForReview {
  id: number;
  mixBatchId: number;
  supplierId: number | null;
  containerId: number | null;
  sourceBatchId: number | null;
  weightKg: string;
  costPerKg: string;
  totalCost: string;
}

export function prepareMixSourceEditReviewPart1(
  batch: MixBatchForSourceReview,
  oldSources: readonly MixSourceForReview[],
  proposed: MixEditSelection
) {
  const changed = !sameMixEditSources(oldSources, proposed);
  const warnings: string[] = [];
  const snapshot: unknown[] = [];
  const recordedCost = toMoney(batch.totalCost);
  const oldByContainer = new Map<number, ReturnType<typeof toMoney>>();
  const oldBySupplier = new Map<number, MixSourceForReview[]>();
  const oldByBatch = new Map<number, ReturnType<typeof toMoney>>();

  for (const source of oldSources) {
    if (source.containerId !== null && source.supplierId === null) {
      warnings.push(
        "An original container source has no supplier attribution. It requires an audited historical correction."
      );
    }
    if (source.containerId !== null && source.sourceBatchId !== null) {
      warnings.push("An original row has conflicting container and source-batch references.");
    }
    if (source.containerId !== null) {
      oldByContainer.set(
        source.containerId,
        (oldByContainer.get(source.containerId) ?? new MoneyDecimal(0)).plus(source.weightKg)
      );
    }
    if (source.supplierId !== null && source.sourceBatchId === null) {
      const list = oldBySupplier.get(source.supplierId) ?? [];
      list.push(source);
      oldBySupplier.set(source.supplierId, list);
    }
    if (source.sourceBatchId !== null) {
      oldByBatch.set(
        source.sourceBatchId,
        (oldByBatch.get(source.sourceBatchId) ?? new MoneyDecimal(0)).plus(source.weightKg)
      );
    }
  }

  if (batch.deletedAt) warnings.push("Deleted batches cannot have their sources edited.");
  if (!["OPEN", "ACTIVE", "CARRY_FORWARD"].includes(batch.status)) {
    warnings.push(
      "This batch has been completed or closed. Review-only: historical output and accounting must be reconciled first."
    );
  }
  if (toMoney(batch.usedKg).greaterThan(0)) {
    warnings.push(
      "The batch has recorded production/usage; source edits require downstream bale and accounting reconciliation."
    );
  }
  if (toMoney(proposed.totalWeightKg).lessThan(toMoney(batch.usedKg))) {
    warnings.push("Proposed materials do not cover already-used kilograms.");
  }
  return { changed, warnings, snapshot, recordedCost, oldByContainer, oldBySupplier, oldByBatch };
}
