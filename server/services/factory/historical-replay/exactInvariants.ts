import Decimal from "decimal.js";
import type { ReplayQueryExecutor, ReplayWriteScope } from "./types";
import type { ExactReplaySnapshot } from "./exactSnapshot";

function canonicalScalar(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (value === null || value === undefined) return "<null>";
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return String(value);
}

function canonicalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) out[key] = canonicalize(record[key]);
    return out;
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function decimalEquals(left: unknown, right: unknown, tolerance = "0.0000001"): boolean {
  if (left == null || right == null) return left == null && right == null;
  try {
    return new Decimal(String(left))
      .minus(new Decimal(String(right)))
      .abs()
      .lte(tolerance);
  } catch {
    return canonicalScalar(left) === canonicalScalar(right);
  }
}

function invariantError(message: string): Error & { code: string } {
  return Object.assign(new Error(`HISTORICAL_REPLAY_INVARIANT_VIOLATION: ${message}. Rolling back.`), {
    code: "HISTORICAL_REPLAY_INVARIANT_VIOLATION",
  });
}

function rowsById<T extends { id: number }>(rows: T[]): Map<number, T> {
  return new Map(rows.map((row) => [Number(row.id), row]));
}

function assertSameIds(beforeRows: Array<{ id: number }>, afterRows: Array<{ id: number }>, label: string): void {
  const before = [...rowsById(beforeRows).keys()].sort((a, b) => a - b);
  const after = [...rowsById(afterRows).keys()].sort((a, b) => a - b);
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw invariantError(`${label} row identity changed`);
  }
}

function assertCompleteNonCostStateUnchanged(
  beforeRows: Array<{ id: number; nonCostState: Record<string, unknown> }>,
  afterRows: Array<{ id: number; nonCostState: Record<string, unknown> }>,
  label: string
): void {
  assertSameIds(beforeRows, afterRows, label);
  const afterById = rowsById(afterRows);
  for (const before of beforeRows) {
    // assertSameIds proved the id sets match, so the row is present.
    const after = afterById.get(Number(before.id))!;
    if (stableJson(before.nonCostState) !== stableJson(after.nonCostState)) {
      throw invariantError(`${label} ${before.id} changed a non-cost column`);
    }
  }
}

/**
 * Proves the replay changed only its explicitly authorized cost columns. The
 * JSONB nonCostState image contains every other persisted column, including
 * signed quantities, ownership, lifecycle state and dependency relationships.
 */
export function assertExactReplayNonCostInvariants(before: ExactReplaySnapshot, after: ExactReplaySnapshot): void {
  assertCompleteNonCostStateUnchanged(before.containers, after.containers, "container");
  assertCompleteNonCostStateUnchanged(before.rawStockRows, after.rawStockRows, "raw-stock");
  assertCompleteNonCostStateUnchanged(before.mixBatchSources, after.mixBatchSources, "source");
  assertCompleteNonCostStateUnchanged(before.mixBatches, after.mixBatches, "batch");
  assertCompleteNonCostStateUnchanged(before.bales, after.bales, "bale");
  assertCompleteNonCostStateUnchanged(before.suppliers, after.suppliers, "supplier");
}

/**
 * One cost-field check: the applied snapshot's rows must still carry exactly
 * the same values in `fields` as the current persisted rows, or undo is stale.
 */
function assertCostFieldsUnchanged<T extends { id: number }>(check: {
  label: string;
  appliedRows: T[];
  currentRows: T[];
  fields: Array<keyof T & string>;
}): void {
  assertSameIds(check.appliedRows, check.currentRows, check.label);
  const currentById = rowsById(check.currentRows);
  for (const row of check.appliedRows) {
    // assertSameIds proved the id sets match, so the row is present.
    const currentRow = currentById.get(Number(row.id))!;
    for (const field of check.fields) {
      if (!decimalEquals(row[field], currentRow[field])) {
        // The message keeps its historical raw template text (`check.label`)
        // so the i18n compatibility inventory still covers it.
        throw Object.assign(
          new Error(
            `Historical replay undo blocked: ${check.label} ${row.id} ${field} changed after replay. ` +
              "Re-run review instead of overwriting the newer value."
          ),
          { code: "HISTORICAL_REPLAY_UNDO_STALE" }
        );
      }
    }
  }
}

