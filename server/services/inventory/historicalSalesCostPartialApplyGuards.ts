/** Write-set, row-integrity, reconciliation and evidence guards for the proven-rows-only partial apply. */
import type { PoolClient } from "pg";
import {
  assertNoHistoricalSourceEditsAfterCutoff,
  hscrError,
  recomputeHistoricalSalesCompanyEvidenceHash,
} from "./historicalSalesCostRepair";
import {
  TARGET_HASH_SQL,
  totals,
  type RunRow,
  type StatusCount,
  type TotalsRow,
  type PartialApplyDeps,
} from "./historicalSalesCostPartialApplyGuardsHelpers";
export {
  APPLY_LOCK_SQL,
  SALES_ITEMS_TABLE,
  APPLY_LOG_TABLE,
  PARTIAL_APPLIES_TABLE,
  HEX64,
  tableWriteViolations,
  transactionWriteCounts,
  assertTransactionWrites,
  RUN_SQL,
  type PartialApplyInput,
  type PartialRollbackInput,
  type TableWriteCounts,
  type RunRow,
  type PartialApplyDeps,
} from "./historicalSalesCostPartialApplyGuardsHelpers";

export function partialApplyConfirmation(runId: number, auditHash: string, targetHash: string): string {
  return `PARTIAL-APPLY-PROVEN-ROWS:${runId}:${auditHash.slice(0, 12)}:${targetHash.slice(0, 12)}`;
}

export function partialRollbackConfirmation(runId: number, auditHash: string): string {
  return `ROLLBACK-PARTIAL-APPLY:${runId}:${auditHash.slice(0, 12)}`;
}

export async function targetFingerprint(
  client: PoolClient,
  runId: number,
  auditHash: string
): Promise<{ targetRows: number; targetHash: string }> {
  const result = await client.query<{ target_rows: number; target_hash: string }>(TARGET_HASH_SQL, [
    runId,
    `${runId}|${auditHash}`,
  ]);
  return { targetRows: Number(result.rows[0].target_rows), targetHash: String(result.rows[0].target_hash) };
}

export async function runRowStatusCounts(client: PoolClient, runId: number): Promise<StatusCount[]> {
  const result = await client.query<StatusCount>(
    `SELECT status,
            COUNT(*)::int AS rows,
            (COUNT(*) FILTER (WHERE changed))::int AS changed_rows,
            (COUNT(*) FILTER (WHERE blocker_code IS NOT NULL OR blocker_detail IS NOT NULL))::int AS blocker_rows,
            (COUNT(*) FILTER (
              WHERE proposed_cost_price=original_cost_price
                AND proposed_total_cost=original_total_cost
                AND proposed_profit=original_profit
            ))::int AS no_op_rows
       FROM historical_sales_cost_repair_rows
      WHERE run_id=$1
      GROUP BY status
      ORDER BY status`,
    [runId]
  );
  return result.rows.map((row) => ({
    status: row.status,
    rows: Number(row.rows),
    changed_rows: Number(row.changed_rows),
    blocker_rows: Number(row.blocker_rows),
    no_op_rows: Number(row.no_op_rows),
  }));
}

/**
 * The persisted row set must be exactly what the run reported: only
 * ready/blocked/unchanged statuses, ready rows changed and blocker-free,
 * every blocked row still carrying its blocker code.
 */
export function rowSetIntegrityViolations(run: RunRow, counts: StatusCount[]): string[] {
  const violations: string[] = [];
  const by = new Map(counts.map((row) => [row.status, row]));
  for (const row of counts) {
    if (!["ready", "blocked", "unchanged"].includes(row.status)) violations.push(`unexpected-status:${row.status}`);
  }
  const ready = by.get("ready") ?? { status: "ready", rows: 0, changed_rows: 0, blocker_rows: 0, no_op_rows: 0 };
  const blocked = by.get("blocked") ?? { status: "blocked", rows: 0, changed_rows: 0, blocker_rows: 0, no_op_rows: 0 };
  const total = counts.reduce((sum, row) => sum + row.rows, 0);
  if (total !== Number(run.total_sales_rows)) violations.push(`total:${total}/${run.total_sales_rows}`);
  if (ready.rows !== Number(run.changed_rows)) violations.push(`ready:${ready.rows}/${run.changed_rows}`);
  if (blocked.rows !== Number(run.blocked_rows)) violations.push(`blocked:${blocked.rows}/${run.blocked_rows}`);
  if (ready.changed_rows !== ready.rows) violations.push(`ready-not-changed:${ready.rows - ready.changed_rows}`);
  if (ready.blocker_rows !== 0) violations.push(`ready-with-blocker:${ready.blocker_rows}`);
  if (ready.no_op_rows !== 0) violations.push(`ready-no-op:${ready.no_op_rows}`);
  if (blocked.blocker_rows !== blocked.rows)
    violations.push(`blocked-without-code:${blocked.rows - blocked.blocker_rows}`);
  return violations;
}

