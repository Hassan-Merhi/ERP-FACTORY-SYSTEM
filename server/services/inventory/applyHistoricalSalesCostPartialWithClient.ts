// Extracted from ./historicalSalesCostPartialApply.ts to keep that module under the source-size cap.
import type { PoolClient } from "pg";
import { logger } from "../../lib/logger";
import {
  assertSalesItemsUpdateHasNoSideEffectTriggers,
  hscrError,
  inventoryEvidenceFingerprint,
} from "./historicalSalesCostRepair";
import {
  assertSalesCostTargetsInOpenPeriods,
  disableMaintenanceScope,
  enableRunCompanyScope,
} from "./historicalSalesCostRepairLoaders";
import { HISTORICAL_SALES_COST_REPAIR_ALGORITHM_VERSION } from "./historicalSalesCostRepairEngine";
import {
  APPLY_LOCK_SQL,
  APPLY_LOG_TABLE,
  assertEvidenceUnchanged,
  assertTransactionWrites,
  liveTargetDrift,
  nonTargetDriftCount,
  PARTIAL_APPLIES_TABLE,
  PartialApplyDeps,
  PartialApplyInput,
  reconciliation,
  rowSetIntegrityViolations,
  RUN_SQL,
  RunRow,
  runRowStatusCounts,
  SALES_ITEMS_TABLE,
  targetFingerprint,
  transactionWriteCounts,
} from "./historicalSalesCostPartialApplyGuards";
import {
  HISTORICAL_SALES_COST_PARTIAL_APPLY_LOG_MODE,
  validatePartialApplyInput,
  type PartialApplyResult,
} from "./previewHistoricalSalesCostPartialApplyWithClient";

export async function applyHistoricalSalesCostPartialWithClient(
  client: PoolClient,
  input: PartialApplyInput,
  deps: PartialApplyDeps = {}
): Promise<PartialApplyResult> {
  validatePartialApplyInput(input);
  const algorithmVersion = deps.algorithmVersion ?? HISTORICAL_SALES_COST_REPAIR_ALGORITHM_VERSION;
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await disableMaintenanceScope(client);
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
    await enableRunCompanyScope(client, companyIds);
    await assertSalesCostTargetsInOpenPeriods(client, { kind: "run", runId: input.runId });

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
