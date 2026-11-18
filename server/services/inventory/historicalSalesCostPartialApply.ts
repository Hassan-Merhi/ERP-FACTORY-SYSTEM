import type { PoolClient } from "pg";

import { pool } from "../../db";
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
import {
  APPLY_LOCK_SQL,
  APPLY_LOG_TABLE,
  PARTIAL_APPLIES_TABLE,
  PartialApplyInput,
  PartialRollbackInput,
  SALES_ITEMS_TABLE,
  assertTransactionWrites,
  transactionWriteCounts,
} from "./historicalSalesCostPartialApplyGuards";
import {
  previewHistoricalSalesCostPartialApplyWithClient,
  validatePartialApplyInput,
  validatePartialRollbackInput,
  type PartialApplyResult,
} from "./previewHistoricalSalesCostPartialApplyWithClient";
import { applyHistoricalSalesCostPartialWithClient } from "./applyHistoricalSalesCostPartialWithClient";
import type { PartialRollbackResult } from "./historicalSalesCostPartialApplyTypes";
import {
  verifyHistoricalSalesCostPartialApplyWithClient,
  withReadOnlyClient,
} from "./historicalSalesCostPartialApplyHelpers";
export { verifyHistoricalSalesCostPartialApplyWithClient } from "./historicalSalesCostPartialApplyHelpers";
export {
  HISTORICAL_SALES_COST_PARTIAL_APPLY_LOG_MODE,
  HISTORICAL_SALES_COST_PARTIAL_APPLY_MODE,
  previewHistoricalSalesCostPartialApplyWithClient,
  validatePartialApplyInput,
  validatePartialRollbackInput,
} from "./previewHistoricalSalesCostPartialApplyWithClient";
export type { PartialApplyResult } from "./previewHistoricalSalesCostPartialApplyWithClient";
export { applyHistoricalSalesCostPartialWithClient } from "./applyHistoricalSalesCostPartialWithClient";
export type { PartialRollbackResult } from "./historicalSalesCostPartialApplyTypes";

export async function rollbackHistoricalSalesCostPartialWithClient(
  client: PoolClient,
  input: PartialRollbackInput
): Promise<PartialRollbackResult> {
  validatePartialRollbackInput(input);
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await disableMaintenanceScope(client);
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
    const logCompanies = await client.query<{ company_id: number }>(
      `SELECT DISTINCT company_id FROM historical_sales_cost_repair_apply_log WHERE partial_apply_id=$1`,
      [partialApplyId]
    );
    await enableRunCompanyScope(
      client,
      logCompanies.rows.map((row) => Number(row.company_id))
    );
    await assertSalesCostTargetsInOpenPeriods(client, { kind: "partial-apply", partialApplyId });

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

export function previewHistoricalSalesCostPartialApply(runId: number, options: { includeTargetIds?: boolean } = {}) {
  return withReadOnlyClient((client) => previewHistoricalSalesCostPartialApplyWithClient(client, runId, options));
}

export function verifyHistoricalSalesCostPartialApply(runId: number) {
  return withReadOnlyClient((client) => verifyHistoricalSalesCostPartialApplyWithClient(client, runId));
}

export async function applyHistoricalSalesCostPartial(input: PartialApplyInput): Promise<PartialApplyResult> {
  validatePartialApplyInput(input);
  const client = await pool.connect();
  try {
    return await applyHistoricalSalesCostPartialWithClient(client, input);
  } finally {
    client.release();
  }
}

export async function rollbackHistoricalSalesCostPartial(input: PartialRollbackInput): Promise<PartialRollbackResult> {
  validatePartialRollbackInput(input);
  const client = await pool.connect();
  try {
    return await rollbackHistoricalSalesCostPartialWithClient(client, input);
  } finally {
    client.release();
  }
}