/** One pg client runs one query at a time; run the report queries in order. */
export async function sequential<T extends (() => Promise<unknown>)[]>(
  tasks: [...T]
): Promise<{ -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> }> {
  const results: unknown[] = [];
  for (const task of tasks) results.push(await task());
  return results as { -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> };
}

const TOTALS_SELECT = `COUNT(*)::int AS rows,
       COALESCE(SUM(r.original_total_cost),0)::numeric(24,2)::text AS original_cogs,
       COALESCE(SUM(r.proposed_total_cost),0)::numeric(24,2)::text AS proposed_cogs,
       COALESCE(SUM(r.proposed_total_cost-r.original_total_cost),0)::numeric(24,2)::text AS cogs_delta,
       COALESCE(SUM(r.original_profit),0)::numeric(24,2)::text AS original_profit,
       COALESCE(SUM(r.proposed_profit),0)::numeric(24,2)::text AS proposed_profit,
       COALESCE(SUM(r.proposed_profit-r.original_profit),0)::numeric(24,2)::text AS profit_delta`;

export async function reconciliation(client: PoolClient, runId: number) {
  const [target, byCompany, byMonth, untouched] = await sequential([
    () =>
      client.query<TotalsRow>(
        `SELECT ${TOTALS_SELECT} FROM historical_sales_cost_repair_rows r WHERE r.run_id=$1 AND r.status='ready'`,
        [runId]
      ),
    () =>
      client.query<TotalsRow & { company_id: number }>(
        `SELECT r.company_id,${TOTALS_SELECT}
         FROM historical_sales_cost_repair_rows r
        WHERE r.run_id=$1 AND r.status='ready'
        GROUP BY r.company_id ORDER BY r.company_id`,
        [runId]
      ),
    () =>
      client.query<TotalsRow & { company_id: number; month: string }>(
        `SELECT r.company_id,to_char(date_trunc('month',r.occurred_at),'YYYY-MM') AS month,${TOTALS_SELECT}
         FROM historical_sales_cost_repair_rows r
        WHERE r.run_id=$1 AND r.status='ready'
        GROUP BY r.company_id,date_trunc('month',r.occurred_at)
        ORDER BY r.company_id,month`,
        [runId]
      ),
    () =>
      client.query<{ status: string; rows: number; original_cogs: string; original_profit: string }>(
        `SELECT r.status,COUNT(*)::int AS rows,
              COALESCE(SUM(r.original_total_cost),0)::numeric(24,2)::text AS original_cogs,
              COALESCE(SUM(r.original_profit),0)::numeric(24,2)::text AS original_profit
         FROM historical_sales_cost_repair_rows r
        WHERE r.run_id=$1 AND r.status IN ('blocked','unchanged')
        GROUP BY r.status ORDER BY r.status`,
        [runId]
      ),
  ]);
  const untouchedBy = new Map(untouched.rows.map((row) => [row.status, row]));
  const remaining = (status: string) => ({
    rows: Number(untouchedBy.get(status)?.rows ?? 0),
    cogsKeptAtOriginal: untouchedBy.get(status)?.original_cogs ?? "0.00",
    profitKeptAtOriginal: untouchedBy.get(status)?.original_profit ?? "0.00",
    writes: 0,
  });
  return {
    target: totals(target.rows[0]),
    byCompany: byCompany.rows.map((row) => ({ companyId: Number(row.company_id), ...totals(row) })),
    byMonth: byMonth.rows.map((row) => ({ companyId: Number(row.company_id), month: row.month, ...totals(row) })),
    blockedRemainUnchanged: remaining("blocked"),
    unchangedRemainUnchanged: remaining("unchanged"),
  };
}

