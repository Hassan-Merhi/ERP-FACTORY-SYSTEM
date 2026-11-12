import type { FactoryMixBatch } from "@shared/schema";

export interface SupplierRawStock {
  supplierName: string;
  supplierId: number | null;
  receivedKg: string;
  usedKg: string;
  remainingKg: string;
  costPerKg: string;
  costPerKgUsd?: string;
  valueRemaining: string;
  lastOffloaded: string;
}

export type SourceType = "supplier" | "batch";

export interface SourceSelection {
  type: SourceType;
  sourceId: number;
  label: string;
  weightKg: number;
  costPerKg: number;
  totalCost: number;
  availableKg: number;
}

export interface EditMixBatchDialogProps {
  batch: FactoryMixBatch | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The Production Overview should display recorded sources without permitting edits. */
  readOnly?: boolean;
  hideCosts?: boolean;
  errorMessage?: string | null;
}

export interface StoredMixBatchSource {
  id: number;
  sourceBatchId: number | null;
  sourceBatchCode: string | null;
  supplierId: number | null;
  supplierName: string | null;
  containerNumber: string | null;
  weightKg: string;
  costPerKg: string;
  totalCost: string;
  recordedUnvalued?: boolean;
}

/**
 * Compare submitted source identities and quantities with the recorded sources.
 * Metadata-only edits must not send source arrays: doing so would reprice the
 * old batch using today's locked supplier rates.
 */
export function hasChangedSourceWeights(
  selections: readonly SourceSelection[],
  sources: readonly StoredMixBatchSource[] | undefined
): boolean {
  if (!sources) return true;
  const original = new Map<string, number>();
  const proposed = new Map<string, number>();
  for (const source of sources) {
    const key =
      source.sourceBatchId != null
        ? `batch-${source.sourceBatchId}`
        : source.supplierId != null
          ? `supplier-${source.supplierId}`
          : null;
    if (key === null) return true; // An unmapped historical source cannot be silently dropped.
    original.set(key, (original.get(key) ?? 0) + Number(source.weightKg));
  }
  for (const source of selections) {
    const key = `${source.type}-${source.sourceId}`;
    proposed.set(key, (proposed.get(key) ?? 0) + source.weightKg);
  }
  if (original.size !== proposed.size) return true;
  for (const [key, oldKg] of original) {
    const nextKg = proposed.get(key);
    if (
      nextKg === undefined ||
      !Number.isFinite(oldKg) ||
      !Number.isFinite(nextKg) ||
      Math.abs(oldKg - nextKg) > 0.0005
    ) {
      return true;
    }
  }
  return false;
}

export interface SourceEditReview {
  changed: boolean;
  allowed: boolean;
  reviewHash: string | null;
  recordedWeightKg: string;
  proposedWeightKg: string;
  recordedTotalCost: string;
  estimatedTotalCost: string | null;
  estimatedCostPerKg: string | null;
  estimatedDeltaUsd: string | null;
  warnings: string[];
  previewOnly: boolean;
}
