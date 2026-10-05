/**
 * Shared state and helpers for the rawStockRecalcRoutesLegacy routes.
 *
 * Extracted verbatim from the former single-file rawStockRecalcRoutesLegacy.ts.
 */
import {} from "../../../../services/factory/raw-stock-recalc";
import { pool } from "../../../../db";
import { historicalReplaySafetySchema } from "../../../../startup-schema/032-historical-replay-safety";

export const ADMIN_ROLES = ["Admin", "Developer"] as const;

// ─── Undo log + consumed-token helpers ─────────────────────────────────────────

/**
 * Ensure the undo log and consumed-token tables exist in their replay-safe
 * shape. Called once at route registration, so it runs in every migration mode.
 */
export async function ensureUndoLogTable(): Promise<void> {
  for (const statement of historicalReplaySafetySchema) {
    await pool.query(statement);
  }
}

/** Capture a point-in-time snapshot of every row that applyRawStockRecalc will touch. */
export async function captureRecalcSnapshot(companyId: number, containerIds: number[]) {
  if (containerIds.length === 0) {
    return { containers: [], rawStockRows: [], mixBatchSources: [], mixBatches: [], bales: [], suppliers: [] };
  }

  const [{ rows: containers }, { rows: rawStockRows }, { rows: mixBatchSources }] = await Promise.all([
    pool.query(
      `SELECT id,
              final_payable_amount       AS "finalPayableAmount",
              rate_per_kg_usd            AS "ratePerKgUsd",
              final_payable_amount_usd   AS "finalPayableAmountUsd"
       FROM factory_containers
       WHERE id = ANY($1) AND company_id = $2`,
      [containerIds, companyId]
    ),
    pool.query(
      `SELECT id,
              cost_per_kg     AS "costPerKg",
              cost_per_kg_usd AS "costPerKgUsd"
       FROM factory_raw_stock
       WHERE container_id = ANY($1) AND company_id = $2 AND deleted_at IS NULL`,
      [containerIds, companyId]
    ),
    // Snapshot ALL sources (open + completed) so the undo is always complete
    pool.query(
      `SELECT mbs.id,
              mbs.mix_batch_id AS "mixBatchId",
              mbs.cost_per_kg  AS "costPerKg",
              mbs.total_cost   AS "totalCost"
       FROM factory_mix_batch_sources mbs
       JOIN factory_mix_batches mb ON mbs.mix_batch_id = mb.id
       WHERE mbs.container_id = ANY($1) AND mb.company_id = $2 AND mb.deleted_at IS NULL`,
      [containerIds, companyId]
    ),
  ]);

  const batchIds = [...new Set(mixBatchSources.map((s) => s.mixBatchId as number))];

  let mixBatches = [];
  let bales = [];
  if (batchIds.length > 0) {
    const [{ rows: batchRows }, { rows: baleRows }] = await Promise.all([
      pool.query(
        `SELECT id, cost_per_kg AS "costPerKg", total_cost AS "totalCost"
         FROM factory_mix_batches WHERE id = ANY($1)`,
        [batchIds]
      ),
      pool.query(
        `SELECT id, cost_per_kg AS "costPerKg", total_cost AS "totalCost"
         FROM factory_bales
         WHERE mix_batch_id = ANY($1) AND company_id = $2 AND status NOT IN ('DELETED','REMOVED')`,
        [batchIds, companyId]
      ),
    ]);
    mixBatches = batchRows;
    bales = baleRows;
  }

  // Supplier locked rates
  const { rows: supplierRows } = await pool.query(
    `SELECT DISTINCT ON (fs.id)
            fs.id,
            fs.current_raw_material_cost_per_kg_usd AS "currentRawMaterialCostPerKgUsd"
     FROM factory_suppliers fs
     JOIN factory_containers fc ON fc.supplier_id = fs.id
     WHERE fc.id = ANY($1) AND fc.company_id = $2 AND fs.company_id = $2`,
    [containerIds, companyId]
  );

  return { containers, rawStockRows, mixBatchSources, mixBatches, bales, suppliers: supplierRows };
}

export interface RecalcTokenPayload {
  companyId: number;
  containerIds: number[];
  /** Deterministic fingerprint of EVERY approved calculation input per
   * container (see computeRecalcFingerprint) — container status/updatedAt,
   * received kg, rate, currency, FX rate/confirmed state, freight, duty,
   * commission, other charges, every additional-charge row, and the current
   * vs. expected cost. Re-derived from a fresh, row-locked read inside the
   * apply transaction and rejected as STALE_TOKEN on any mismatch. */
  fingerprintByContainer: Record<number, string>;
  userId: string;
  expiresAt: number;
  /** Bound into the token so a confirm request can never silently expand scope
   * beyond what the admin saw and approved at dry-run time. */
  includeCompletedBatches: boolean;
  /** Whether to allow CLOSED/COMPLETED containers — bound in token so scope can't expand at confirm. */
  includeHistoricalContainers: boolean;
}

export interface ApplyAllSafeTokenPayload {
  companyId: number;
  safeContainerIds: number[];
  userId: string;
  expiresAt: number;
  includeHistoricalContainers: boolean;
  includeCompletedBatches: boolean;
}

export interface ZeroCostSourceTokenPayload {
  companyId: number;
  sourceIds: number[];
  manualRates: Record<number, number>;
  userId: string;
  expiresAt: number;
}
