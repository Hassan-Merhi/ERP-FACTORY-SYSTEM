import type { PoolClient } from "pg";

import { pool } from "../../db";
import { logger } from "../../lib/logger";
import { ensureHistoricalSalesCostRepairSchema } from "./ensureHistoricalSalesCostRepairSchema";
import { HISTORICAL_SALES_COST_REPAIR_ALGORITHM_VERSION } from "./historicalSalesCostRepairEngine";
import { hscrError } from "./historicalSalesCostRepairTypes";
import {
  assertSalesCostTargetsInOpenPeriods,
  disableMaintenanceScope,
  enableRunCompanyScope,
} from "./historicalSalesCostRepairLoaders";
import {
  assertSalesItemsUpdateHasNoSideEffectTriggers,
  inventoryEvidenceFingerprint,
  recomputeHistoricalSalesCompanyEvidenceHash,
} from "./historicalSalesCostRepairEvidence";
export type { HistoricalSalesCostDryRunResult } from "./historicalSalesCostRepairPersistProposalRows";
export {
  buildHistoricalSalesCostRepairDryRun,
  diagnoseHistoricalSalesCostKey,
} from "./buildHistoricalSalesCostRepairDryRun";
export { getHistoricalSalesCostRepairRun } from "./getHistoricalSalesCostRepairRun";

export { hscrError } from "./historicalSalesCostRepairTypes";
export { enableMaintenanceScope } from "./historicalSalesCostRepairLoaders";
export {
  activeCanonicalSaleEvidence,
  assertSalesItemsUpdateHasNoSideEffectTriggers,
  canonicalMovementNumericId,
  droppedPosLineMovements,
  inventoryEvidenceFingerprint,
  recomputeHistoricalSalesCompanyEvidenceHash,
} from "./historicalSalesCostRepairEvidence";

/**
 * Fails when historical source evidence was back-dated or edited after the
 * dry-run cutoff. Normal new stock activity after the cutoff is allowed.
 * Shared by the full apply and the proven-rows-only partial apply.
 */
