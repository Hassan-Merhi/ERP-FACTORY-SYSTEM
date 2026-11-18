// Extracted from ./historicalSalesCostPartialApply.ts to keep that module under the source-size cap.
import type { PoolClient } from "pg";
import { hscrError } from "./historicalSalesCostRepair";
import { HISTORICAL_SALES_COST_REPAIR_ALGORITHM_VERSION } from "./historicalSalesCostRepairEngine";
import {
  HEX64,
  liveTargetDrift,
  partialApplyConfirmation,
  PartialApplyInput,
  PartialApplyPreview,
  partialRollbackConfirmation,
  PartialRollbackInput,
  reconciliation,
  rowSetIntegrityViolations,
  RUN_SQL,
  RunRow,
  runRowStatusCounts,
  sequential,
  targetFingerprint,
} from "./historicalSalesCostPartialApplyGuards";

/**
 * Proven-rows-only partial apply.
 *
 * A dry-run whose remaining rows are blocked for lack of historical evidence
 * can never pass the full apply (status=ready, zero blockers). This separate,
 * explicitly named path writes ONLY rows whose status is `ready`, inside one
 * SERIALIZABLE transaction, after re-verifying every piece of evidence the run
 * was reviewed against. Blocked and unchanged rows keep their original sale
 * values and their blocker codes; the run rows table is never modified.
 *
 * Every written row is snapshotted in historical_sales_cost_repair_apply_log
 * (before + after values, evidence, audit hash) so the partial apply can be
 * rolled back exactly by rollbackHistoricalSalesCostPartialApply.
 *
 * The transaction proves its own write set from pg_stat_xact_user_tables:
 * sales_items must show exactly <target> updates and nothing else may be
 * inserted, updated or deleted except the apply log and the partial-apply
 * record. Anything else aborts the whole transaction.
 */

export const HISTORICAL_SALES_COST_PARTIAL_APPLY_MODE = "proven-rows-only";

export const HISTORICAL_SALES_COST_PARTIAL_APPLY_LOG_MODE = "partial-proven-rows-only";

export function validatePartialApplyInput(input: PartialApplyInput): void {
  if (!Number.isSafeInteger(input.runId) || input.runId <= 0) throw hscrError("HSCR_PARTIAL_RUN_ID_INVALID");
  if (!HEX64.test(input.auditHash)) throw hscrError("HSCR_PARTIAL_AUDIT_HASH_INVALID");
  if (!HEX64.test(input.targetHash)) throw hscrError("HSCR_PARTIAL_TARGET_HASH_INVALID");
  if (input.mode !== HISTORICAL_SALES_COST_PARTIAL_APPLY_MODE) throw hscrError("HSCR_PARTIAL_MODE_REQUIRED");
  if (input.confirmation !== partialApplyConfirmation(input.runId, input.auditHash, input.targetHash)) {
    throw hscrError("HSCR_PARTIAL_CONFIRMATION_MISMATCH");
  }
  if (!input.appliedBy.trim()) throw hscrError("HSCR_PARTIAL_ACTOR_REQUIRED");
}

export function validatePartialRollbackInput(input: PartialRollbackInput): void {
  if (!Number.isSafeInteger(input.runId) || input.runId <= 0) throw hscrError("HSCR_PARTIAL_RUN_ID_INVALID");
  if (!HEX64.test(input.auditHash)) throw hscrError("HSCR_PARTIAL_AUDIT_HASH_INVALID");
  if (input.confirmation !== partialRollbackConfirmation(input.runId, input.auditHash)) {
    throw hscrError("HSCR_PARTIAL_ROLLBACK_CONFIRMATION_MISMATCH");
  }
  if (!input.rolledBackBy.trim()) throw hscrError("HSCR_PARTIAL_ACTOR_REQUIRED");
}

