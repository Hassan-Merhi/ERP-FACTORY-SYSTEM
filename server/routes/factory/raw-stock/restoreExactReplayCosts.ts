// Extracted from ./historicalReplayRoutesV4.ts to keep that module under the source-size cap.
import {
  type ExactReplaySnapshot,
  normalizeReplayWriteScope,
  type ReplayQueryExecutor,
  type ReplayWriteScope,
} from "../../../services/factory/historicalCostReplay";

export const ADMIN_ROLES = ["Admin", "Developer"] as const;

export const EXACT_UNDO_KIND = "HISTORICAL_REPLAY_EXACT_V1" as const;

export interface HistoricalReplayTokenPayload {
  companyId: number;
  supplierIds: number[];
  includeCompletedBatches: boolean;
  includeFinalizedBales: boolean;
  fingerprint: string;
  scope: ReplayWriteScope;
  userId: string;
  algorithmVersion: string;
  expiresAt: number;
}

export interface ExactReplayUndoEnvelope {
  kind: typeof EXACT_UNDO_KIND;
  algorithmVersion: string;
  fingerprint: string;
  includeCompletedBatches: boolean;
  includeFinalizedBales: boolean;
  scope: ReplayWriteScope;
  baleIds: number[];
  before: ExactReplaySnapshot;
  after: ExactReplaySnapshot;
}

export function numberArray(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.some((item) => !Number.isInteger(item) || item <= 0)) return null;
  return [...new Set(value as number[])].sort((left, right) => left - right);
}

export function parseReplayWriteScope(value: unknown): ReplayWriteScope | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const supplierIds = numberArray(input.supplierIds);
  const containerIdsToUpdate = numberArray(input.containerIdsToUpdate);
  const rawStockIdsToUpdate = numberArray(input.rawStockIdsToUpdate);
  const sourceIdsToUpdate = numberArray(input.sourceIdsToUpdate);
  const batchIdsToUpdate = numberArray(input.batchIdsToUpdate);
  const availableBaleIdsToUpdate = numberArray(input.availableBaleIdsToUpdate);
  const finalizedBaleIdsToUpdate = numberArray(input.finalizedBaleIdsToUpdate);
  if (
    !supplierIds ||
    !containerIdsToUpdate ||
    !rawStockIdsToUpdate ||
    !sourceIdsToUpdate ||
    !batchIdsToUpdate ||
    !availableBaleIdsToUpdate ||
    !finalizedBaleIdsToUpdate ||
    !Array.isArray(input.blockedBatches)
  ) {
    return null;
  }

  const blockedBatches: ReplayWriteScope["blockedBatches"] = [];
  for (const raw of input.blockedBatches) {
    if (!raw || typeof raw !== "object") return null;
    const row = raw as Record<string, unknown>;
    if (
      typeof row.batchId !== "number" ||
      !Number.isInteger(row.batchId) ||
      typeof row.batchCode !== "string" ||
      !Array.isArray(row.reasons) ||
      row.reasons.some((reason) => typeof reason !== "string")
    ) {
      return null;
    }
    blockedBatches.push({
      batchId: row.batchId,
      batchCode: row.batchCode,
      reasons: [...new Set(row.reasons as string[])].sort(),
    });
  }

  return normalizeReplayWriteScope({
    supplierIds,
    containerIdsToUpdate,
    rawStockIdsToUpdate,
    sourceIdsToUpdate,
    batchIdsToUpdate,
    availableBaleIdsToUpdate,
    finalizedBaleIdsToUpdate,
    blockedBatches,
  });
}

