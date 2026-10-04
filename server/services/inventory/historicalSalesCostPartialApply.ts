import type { PoolClient } from "pg";

import { pool } from "../../db";
import { logger } from "../../lib/logger";
import { ensureHistoricalSalesCostRepairSchema } from "./ensureHistoricalSalesCostRepairSchema";
import {
  assertSalesItemsUpdateHasNoSideEffectTriggers,
  enableMaintenanceScope,
  hscrError,
  inventoryEvidenceFingerprint,
} from "./historicalSalesCostRepair";
import { HISTORICAL_SALES_COST_REPAIR_ALGORITHM_VERSION } from "./historicalSalesCostRepairEngine";
import {
  APPLY_LOCK_SQL,
  APPLY_LOG_TABLE,
  HEX64,
  PARTIAL_APPLIES_TABLE,
  PartialApplyDeps,
  PartialApplyInput,
  PartialApplyPreview,
  PartialRollbackInput,
  RUN_SQL,
  RunRow,
  SALES_ITEMS_TABLE,
  assertEvidenceUnchanged,
  assertTransactionWrites,
  liveTargetDrift,
  nonTargetDriftCount,
  partialApplyConfirmation,
  partialRollbackConfirmation,
  reconciliation,
  rowSetIntegrityViolations,
  runRowStatusCounts,
  sequential,
  targetFingerprint,
  transactionWriteCounts,
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

export async function applyHistoricalSalesCostPartialWithClient(
  client: PoolClient,
  input: PartialApplyInput,
  deps: PartialApplyDeps = {}
): Promise<PartialApplyResult> {
  validatePartialApplyInput(input);
  const algorithmVersion = deps.algorithmVersion ?? HISTORICAL_SALES_COST_REPAIR_ALGORITHM_VERSION;
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await enableMaintenanceScope(client);
    await client.query(APPLY_LOCK_SQL);
    const writesBefore = await transactionWriteCounts(client);

    const runResult = await client.query<RunRow>(`${RUN_SQL} FOR UPDATE`, [input.runId]);
    const run = runResult.rows[0];
    if (!run) throw hscrError("HSCR_RUN_NOT_FOUND");
    if (!run.audit_hash || run.audit_hash !== input.auditHash) throw hscrError("HSCR_AUDIT_HASH_MISMATCH");

    // Idempotency: a retry of the same approved apply is a no-op.
    const existing = await client.query<{ id: number; status: string; target_hash: string; target_rows: number }>(
      `SELECT id,status,target_hash,target_rows
         FROM historical_sales_cost_repair_partial_applies
        WHERE run_id=$1
        FOR UPDATE`,
      [input.runId]
    );
    if (existing.rows[0]) {
      const record = existing.rows[0];
      if (record.status === "rolled_back") throw hscrError("HSCR_PARTIAL_APPLY_ALREADY_ROLLED_BACK");
      if (record.target_hash !== input.targetHash) throw hscrError("HSCR_PARTIAL_TARGET_HASH_MISMATCH");
      await client.query("ROLLBACK");
      return {
        runId: input.runId,
        partialApplyId: Number(record.id),
        appliedRows: Number(record.target_rows),
        targetHash: record.target_hash,
        auditHash: input.auditHash,
        alreadyApplied: true,
      };
    }

    if (run.algorithm_version !== algorithmVersion) throw hscrError("HSCR_ALGORITHM_VERSION_MISMATCH");
    if (!["blocked", "ready"].includes(run.status) || !run.completed_at) {
      throw hscrError(`HSCR_PARTIAL_RUN_STATUS_INVALID:${run.status}`);
    }
    const others = await client.query<{ run_id: number }>(
      `SELECT run_id FROM historical_sales_cost_repair_partial_applies WHERE status='applied' ORDER BY run_id`
    );
    if (others.rows.length > 0) {
      throw hscrError(`HSCR_PARTIAL_APPLY_ANOTHER_ACTIVE:${others.rows.map((row) => row.run_id).join(",")}`);
    }

    const companyIds = (run.requested_company_ids ?? []).map(Number);
    if (companyIds.length === 0) throw hscrError("HSCR_RUN_SCOPE_EMPTY");

    const violations = rowSetIntegrityViolations(run, await runRowStatusCounts(client, input.runId));
    if (violations.length > 0) throw hscrError(`HSCR_PARTIAL_ROW_SET_INVALID:${violations.join(",")}`);
    const outOfScope = await client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM historical_sales_cost_repair_rows
        WHERE run_id=$1 AND status='ready' AND NOT (company_id = ANY($2::int[]))`,
      [input.runId, companyIds]
    );
    if (Number(outOfScope.rows[0].count) !== 0) throw hscrError("HSCR_PARTIAL_TARGET_OUT_OF_SCOPE");

    const fingerprint = await targetFingerprint(client, input.runId, input.auditHash);
    if (fingerprint.targetHash !== input.targetHash) throw hscrError("HSCR_PARTIAL_TARGET_HASH_MISMATCH");
    const targetRows = fingerprint.targetRows;
    if (targetRows <= 0) throw hscrError("HSCR_PARTIAL_NO_TARGET_ROWS");

    await assertEvidenceUnchanged(client, input.runId, companyIds, run.source_cutoff_at, deps);
    await assertSalesItemsUpdateHasNoSideEffectTriggers(client);

    const locked = await client.query(
      `SELECT si.id
         FROM sales_items si
         JOIN historical_sales_cost_repair_rows r
           ON r.sales_item_id=si.id AND r.run_id=$1 AND r.status='ready'
        ORDER BY si.id
        FOR UPDATE OF si`,
      [input.runId]
    );
    if ((locked.rowCount ?? 0) !== targetRows) {
      throw hscrError(`HSCR_PARTIAL_TARGET_ROWS_MISSING:${locked.rowCount ?? 0}/${targetRows}`);
    }
    const drift = await liveTargetDrift(client, input.runId);
    if (drift.count !== 0) {
      throw hscrError(`HSCR_PARTIAL_TARGET_ROWS_CHANGED:${drift.count}:${drift.sample.join(",")}`);
    }
    const nonTargetDriftBefore = await nonTargetDriftCount(client, input.runId);
    if (nonTargetDriftBefore !== 0) throw hscrError(`HSCR_PARTIAL_NON_TARGET_ROWS_CHANGED:${nonTargetDriftBefore}`);

    const inventoryBefore = await inventoryEvidenceFingerprint(client, companyIds);
    const recon = await reconciliation(client, input.runId);

    const record = await client.query<{ id: number }>(
      `INSERT INTO historical_sales_cost_repair_partial_applies
       (run_id,audit_hash,algorithm_version,target_hash,target_rows,status,applied_by,report)
       VALUES ($1,$2,$3,$4,$5,'applied',$6,$7::jsonb)
       RETURNING id`,
      [
        input.runId,
        input.auditHash,
        run.algorithm_version,
        input.targetHash,
        targetRows,
        input.appliedBy,
        JSON.stringify({ preApply: recon }),
      ]
    );
    const partialApplyId = Number(record.rows[0].id);

    // Durable before-state snapshot of every target row, taken from the live
    // (locked, verified) sales_items values.
    const logged = await client.query(
      `INSERT INTO historical_sales_cost_repair_apply_log
       (run_id,company_id,sales_item_id,before_cost_price,before_total_cost,before_profit,
        after_cost_price,after_total_cost,after_profit,applied_by,apply_mode,partial_apply_id,
        voucher_id,location_id,stock_item_id,occurred_at,evidence,source_type,source_id,audit_hash)
       SELECT r.run_id,r.company_id,r.sales_item_id,si.cost_price,si.total_cost,si.profit,
              r.proposed_cost_price,r.proposed_total_cost,r.proposed_profit,$2,$3,$4,
              r.voucher_id,r.location_id,r.stock_item_id,r.occurred_at,r.evidence,r.source_type,r.source_id,$5
         FROM historical_sales_cost_repair_rows r
         JOIN sales_items si ON si.id=r.sales_item_id
        WHERE r.run_id=$1 AND r.status='ready'`,
      [input.runId, input.appliedBy, HISTORICAL_SALES_COST_PARTIAL_APPLY_LOG_MODE, partialApplyId, input.auditHash]
    );
    if ((logged.rowCount ?? 0) !== targetRows) throw hscrError("HSCR_PARTIAL_SNAPSHOT_COUNT_MISMATCH");

    const updated = await client.query(
      `UPDATE sales_items si
          SET cost_price=l.after_cost_price,
              total_cost=l.after_total_cost,
              profit=l.after_profit
         FROM historical_sales_cost_repair_apply_log l
        WHERE l.partial_apply_id=$1
          AND l.sales_item_id=si.id
          AND si.cost_price=l.before_cost_price
          AND si.total_cost=l.before_total_cost
          AND si.profit=l.before_profit`,
      [partialApplyId]
    );
    if ((updated.rowCount ?? 0) !== targetRows) {
      throw hscrError(`HSCR_PARTIAL_UPDATE_COUNT_MISMATCH:${updated.rowCount ?? 0}/${targetRows}`);
    }

    const post = await client.query<{ mismatched: number; rows: number; cogs: string; profit: string }>(
      `SELECT (COUNT(*) FILTER (
                WHERE si.id IS NULL
                   OR si.cost_price IS DISTINCT FROM l.after_cost_price
                   OR si.total_cost IS DISTINCT FROM l.after_total_cost
                   OR si.profit IS DISTINCT FROM l.after_profit
              ))::int AS mismatched,
              COUNT(*)::int AS rows,
              COALESCE(SUM(si.total_cost),0)::numeric(24,2)::text AS cogs,
              COALESCE(SUM(si.profit),0)::numeric(24,2)::text AS profit
         FROM historical_sales_cost_repair_apply_log l
         LEFT JOIN sales_items si ON si.id=l.sales_item_id
        WHERE l.partial_apply_id=$1`,
      [partialApplyId]
    );
    const postRow = post.rows[0];
    if (
      Number(postRow.mismatched) !== 0 ||
      Number(postRow.rows) !== targetRows ||
      postRow.cogs !== recon.target.proposedCogs ||
      postRow.profit !== recon.target.proposedProfit
    ) {
      throw hscrError("HSCR_POST_APPLY_VERIFY_FAILED");
    }
    const nonTargetDriftAfter = await nonTargetDriftCount(client, input.runId);
    if (nonTargetDriftAfter !== 0) throw hscrError(`HSCR_PARTIAL_NON_TARGET_ROWS_WRITTEN:${nonTargetDriftAfter}`);

    const inventoryAfter = await inventoryEvidenceFingerprint(client, companyIds);
    if (inventoryAfter.hash !== inventoryBefore.hash || inventoryAfter.rowCount !== inventoryBefore.rowCount) {
      throw hscrError("HSCR_INVENTORY_CHANGED_DURING_APPLY");
    }

    await client.query(
      `UPDATE historical_sales_cost_repair_partial_applies
          SET report=report || jsonb_build_object(
                'postApply',jsonb_build_object('rows',$2::int,'cogs',$3::text,'profit',$4::text),
                'inventorySnapshot',jsonb_build_object('beforeHash',$5::text,'afterHash',$6::text,'rowCount',$7::int)
              )
        WHERE id=$1`,
      [
        partialApplyId,
        targetRows,
        postRow.cogs,
        postRow.profit,
        inventoryBefore.hash,
        inventoryAfter.hash,
        inventoryAfter.rowCount,
      ]
    );

    await assertTransactionWrites(client, writesBefore, {
      [SALES_ITEMS_TABLE]: { ins: 0, upd: targetRows, del: 0 },
      [APPLY_LOG_TABLE]: { ins: targetRows, upd: 0, del: 0 },
      [PARTIAL_APPLIES_TABLE]: { ins: 1, upd: 1, del: 0 },
    });

    await client.query("COMMIT");
    logger.info("Historical sales cost partial apply committed", {
      module: "historical-sales-cost-repair",
      action: "partial-apply",
      runId: input.runId,
      partialApplyId,
      appliedRows: targetRows,
      targetHash: input.targetHash,
      appliedBy: input.appliedBy,
    });
    return {
      runId: input.runId,
      partialApplyId,
      appliedRows: targetRows,
      targetHash: input.targetHash,
      auditHash: input.auditHash,
      alreadyApplied: false,
      reconciliation: recon,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

export type PartialRollbackResult = {
  runId: number;
  partialApplyId: number;
  restoredRows: number;
  alreadyRolledBack: boolean;
};

export async function rollbackHistoricalSalesCostPartialWithClient(
  client: PoolClient,
  input: PartialRollbackInput
): Promise<PartialRollbackResult> {
  validatePartialRollbackInput(input);
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await enableMaintenanceScope(client);
    await client.query(APPLY_LOCK_SQL);
    const writesBefore = await transactionWriteCounts(client);

    const recordResult = await client.query<{
      id: number;
      status: string;
      audit_hash: string;
      target_rows: number;
      run_id: number;
    }>(
      `SELECT id,run_id,status,audit_hash,target_rows
         FROM historical_sales_cost_repair_partial_applies
        WHERE run_id=$1
        FOR UPDATE`,
      [input.runId]
    );
    const record = recordResult.rows[0];
    if (!record) throw hscrError("HSCR_PARTIAL_APPLY_NOT_FOUND");
    if (record.audit_hash !== input.auditHash) throw hscrError("HSCR_AUDIT_HASH_MISMATCH");
    const partialApplyId = Number(record.id);
    const targetRows = Number(record.target_rows);
    if (record.status === "rolled_back") {
      await client.query("ROLLBACK");
      return { runId: input.runId, partialApplyId, restoredRows: targetRows, alreadyRolledBack: true };
    }
    if (record.status !== "applied") throw hscrError(`HSCR_PARTIAL_APPLY_STATUS_INVALID:${record.status}`);

    const logCount = await client.query<{ rows: number; open_rows: number }>(
      `SELECT COUNT(*)::int AS rows,(COUNT(*) FILTER (WHERE rolled_back_at IS NULL))::int AS open_rows
         FROM historical_sales_cost_repair_apply_log
        WHERE partial_apply_id=$1`,
      [partialApplyId]
    );
    if (Number(logCount.rows[0].rows) !== targetRows || Number(logCount.rows[0].open_rows) !== targetRows) {
      throw hscrError("HSCR_PARTIAL_ROLLBACK_SNAPSHOT_INCOMPLETE");
    }

    await assertSalesItemsUpdateHasNoSideEffectTriggers(client);
    const locked = await client.query(
      `SELECT si.id
         FROM sales_items si
         JOIN historical_sales_cost_repair_apply_log l ON l.sales_item_id=si.id AND l.partial_apply_id=$1
        ORDER BY si.id
        FOR UPDATE OF si`,
      [partialApplyId]
    );
    if ((locked.rowCount ?? 0) !== targetRows) throw hscrError("HSCR_PARTIAL_ROLLBACK_ROWS_MISSING");

    // Fail closed if anything changed a repaired row after the apply: rolling
    // it back would overwrite that later change.
    const changed = await client.query<{ sales_item_id: number }>(
      `SELECT l.sales_item_id
         FROM historical_sales_cost_repair_apply_log l
         LEFT JOIN sales_items si ON si.id=l.sales_item_id
        WHERE l.partial_apply_id=$1
          AND (
            si.id IS NULL
            OR si.cost_price IS DISTINCT FROM l.after_cost_price
            OR si.total_cost IS DISTINCT FROM l.after_total_cost
            OR si.profit IS DISTINCT FROM l.after_profit
          )
        ORDER BY l.sales_item_id
        LIMIT 25`,
      [partialApplyId]
    );
    if (changed.rows.length > 0) {
      throw hscrError(
        `HSCR_PARTIAL_ROLLBACK_ROWS_CHANGED_SINCE_APPLY:${changed.rows.map((row) => row.sales_item_id).join(",")}`
      );
    }

    const companies = await client.query<{ company_id: number }>(
      `SELECT DISTINCT company_id FROM historical_sales_cost_repair_apply_log WHERE partial_apply_id=$1`,
      [partialApplyId]
    );
    const companyIds = companies.rows.map((row) => Number(row.company_id));
    const inventoryBefore = await inventoryEvidenceFingerprint(client, companyIds);

    const restored = await client.query(
      `UPDATE sales_items si
          SET cost_price=l.before_cost_price,
              total_cost=l.before_total_cost,
              profit=l.before_profit
         FROM historical_sales_cost_repair_apply_log l
        WHERE l.partial_apply_id=$1
          AND l.sales_item_id=si.id
          AND si.cost_price=l.after_cost_price
          AND si.total_cost=l.after_total_cost
          AND si.profit=l.after_profit`,
      [partialApplyId]
    );
    if ((restored.rowCount ?? 0) !== targetRows) throw hscrError("HSCR_PARTIAL_ROLLBACK_UPDATE_COUNT_MISMATCH");

    const marked = await client.query(
      `UPDATE historical_sales_cost_repair_apply_log
          SET rolled_back_at=NOW(),rolled_back_by=$2
        WHERE partial_apply_id=$1 AND rolled_back_at IS NULL`,
      [partialApplyId, input.rolledBackBy]
    );
    if ((marked.rowCount ?? 0) !== targetRows) throw hscrError("HSCR_PARTIAL_ROLLBACK_LOG_COUNT_MISMATCH");

    const verify = await client.query<{ mismatched: number; cogs: string; profit: string }>(
      `SELECT (COUNT(*) FILTER (
                WHERE si.id IS NULL
                   OR si.cost_price IS DISTINCT FROM l.before_cost_price
                   OR si.total_cost IS DISTINCT FROM l.before_total_cost
                   OR si.profit IS DISTINCT FROM l.before_profit
              ))::int AS mismatched,
              COALESCE(SUM(si.total_cost),0)::numeric(24,2)::text AS cogs,
              COALESCE(SUM(si.profit),0)::numeric(24,2)::text AS profit
         FROM historical_sales_cost_repair_apply_log l
         LEFT JOIN sales_items si ON si.id=l.sales_item_id
        WHERE l.partial_apply_id=$1`,
      [partialApplyId]
    );
    if (Number(verify.rows[0].mismatched) !== 0) throw hscrError("HSCR_PARTIAL_ROLLBACK_VERIFY_FAILED");

    const inventoryAfter = await inventoryEvidenceFingerprint(client, companyIds);
    if (inventoryAfter.hash !== inventoryBefore.hash || inventoryAfter.rowCount !== inventoryBefore.rowCount) {
      throw hscrError("HSCR_INVENTORY_CHANGED_DURING_ROLLBACK");
    }

    await client.query(
      `UPDATE historical_sales_cost_repair_partial_applies
          SET status='rolled_back',rolled_back_by=$2,rolled_back_at=NOW(),
              rollback_report=jsonb_build_object(
                'restoredRows',$3::int,'cogs',$4::text,'profit',$5::text,
                'inventoryBeforeHash',$6::text,'inventoryAfterHash',$7::text
              )
        WHERE id=$1`,
      [
        partialApplyId,
        input.rolledBackBy,
        targetRows,
        verify.rows[0].cogs,
        verify.rows[0].profit,
        inventoryBefore.hash,
        inventoryAfter.hash,
      ]
    );

    await assertTransactionWrites(client, writesBefore, {
      [SALES_ITEMS_TABLE]: { ins: 0, upd: targetRows, del: 0 },
      [APPLY_LOG_TABLE]: { ins: 0, upd: targetRows, del: 0 },
      [PARTIAL_APPLIES_TABLE]: { ins: 0, upd: 1, del: 0 },
    });

    await client.query("COMMIT");
    logger.info("Historical sales cost partial apply rolled back", {
      module: "historical-sales-cost-repair",
      action: "partial-rollback",
      runId: input.runId,
      partialApplyId,
      restoredRows: targetRows,
      rolledBackBy: input.rolledBackBy,
    });
    return { runId: input.runId, partialApplyId, restoredRows: targetRows, alreadyRolledBack: false };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

/** Read-only, independent post-apply verification against live sales_items. */
export async function verifyHistoricalSalesCostPartialApplyWithClient(client: PoolClient, runId: number) {
  const recordResult = await client.query<{ id: number; status: string; target_rows: number; report: unknown }>(
    `SELECT id,status,target_rows,report FROM historical_sales_cost_repair_partial_applies WHERE run_id=$1`,
    [runId]
  );
  const record = recordResult.rows[0];
  if (!record) throw hscrError("HSCR_PARTIAL_APPLY_NOT_FOUND");
  const partialApplyId = Number(record.id);
  const [live, nonReadyLogged, nonTargetDrift, recon] = await sequential([
    () =>
      client.query<{
        rows: number;
        at_after: number;
        at_before: number;
        before_cogs: string;
        after_cogs: string;
        live_cogs: string;
        before_profit: string;
        after_profit: string;
        live_profit: string;
      }>(
        `SELECT COUNT(*)::int AS rows,
              (COUNT(*) FILTER (WHERE si.cost_price=l.after_cost_price AND si.total_cost=l.after_total_cost
                                  AND si.profit=l.after_profit))::int AS at_after,
              (COUNT(*) FILTER (WHERE si.cost_price=l.before_cost_price AND si.total_cost=l.before_total_cost
                                  AND si.profit=l.before_profit))::int AS at_before,
              SUM(l.before_total_cost)::numeric(24,2)::text AS before_cogs,
              SUM(l.after_total_cost)::numeric(24,2)::text AS after_cogs,
              SUM(si.total_cost)::numeric(24,2)::text AS live_cogs,
              SUM(l.before_profit)::numeric(24,2)::text AS before_profit,
              SUM(l.after_profit)::numeric(24,2)::text AS after_profit,
              SUM(si.profit)::numeric(24,2)::text AS live_profit
         FROM historical_sales_cost_repair_apply_log l
         LEFT JOIN sales_items si ON si.id=l.sales_item_id
        WHERE l.partial_apply_id=$1`,
        [partialApplyId]
      ),
    () =>
      client.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count
         FROM historical_sales_cost_repair_apply_log l
         LEFT JOIN historical_sales_cost_repair_rows r ON r.run_id=l.run_id AND r.sales_item_id=l.sales_item_id
        WHERE l.partial_apply_id=$1 AND (r.id IS NULL OR r.status<>'ready')`,
        [partialApplyId]
      ),
    () => nonTargetDriftCount(client, runId),
    () => reconciliation(client, runId),
  ]);
  const row = live.rows[0];
  const expectedAtAfter = record.status === "applied";
  const ok =
    Number(row.rows) === Number(record.target_rows) &&
    Number(row.rows) === recon.target.rows &&
    Number(nonReadyLogged.rows[0].count) === 0 &&
    (expectedAtAfter
      ? Number(row.at_after) === Number(row.rows) && row.live_cogs === recon.target.proposedCogs
      : Number(row.at_before) === Number(row.rows));
  return {
    runId,
    partialApplyId,
    status: record.status,
    ok,
    targetRows: Number(record.target_rows),
    loggedRows: Number(row.rows),
    rowsAtProposed: Number(row.at_after),
    rowsAtOriginal: Number(row.at_before),
    loggedRowsNotReady: Number(nonReadyLogged.rows[0].count),
    blockedOrUnchangedRowsDifferingFromOriginal: nonTargetDrift,
    cogs: { before: row.before_cogs, after: row.after_cogs, live: row.live_cogs },
    profit: { before: row.before_profit, after: row.after_profit, live: row.live_profit },
    reconciliation: recon,
  };
}