/** Read-only pre-apply reconciliation. Never writes. */
export async function previewHistoricalSalesCostPartialApplyWithClient(
  client: PoolClient,
  runId: number,
  options: { includeTargetIds?: boolean } = {}
): Promise<PartialApplyPreview> {
  const runResult = await client.query<RunRow>(RUN_SQL, [runId]);
  const run = runResult.rows[0];
  if (!run) throw hscrError("HSCR_RUN_NOT_FOUND");
  const auditHash = run.audit_hash ?? "";
  const [counts, fingerprint, drift, recon, existing, others, crossTargets] = await sequential([
    () => runRowStatusCounts(client, runId),
    () => targetFingerprint(client, runId, auditHash),
    () => liveTargetDrift(client, runId),
    () => reconciliation(client, runId),
    () =>
      client.query(
        `SELECT id,run_id,status,target_rows,target_hash,applied_by,applied_at,rolled_back_by,rolled_back_at
         FROM historical_sales_cost_repair_partial_applies WHERE run_id=$1`,
        [runId]
      ),
    () =>
      client.query<{ run_id: number }>(
        `SELECT run_id FROM historical_sales_cost_repair_partial_applies
        WHERE status='applied' AND run_id<>$1 ORDER BY run_id`,
        [runId]
      ),
    // A sale id can only appear once per run (UNIQUE(run_id,sales_item_id)),
    // so a target row can never also be a blocked or unchanged row. Counted
    // anyway so the report proves it rather than asserts it.
    () =>
      client.query<{ blocked: number; unchanged: number }>(
        `SELECT (COUNT(*) FILTER (WHERE o.status='blocked'))::int AS blocked,
              (COUNT(*) FILTER (WHERE o.status='unchanged'))::int AS unchanged
         FROM historical_sales_cost_repair_rows t
         JOIN historical_sales_cost_repair_rows o
           ON o.run_id=t.run_id AND o.sales_item_id=t.sales_item_id AND o.id<>t.id
        WHERE t.run_id=$1 AND t.status='ready'`,
        [runId]
      ),
  ]);
  const ids = options.includeTargetIds
    ? (
        await client.query<{ sales_item_id: number }>(
          `SELECT sales_item_id FROM historical_sales_cost_repair_rows
            WHERE run_id=$1 AND status='ready' ORDER BY sales_item_id`,
          [runId]
        )
      ).rows.map((row) => Number(row.sales_item_id))
    : undefined;
  return {
    runId,
    runStatus: run.status,
    algorithmVersion: run.algorithm_version,
    runningAlgorithmVersion: HISTORICAL_SALES_COST_REPAIR_ALGORITHM_VERSION,
    auditHash: run.audit_hash,
    sourceCutoff: new Date(run.source_cutoff_at).toISOString(),
    totalRows: Number(run.total_sales_rows),
    statusCounts: counts,
    rowSetViolations: rowSetIntegrityViolations(run, counts),
    targetRows: fingerprint.targetRows,
    targetHash: fingerprint.targetHash,
    requiredConfirmation: run.audit_hash
      ? partialApplyConfirmation(runId, run.audit_hash, fingerprint.targetHash)
      : null,
    requiredRollbackConfirmation: run.audit_hash ? partialRollbackConfirmation(runId, run.audit_hash) : null,
    liveTargetDrift: drift,
    blockedRowsTargeted: Number(crossTargets.rows[0]?.blocked ?? 0),
    unchangedRowsTargeted: Number(crossTargets.rows[0]?.unchanged ?? 0),
    existingPartialApply: existing.rows[0] ?? null,
    otherActivePartialApplies: others.rows.map((row) => Number(row.run_id)),
    reconciliation: recon,
    targetSalesItemIds: ids,
  };
}

export type PartialApplyResult = {
  runId: number;
  partialApplyId: number;
  appliedRows: number;
  targetHash: string;
  auditHash: string;
  alreadyApplied: boolean;
  reconciliation?: Awaited<ReturnType<typeof reconciliation>>;
};
