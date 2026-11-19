// Extracted from ./apply.ts
import { eq } from "drizzle-orm";
import Decimal from "decimal.js";
import { db } from "../../../db";
import { factoryMixBatchSources } from "@shared/schema";
import { COST_SCALE, computeCorrectContainerCost, costEquals } from "./cost-math";

export interface ApplyResult {
  containerId: number;
  containerNumber: string;
  fullyUsed: boolean;
  remainingKg: number;
  applied: boolean;
  skippedReason?: string;
  staleToken?: boolean;
  rawStockRowsUpdated: number;
  /** Backward-compat count fields */
  affectedBatches: number;
  affectedBales: number;
  completedBatchesRewritten?: number;
}

export const RECALC_REFUSED_STATUSES = new Set(["CLOSED", "COMPLETED"]);

export interface ApplyRawStockRecalcOptions {
  onAudit?: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0], result: ApplyResult) => Promise<void>;
  expectedFingerprints?: Record<number, string>;
  includeCompletedBatches?: boolean;
  /** Allow CLOSED/COMPLETED containers when all safety checks pass. */
  includeHistoricalContainers?: boolean;
}

/**
 * Check whether ALL relevant valuation layers for a container already match
 * the corrected values (using 6dp precision). Returns true only when nothing
 * needs to be written.
 */
export async function isFullyCorrect(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  containerId: number,
  next: ReturnType<typeof computeCorrectContainerCost>,
  container: {
    finalPayableAmount: undefined | null | string | number;
    finalPayableAmountUsd: undefined | null | string | number;
    ratePerKgUsd: undefined | null | string | number;
  },
  rawStockRow: { costPerKg: undefined | null | string | number; costPerKgUsd: undefined | null | string | number }
): Promise<boolean> {
  // A. Container snapshot
  if (
    !costEquals(next.costPerKgUsd, container.ratePerKgUsd) ||
    !costEquals(next.totalCost, container.finalPayableAmount) ||
    !costEquals(next.totalUsd, container.finalPayableAmountUsd)
  ) {
    return false;
  }
  // B. Raw-stock row
  if (rawStockRow) {
    if (
      !costEquals(next.costPerKg, rawStockRow.costPerKg) ||
      !costEquals(next.costPerKgUsd, rawStockRow.costPerKgUsd)
    ) {
      return false;
    }
  }
  // C. Mix-batch sources
  const sources = await tx
    .select()
    .from(factoryMixBatchSources)
    .where(eq(factoryMixBatchSources.containerId, containerId));
  for (const src of sources) {
    const expectedTotal = new Decimal(src.weightKg || "0")
      .times(new Decimal(next.costPerKgUsd))
      .toDecimalPlaces(COST_SCALE)
      .toFixed(COST_SCALE);
    if (!costEquals(src.costPerKg, next.costPerKgUsd) || !costEquals(src.totalCost, expectedTotal)) {
      return false;
    }
  }
  return true;
}