async function withReadOnlyClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  await ensureHistoricalSalesCostRepairSchema(pool);
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await enableMaintenanceScope(client);
    return await fn(client);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

export function previewHistoricalSalesCostPartialApply(runId: number, options: { includeTargetIds?: boolean } = {}) {
  return withReadOnlyClient((client) => previewHistoricalSalesCostPartialApplyWithClient(client, runId, options));
}

export function verifyHistoricalSalesCostPartialApply(runId: number) {
  return withReadOnlyClient((client) => verifyHistoricalSalesCostPartialApplyWithClient(client, runId));
}

export async function applyHistoricalSalesCostPartial(input: PartialApplyInput): Promise<PartialApplyResult> {
  validatePartialApplyInput(input);
  await ensureHistoricalSalesCostRepairSchema(pool);
  const client = await pool.connect();
  try {
    return await applyHistoricalSalesCostPartialWithClient(client, input);
  } finally {
    client.release();
  }
}

export async function rollbackHistoricalSalesCostPartial(input: PartialRollbackInput): Promise<PartialRollbackResult> {
  validatePartialRollbackInput(input);
  await ensureHistoricalSalesCostRepairSchema(pool);
  const client = await pool.connect();
  try {
    return await rollbackHistoricalSalesCostPartialWithClient(client, input);
  } finally {
    client.release();
  }
}