export async function assertNoHistoricalSourceEditsAfterCutoff(
  client: PoolClient,
  targetCompanyIds: number[],
  sourceCutoff: Date
): Promise<void> {
  const sourceDrift = await client.query<{
    kind: string;
    evidence_id: string;
  }>(
    `SELECT 'backdated-canonical'::text AS kind,id::text AS evidence_id
       FROM canonical_stock_movements
      WHERE company_id = ANY($1::int[])
        AND created_at > $2
        AND occurred_at <= $2
      UNION ALL
     SELECT 'historical-voucher-edit'::text AS kind,a.id::text AS evidence_id
       FROM audit_log a
       JOIN vouchers v
         ON a.table_name='vouchers'
        AND a.record_id=v.id
        AND v.company_id=a.company_id
      WHERE a.company_id = ANY($1::int[])
        AND a.created_at > $2
        AND v.created_at <= $2
      UNION ALL
     SELECT 'historical-container-edit'::text AS kind,a.id::text AS evidence_id
       FROM audit_log a
       JOIN containers c
         ON a.table_name='containers'
        AND a.record_id=c.id
        AND c.company_id=a.company_id
      WHERE a.company_id = ANY($1::int[])
        AND a.created_at > $2
        AND c.created_at <= $2
      ORDER BY kind,evidence_id
      LIMIT 25`,
    [targetCompanyIds, sourceCutoff]
  );
  if (sourceDrift.rows.length > 0) {
    throw new Error(
      `Historical sales cost repair source evidence changed after dry run: ${sourceDrift.rows
        .map((row) => `${row.kind}#${row.evidence_id}`)
        .join(", ")}. Build and review a new dry run.`
    );
  }
}

export async function applyHistoricalSalesCostRepair(input: {
  runId: number;
  auditHash: string;
  appliedBy: string;
}): Promise<{ runId: number; appliedRows: number; auditHash: string }> {
  await ensureHistoricalSalesCostRepairSchema(pool);
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    // Phase 19 (B), PE11: maintenance off; the run's companies' tenant scope below.
    await disableMaintenanceScope(client);
    await client.query("SELECT pg_advisory_xact_lock(hashtext('historical-sales-cost-repair-apply'))");

    const runResult = await client.query<{
      id: number;
      status: string;
      audit_hash: string;
      algorithm_version: string;
      blocked_rows: number;
      source_cutoff_at: Date;
      requested_company_ids: number[] | null;
    }>(
      `SELECT id,status,audit_hash,algorithm_version,blocked_rows,source_cutoff_at,requested_company_ids
         FROM historical_sales_cost_repair_runs
        WHERE id=$1
        FOR UPDATE`,
      [input.runId]
    );
    const run = runResult.rows[0];
    if (!run) throw hscrError("HSCR_RUN_NOT_FOUND");
    if (run.algorithm_version !== HISTORICAL_SALES_COST_REPAIR_ALGORITHM_VERSION) {
      throw hscrError("HSCR_ALGORITHM_VERSION_MISMATCH");
    }
    if (run.status !== "ready") {
      throw hscrError(`HSCR_RUN_NOT_READY:${input.runId}:${run.status}`);
    }
    if (!run.audit_hash || run.audit_hash !== input.auditHash) {
      throw hscrError("HSCR_AUDIT_HASH_MISMATCH");
    }
    const partial = await client.query("SELECT id FROM historical_sales_cost_repair_partial_applies WHERE run_id=$1", [
      input.runId,
    ]);
    if (partial.rows.length > 0) {
      throw hscrError("HSCR_RUN_PARTIALLY_APPLIED");
    }

    const blockerCount = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM historical_sales_cost_repair_checks
        WHERE run_id=$1 AND status='block'`,
      [input.runId]
    );
    if (Number(blockerCount.rows[0]?.count ?? 0) !== 0) {
      throw hscrError("HSCR_RUN_HAS_BLOCKERS");
    }

    const targetCompanyIds = (run.requested_company_ids ?? []).map(Number);
    if (targetCompanyIds.length === 0) {
      throw hscrError("HSCR_RUN_SCOPE_EMPTY");
    }
    await enableRunCompanyScope(client, targetCompanyIds);
    await assertSalesCostTargetsInOpenPeriods(client, { kind: "run", runId: input.runId });

    // Recompute the exact V2 evidence bundle that was reviewed during dry-run.
    // This pins the immutable checkpoint/cutoff, canonical + legacy movements,
    // merge aliases/source openings, and every target sale original.
    const evidenceChecks = await client.query<{ company_id: number; expected_value: string }>(
      `SELECT company_id,expected_value
         FROM historical_sales_cost_repair_checks
        WHERE run_id=$1
          AND check_code='V2_SOURCE_EVIDENCE_HASH'
          AND status='pass'
        ORDER BY company_id`,
      [input.runId]
    );
    const expectedEvidenceByCompany = new Map(
      evidenceChecks.rows.map((row) => [Number(row.company_id), String(row.expected_value)])
    );
    if (expectedEvidenceByCompany.size !== targetCompanyIds.length) {
      throw hscrError("HSCR_V2_EVIDENCE_HASH_SCOPE_MISMATCH");
    }
    for (const companyId of targetCompanyIds) {
      const expected = expectedEvidenceByCompany.get(companyId);
      if (!expected) throw hscrError(`HSCR_V2_EVIDENCE_HASH_MISSING:${companyId}`);
      const actual = await recomputeHistoricalSalesCompanyEvidenceHash(client, companyId, run.source_cutoff_at);
      if (actual !== expected) {
        throw hscrError(`HSCR_V2_SOURCE_EVIDENCE_DRIFT:${companyId}`);
      }
    }

    await assertSalesItemsUpdateHasNoSideEffectTriggers(client);
    const inventoryBeforeApply = await inventoryEvidenceFingerprint(client, targetCompanyIds);

    // Keep targeted "changed-after-cutoff" checks as a second line of defense.
    // Normal new stock activity after the source cutoff is allowed.
    await assertNoHistoricalSourceEditsAfterCutoff(client, targetCompanyIds, run.source_cutoff_at);

    const drift = await client.query<{ sales_item_id: number }>(
      `SELECT r.sales_item_id
         FROM historical_sales_cost_repair_rows r
         LEFT JOIN sales_items si ON si.id=r.sales_item_id
        WHERE r.run_id=$1
          AND r.status='ready'
          AND (
            si.id IS NULL
            OR si.cost_price IS DISTINCT FROM r.original_cost_price
            OR si.total_cost IS DISTINCT FROM r.original_total_cost
            OR si.profit IS DISTINCT FROM r.original_profit
          )
        ORDER BY r.sales_item_id
        LIMIT 25`,
      [input.runId]
    );
    if (drift.rows.length > 0) {
      throw new Error(
        `Historical sales cost repair refused because target sale rows changed after dry run: ${drift.rows
          .map((row) => row.sales_item_id)
          .join(", ")}`
      );
    }

    await client.query(
      `UPDATE historical_sales_cost_repair_runs
          SET status='applying',applied_by=$2
        WHERE id=$1`,
      [input.runId, input.appliedBy]
    );

    await client.query(
      `INSERT INTO historical_sales_cost_repair_apply_log
       (run_id,company_id,sales_item_id,before_cost_price,before_total_cost,before_profit,
        after_cost_price,after_total_cost,after_profit,applied_by)
       SELECT r.run_id,r.company_id,r.sales_item_id,
              r.original_cost_price,r.original_total_cost,r.original_profit,
              r.proposed_cost_price,r.proposed_total_cost,r.proposed_profit,$2
         FROM historical_sales_cost_repair_rows r
        WHERE r.run_id=$1 AND r.status='ready'
       ON CONFLICT (run_id,sales_item_id) DO NOTHING`,
      [input.runId, input.appliedBy]
    );

    const updated = await client.query(
      `UPDATE sales_items si
          SET cost_price=r.proposed_cost_price,
              total_cost=r.proposed_total_cost,
              profit=r.proposed_profit
         FROM historical_sales_cost_repair_rows r
        WHERE r.run_id=$1
          AND r.status='ready'
          AND r.sales_item_id=si.id
        RETURNING si.id`,
      [input.runId]
    );

    await client.query(
      `UPDATE historical_sales_cost_repair_rows
          SET status='applied',applied_at=NOW()
        WHERE run_id=$1 AND status='ready'`,
      [input.runId]
    );

    const verify = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM historical_sales_cost_repair_rows r
         JOIN sales_items si ON si.id=r.sales_item_id
        WHERE r.run_id=$1
          AND r.status='applied'
          AND (
            si.cost_price IS DISTINCT FROM r.proposed_cost_price
            OR si.total_cost IS DISTINCT FROM r.proposed_total_cost
            OR si.profit IS DISTINCT FROM r.proposed_profit
          )`,
      [input.runId]
    );
    if (Number(verify.rows[0]?.count ?? 0) !== 0) {
      throw hscrError("HSCR_POST_APPLY_VERIFY_FAILED");
    }

    const inventoryAfterApply = await inventoryEvidenceFingerprint(client, targetCompanyIds);
    if (
      inventoryAfterApply.hash !== inventoryBeforeApply.hash ||
      inventoryAfterApply.rowCount !== inventoryBeforeApply.rowCount
    ) {
      throw hscrError("HSCR_INVENTORY_CHANGED_DURING_APPLY");
    }

    await client.query(
      `UPDATE historical_sales_cost_repair_runs
          SET status='applied',
              applied_at=NOW(),
              completed_at=NOW(),
              report=COALESCE(report,'{}'::jsonb) || jsonb_build_object(
                'applyInventorySnapshot',
                jsonb_build_object(
                  'beforeHash',$2::text,
                  'afterHash',$3::text,
                  'rowCount',$4::int,
                  'unchanged',true
                )
              )
        WHERE id=$1`,
      [input.runId, inventoryBeforeApply.hash, inventoryAfterApply.hash, inventoryAfterApply.rowCount]
    );

    await client.query("COMMIT");

    logger.info("Historical sales cost repair applied", {
      module: "historical-sales-cost-repair",
      action: "apply",
      runId: input.runId,
      auditHash: input.auditHash,
      appliedRows: updated.rowCount ?? 0,
      appliedBy: input.appliedBy,
    });

    return {
      runId: input.runId,
      appliedRows: updated.rowCount ?? 0,
      auditHash: input.auditHash,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