/** Target rows whose live sales_items row no longer matches the reviewed original. */
export async function liveTargetDrift(client: PoolClient, runId: number): Promise<{ count: number; sample: string[] }> {
  const result = await client.query<{ sales_item_id: number; reason: string; total: number }>(
    `WITH drift AS (
       SELECT r.sales_item_id,
              CASE
                WHEN si.id IS NULL THEN 'sale-row-missing'
                WHEN v.id IS NULL THEN 'voucher-missing'
                WHEN v.deleted_at IS NOT NULL THEN 'voucher-deleted'
                WHEN v.company_id IS DISTINCT FROM r.company_id THEN 'company-changed'
                WHEN v.voucher_type IS DISTINCT FROM 'Sales' THEN 'voucher-type-changed'
                WHEN si.voucher_id IS DISTINCT FROM r.voucher_id THEN 'voucher-changed'
                WHEN si.stock_item_id IS DISTINCT FROM r.stock_item_id THEN 'stock-item-changed'
                WHEN si.cost_price IS DISTINCT FROM r.original_cost_price THEN 'cost-price-changed'
                WHEN si.total_cost IS DISTINCT FROM r.original_total_cost THEN 'total-cost-changed'
                WHEN si.profit IS DISTINCT FROM r.original_profit THEN 'profit-changed'
              END AS reason
         FROM historical_sales_cost_repair_rows r
         LEFT JOIN sales_items si ON si.id=r.sales_item_id
         LEFT JOIN vouchers v ON v.id=si.voucher_id
        WHERE r.run_id=$1 AND r.status='ready'
     )
     SELECT sales_item_id,reason,(COUNT(*) OVER ())::int AS total
       FROM drift
      WHERE reason IS NOT NULL
      ORDER BY sales_item_id
      LIMIT 25`,
    [runId]
  );
  return {
    count: Number(result.rows[0]?.total ?? 0),
    sample: result.rows.map((row) => `${row.sales_item_id}:${row.reason}`),
  };
}

/** Non-target rows of the run (blocked/unchanged) whose live sale no longer equals its original. */
export async function nonTargetDriftCount(client: PoolClient, runId: number): Promise<number> {
  const result = await client.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count
       FROM historical_sales_cost_repair_rows r
       LEFT JOIN sales_items si ON si.id=r.sales_item_id
      WHERE r.run_id=$1
        AND r.status IN ('blocked','unchanged')
        AND (
          si.id IS NULL
          OR si.cost_price IS DISTINCT FROM r.original_cost_price
          OR si.total_cost IS DISTINCT FROM r.original_total_cost
          OR si.profit IS DISTINCT FROM r.original_profit
        )`,
    [runId]
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function assertEvidenceUnchanged(
  client: PoolClient,
  runId: number,
  companyIds: number[],
  sourceCutoff: Date,
  deps: PartialApplyDeps
): Promise<void> {
  const evidenceChecks = await client.query<{ company_id: number; expected_value: string }>(
    `SELECT company_id,expected_value
       FROM historical_sales_cost_repair_checks
      WHERE run_id=$1 AND check_code='V2_SOURCE_EVIDENCE_HASH' AND status='pass'
      ORDER BY company_id`,
    [runId]
  );
  const expectedByCompany = new Map(
    evidenceChecks.rows.map((row) => [Number(row.company_id), String(row.expected_value)])
  );
  if (expectedByCompany.size !== companyIds.length || evidenceChecks.rows.length !== companyIds.length) {
    throw hscrError("HSCR_V2_EVIDENCE_HASH_SCOPE_MISMATCH");
  }
  const recompute = deps.recomputeEvidenceHash ?? recomputeHistoricalSalesCompanyEvidenceHash;
  for (const companyId of companyIds) {
    const expected = expectedByCompany.get(companyId);
    if (!expected) throw hscrError(`HSCR_V2_EVIDENCE_HASH_MISSING:${companyId}`);
    const actual = await recompute(client, companyId, sourceCutoff);
    if (actual !== expected) throw hscrError(`HSCR_V2_SOURCE_EVIDENCE_DRIFT:${companyId}`);
  }
  await (deps.assertNoSourceEdits ?? assertNoHistoricalSourceEditsAfterCutoff)(client, companyIds, sourceCutoff);
}

export type PartialApplyPreview = {
  runId: number;
  runStatus: string;
  algorithmVersion: string;
  runningAlgorithmVersion: string;
  auditHash: string | null;
  sourceCutoff: string;
  totalRows: number;
  statusCounts: StatusCount[];
  rowSetViolations: string[];
  targetRows: number;
  targetHash: string;
  requiredConfirmation: string | null;
  requiredRollbackConfirmation: string | null;
  liveTargetDrift: { count: number; sample: string[] };
  blockedRowsTargeted: number;
  unchangedRowsTargeted: number;
  existingPartialApply: Record<string, unknown> | null;
  otherActivePartialApplies: number[];
  reconciliation: Awaited<ReturnType<typeof reconciliation>>;
  targetSalesItemIds?: number[];
};