export function parseExactUndoEnvelope(value: unknown): ExactReplayUndoEnvelope | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (input.kind !== EXACT_UNDO_KIND) return null;
  const scope = parseReplayWriteScope(input.scope);
  const baleIds = numberArray(input.baleIds);
  if (
    !scope ||
    !baleIds ||
    typeof input.algorithmVersion !== "string" ||
    typeof input.fingerprint !== "string" ||
    typeof input.includeCompletedBatches !== "boolean" ||
    typeof input.includeFinalizedBales !== "boolean" ||
    !input.before ||
    !input.after
  ) {
    throw Object.assign(new Error("Historical replay undo snapshot is malformed"), {
      code: "HISTORICAL_REPLAY_UNDO_INVALID",
    });
  }
  return {
    kind: EXACT_UNDO_KIND,
    algorithmVersion: input.algorithmVersion,
    fingerprint: input.fingerprint,
    includeCompletedBatches: input.includeCompletedBatches,
    includeFinalizedBales: input.includeFinalizedBales,
    scope,
    baleIds,
    before: input.before as ExactReplaySnapshot,
    after: input.after as ExactReplaySnapshot,
  };
}

export function assertOne(rowCount: number | null | undefined, label: string): void {
  if (rowCount !== 1) {
    throw Object.assign(new Error(`Historical replay undo failed: ${label} row was not restored exactly once`), {
      code: "HISTORICAL_REPLAY_UNDO_SCOPE_VIOLATION",
    });
  }
}

export async function restoreExactReplayCosts(
  executor: ReplayQueryExecutor,
  companyId: number,
  snapshot: ExactReplaySnapshot
): Promise<void> {
  for (const row of snapshot.containers) {
    const result = await executor.query(
      `UPDATE factory_containers
       SET rate_per_kg_usd = $1,
           final_payable_amount_usd = $2,
           updated_at = NOW()
       WHERE id = $3 AND company_id = $4`,
      [row.ratePerKgUsd, row.finalPayableAmountUsd, row.id, companyId]
    );
    assertOne(result.rowCount, `container ${row.id}`);
  }
  for (const row of snapshot.rawStockRows) {
    const result = await executor.query(
      `UPDATE factory_raw_stock
       SET cost_per_kg_usd = $1
       WHERE id = $2 AND company_id = $3 AND container_id = $4`,
      [row.costPerKgUsd, row.id, companyId, row.containerId]
    );
    assertOne(result.rowCount, `raw-stock ${row.id}`);
  }
  for (const row of snapshot.mixBatchSources) {
    const result = await executor.query(
      `UPDATE factory_mix_batch_sources mbs
       SET cost_per_kg = $1,
           total_cost = $2
       FROM factory_mix_batches mb
       WHERE mbs.id = $3
         AND mbs.mix_batch_id = $4
         AND mb.id = mbs.mix_batch_id
         AND mb.company_id = $5`,
      [row.costPerKg, row.totalCost, row.id, row.mixBatchId, companyId]
    );
    assertOne(result.rowCount, `source ${row.id}`);
  }
  for (const row of snapshot.mixBatches) {
    const result = await executor.query(
      `UPDATE factory_mix_batches
       SET cost_per_kg = $1,
           total_cost = $2,
           updated_at = NOW()
       WHERE id = $3 AND company_id = $4`,
      [row.costPerKg, row.totalCost, row.id, companyId]
    );
    assertOne(result.rowCount, `batch ${row.id}`);
  }
  for (const row of snapshot.bales) {
    const result = await executor.query(
      `UPDATE factory_bales
       SET cost_per_kg = $1,
           total_cost = $2,
           updated_at = NOW()
       WHERE id = $3 AND company_id = $4 AND mix_batch_id IS NOT DISTINCT FROM $5`,
      [row.costPerKg, row.totalCost, row.id, companyId, row.mixBatchId]
    );
    assertOne(result.rowCount, `bale ${row.id}`);
  }
  for (const row of snapshot.suppliers) {
    const result = await executor.query(
      `UPDATE factory_suppliers
       SET current_raw_material_cost_per_kg_usd = $1,
           updated_at = NOW()
       WHERE id = $2 AND company_id = $3`,
      [row.currentRawMaterialCostPerKgUsd, row.id, companyId]
    );
    assertOne(result.rowCount, `supplier ${row.id}`);
  }
}