/**
 * Before undo, prove every cost field still equals the exact value written by
 * replay. This prevents an old undo snapshot from overwriting later edits.
 */
export function assertExactReplayCurrentCostsMatchApplied(
  applied: ExactReplaySnapshot,
  current: ExactReplaySnapshot
): void {
  assertCostFieldsUnchanged({
    label: "container",
    appliedRows: applied.containers,
    currentRows: current.containers,
    fields: ["ratePerKgUsd", "finalPayableAmountUsd"],
  });
  assertCostFieldsUnchanged({
    label: "raw-stock",
    appliedRows: applied.rawStockRows,
    currentRows: current.rawStockRows,
    fields: ["costPerKgUsd"],
  });
  assertCostFieldsUnchanged({
    label: "source",
    appliedRows: applied.mixBatchSources,
    currentRows: current.mixBatchSources,
    fields: ["costPerKg", "totalCost"],
  });
  assertCostFieldsUnchanged({
    label: "batch",
    appliedRows: applied.mixBatches,
    currentRows: current.mixBatches,
    fields: ["costPerKg", "totalCost"],
  });
  assertCostFieldsUnchanged({
    label: "bale",
    appliedRows: applied.bales,
    currentRows: current.bales,
    fields: ["costPerKg", "totalCost"],
  });
  assertCostFieldsUnchanged({
    label: "supplier",
    appliedRows: applied.suppliers,
    currentRows: current.suppliers,
    fields: ["currentRawMaterialCostPerKgUsd"],
  });
}

/**
 * Validate persisted source totals rather than preview objects. Batch total_cost
 * must equal SUM(persisted source total_cost), and every persisted source total
 * must still agree with its own weight × cost within the approved rounding bound.
 */
export async function assertPersistedReplaySourceTotals(
  executor: ReplayQueryExecutor,
  companyId: number,
  scope: ReplayWriteScope
): Promise<void> {
  if (scope.batchIdsToUpdate.length === 0) return;
  const result = await executor.query<{
    batch_id: number;
    batch_total: string;
    persisted_source_total: string;
    max_source_row_difference: string;
  }>(
    `SELECT mb.id AS batch_id,
            mb.total_cost AS batch_total,
            COALESCE(SUM(mbs.total_cost), 0) AS persisted_source_total,
            COALESCE(MAX(ABS(mbs.total_cost - (mbs.weight_kg * mbs.cost_per_kg))), 0)
              AS max_source_row_difference
     FROM factory_mix_batches mb
     LEFT JOIN factory_mix_batch_sources mbs ON mbs.mix_batch_id = mb.id
     WHERE mb.company_id = $1
       AND mb.id = ANY($2)
     GROUP BY mb.id, mb.total_cost
     ORDER BY mb.id`,
    [companyId, scope.batchIdsToUpdate]
  );

  const expectedIds = [...new Set(scope.batchIdsToUpdate)].sort((a, b) => a - b);
  const actualIds = result.rows.map((row) => Number(row.batch_id)).sort((a, b) => a - b);
  if (JSON.stringify(expectedIds) !== JSON.stringify(actualIds)) {
    throw invariantError("persisted batch/source scope changed");
  }

  for (const row of result.rows) {
    if (
      new Decimal(row.batch_total || 0)
        .minus(new Decimal(row.persisted_source_total || 0))
        .abs()
        .gt("0.02")
    ) {
      throw invariantError(`batch ${row.batch_id} persisted source totals do not equal batch total`);
    }
    if (new Decimal(row.max_source_row_difference || 0).abs().gt("0.02")) {
      throw invariantError(`batch ${row.batch_id} contains a persisted source total inconsistent with weight × cost`);
    }
  }
}
