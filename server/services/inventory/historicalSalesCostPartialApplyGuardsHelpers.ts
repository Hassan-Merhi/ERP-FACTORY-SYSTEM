// Extracted from ./historicalSalesCostPartialApplyGuards.ts
import type { PoolClient } from "pg";
import { hscrError } from "./historicalSalesCostRepair";

export const APPLY_LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtext('historical-sales-cost-repair-apply'))";

export const SALES_ITEMS_TABLE = "public.sales_items";

export const APPLY_LOG_TABLE = "public.historical_sales_cost_repair_apply_log";

export const PARTIAL_APPLIES_TABLE = "public.historical_sales_cost_repair_partial_applies";

export const HEX64 = /^[a-f0-9]{64}$/;

export type PartialApplyInput = {
  runId: number;
  auditHash: string;
  targetHash: string;
  mode: string;
  confirmation: string;
  appliedBy: string;
};

export type PartialRollbackInput = {
  runId: number;
  auditHash: string;
  confirmation: string;
  rolledBackBy: string;
};

export type TableWriteCounts = Map<string, { ins: number; upd: number; del: number }>;

/**
 * Compares the transaction's per-table write counters with the exact set of
 * writes the operation is allowed to make. Any table not listed must show
 * zero inserts, updates and deletes.
 */
export function tableWriteViolations(
  before: TableWriteCounts,
  after: TableWriteCounts,
  allowed: Record<string, { ins: number; upd: number; del: number }>
): string[] {
  const names = new Set([...before.keys(), ...after.keys(), ...Object.keys(allowed)]);
  const violations: string[] = [];
  for (const name of [...names].sort()) {
    const b = before.get(name) ?? { ins: 0, upd: 0, del: 0 };
    const a = after.get(name) ?? { ins: 0, upd: 0, del: 0 };
    const delta = { ins: a.ins - b.ins, upd: a.upd - b.upd, del: a.del - b.del };
    const expected = allowed[name] ?? { ins: 0, upd: 0, del: 0 };
    if (delta.ins !== expected.ins || delta.upd !== expected.upd || delta.del !== expected.del) {
      violations.push(
        `${name}:ins=${delta.ins}/${expected.ins},upd=${delta.upd}/${expected.upd},del=${delta.del}/${expected.del}`
      );
    }
  }
  return violations;
}

export async function transactionWriteCounts(client: PoolClient): Promise<TableWriteCounts> {
  const result = await client.query<{ name: string; ins: string; upd: string; del: string }>(
    `SELECT schemaname||'.'||relname AS name,
            n_tup_ins::text AS ins,n_tup_upd::text AS upd,n_tup_del::text AS del
       FROM pg_stat_xact_user_tables`
  );
  return new Map(
    result.rows.map((row) => [row.name, { ins: Number(row.ins), upd: Number(row.upd), del: Number(row.del) }])
  );
}

export async function assertTransactionWrites(
  client: PoolClient,
  before: TableWriteCounts,
  allowed: Record<string, { ins: number; upd: number; del: number }>
): Promise<void> {
  const violations = tableWriteViolations(before, await transactionWriteCounts(client), allowed);
  if (violations.length > 0) {
    throw hscrError(`HSCR_PARTIAL_UNEXPECTED_WRITES:${violations.join(";")}`);
  }
}

/**
 * Deterministic fingerprint of the exact target set: run, audit hash, and
 * every ready row's identity plus original and proposed values, ordered by
 * sales_items id. The operator approves this hash; apply recomputes it.
 */
export const TARGET_HASH_SQL = `
  SELECT COUNT(*)::int AS target_rows,
         encode(sha256(convert_to(
           $2::text || E'\\n' || COALESCE(string_agg(concat_ws('|',
             r.sales_item_id,r.company_id,r.voucher_id,r.location_id,r.stock_item_id,
             r.original_cost_price::text,r.original_total_cost::text,r.original_profit::text,
             r.proposed_cost_price::text,r.proposed_total_cost::text,r.proposed_profit::text
           ),E'\\n' ORDER BY r.sales_item_id),''),
         'UTF8')),'hex') AS target_hash
    FROM historical_sales_cost_repair_rows r
   WHERE r.run_id=$1 AND r.status='ready'`;

export type RunRow = {
  id: number;
  status: string;
  audit_hash: string | null;
  algorithm_version: string;
  source_cutoff_at: Date;
  requested_company_ids: number[] | null;
  completed_at: Date | null;
  total_sales_rows: number;
  changed_rows: number;
  blocked_rows: number;
};

export const RUN_SQL = `SELECT id,status,audit_hash,algorithm_version,source_cutoff_at,requested_company_ids,
                        completed_at,total_sales_rows,changed_rows,blocked_rows
                   FROM historical_sales_cost_repair_runs
                  WHERE id=$1`;

export type StatusCount = {
  status: string;
  rows: number;
  changed_rows: number;
  blocker_rows: number;
  no_op_rows: number;
};

type MoneyTotals = {
  rows: number;
  originalCogs: string;
  proposedCogs: string;
  cogsDelta: string;
  originalProfit: string;
  proposedProfit: string;
  profitDelta: string;
};

export type TotalsRow = {
  rows: number;
  original_cogs: string;
  proposed_cogs: string;
  cogs_delta: string;
  original_profit: string;
  proposed_profit: string;
  profit_delta: string;
};

export function totals(row: TotalsRow | undefined): MoneyTotals {
  return {
    rows: Number(row?.rows ?? 0),
    originalCogs: row?.original_cogs ?? "0.00",
    proposedCogs: row?.proposed_cogs ?? "0.00",
    cogsDelta: row?.cogs_delta ?? "0.00",
    originalProfit: row?.original_profit ?? "0.00",
    proposedProfit: row?.proposed_profit ?? "0.00",
    profitDelta: row?.profit_delta ?? "0.00",
  };
}

export type PartialApplyDeps = {
  algorithmVersion?: string;
  recomputeEvidenceHash?: (client: PoolClient, companyId: number, sourceCutoff: Date) => Promise<string>;
  assertNoSourceEdits?: (client: PoolClient, companyIds: number[], sourceCutoff: Date) => Promise<void>;
};
