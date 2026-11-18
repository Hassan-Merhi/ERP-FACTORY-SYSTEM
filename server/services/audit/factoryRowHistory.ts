import type { Pool, PoolClient } from "pg";

import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";

/**
 * Change history of the factory tables the historical Net Position reads, so a
 * date from the baseline on can be rebuilt from what was recorded instead of
 * today's rows (factory_row_history, shared/schema/factory/row-history.ts).
 *
 * AFTER INSERT / UPDATE / DELETE statement triggers (transition tables, one
 * set-based INSERT per statement) record every row change:
 *   I  the whole new row;  D  the whole old row;
 *   U  only the columns that changed, before and after. An UPDATE that changes
 *      nothing, or only updated_at and the table's noise columns (a container's
 *      carrier-tracking fields), is not recorded.
 * Changes are stamped with clock_timestamp(), the moment they are written:
 * now() is the transaction's start and would date a change made by a
 * transaction begun before the baseline, or before midnight, too early.
 *
 * The factory_row_history tables, the functions (erp_factory_row_history,
 * erp_factory_row_history_company_id, erp_factory_row_history_append_only) and
 * every `<table>_row_history_{insert,update,delete}` trigger are defined by the
 * schema migrations (migrations/); nothing is installed at runtime.
 *
 * What runs at boot is data bookkeeping only (recordFactoryRowHistoryBaselines):
 * for each tracked table without a baseline at FACTORY_ROW_HISTORY_VERSION,
 * every existing row is copied as op S (first baseline only) under a SHARE ROW
 * EXCLUSIVE lock (reads continue, writes wait), and the baseline instant is
 * recorded in factory_row_history_baselines.baseline_at, read after the lock.
 * Each table is recorded in its own transaction and takes no other table lock,
 * so it cannot deadlock against the instance still serving traffic during a
 * deploy; a table it cannot lock within the timeout is left for the next boot.
 * History is evidence, not a write guard, so a failure is logged and the server
 * starts.
 */
export const FACTORY_ROW_HISTORY_VERSION = "2026-10-factory-row-history-v6-audit-write-scope";

/** Tracked tables and, for each, column-name prefixes whose changes alone are noise. */
export const FACTORY_ROW_HISTORY_TABLES: ReadonlyArray<readonly [table: string, noisePrefixes: readonly string[]]> = [
  ["customer_orders", []],
  ["customer_order_bales", []],
  ["customer_order_charges", []],
  ["factory_bales", []],
  ["factory_bale_products", []],
  ["factory_containers", ["tracking_", "json_cargo_"]],
  ["factory_container_other_charges", []],
  ["factory_container_receipts", []],
  ["factory_raw_stock", []],
  ["factory_suppliers", []],
  ["factory_mix_batches", []],
  ["factory_mix_batch_sources", []],
  ["factory_worker_advances", []],
  ["factory_advance_repayments", []],
  ["factory_payrolls", []],
  ["property_units", []],
  ["property_contracts", []],
  ["property_monthly_ledger", []],
  ["property_payments", []],
  ["ledger_accounts", []],
];

const BASELINE_LOCK_KEY = 2026_10_240;
const LOCK_TIMEOUT = "5s";

type TableStatus = { table_name: string; present: boolean; baselined: boolean; triggers: number };

/** Tracked tables that exist, with whether they have a baseline at this version and their history triggers. */
async function trackedTableStatus(client: PoolClient): Promise<TableStatus[]> {
  const result = await client.query<TableStatus>(
    `SELECT t.table_name,
            to_regclass('public.' || t.table_name) IS NOT NULL AS present,
            EXISTS (SELECT 1 FROM factory_row_history_baselines b
                     WHERE b.table_name = t.table_name AND b.version = $2) AS baselined,
            (SELECT count(*) FROM pg_trigger tg
              WHERE tg.tgrelid = to_regclass('public.' || t.table_name) AND NOT tg.tgisinternal
                AND tg.tgenabled = 'O'
                AND tg.tgname IN (t.table_name || '_row_history_insert', t.table_name || '_row_history_update',
                                  t.table_name || '_row_history_delete'))::int AS triggers
       FROM unnest($1::text[]) AS t(table_name)`,
    [FACTORY_ROW_HISTORY_TABLES.map(([table]) => table), FACTORY_ROW_HISTORY_VERSION]
  );
  return result.rows;
}

async function inTransaction(client: PoolClient, work: () => Promise<void>): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
    await client.query("SELECT pg_advisory_xact_lock($1)", [BASELINE_LOCK_KEY]);
    // ledger_accounts forces company-scope RLS; the baseline copies every company's rows.
    await client.query("SELECT set_config('app.company_scope_maintenance', 'on', true)");
    await work();
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

/**
 * Records one table's baseline: lock it against writes, snapshot its rows
 * (first baseline only) and record the baseline, all in one transaction.
 */
async function recordTableBaseline(client: PoolClient, table: string): Promise<number> {
  let snapshotRows = 0;
  await inTransaction(client, async () => {
    await client.query(`LOCK TABLE ${table} IN SHARE ROW EXCLUSIVE MODE`);
    // Taken after the lock: no write recorded before this instant is missing from the snapshot,
    // and every later write waits for this commit and is stamped after it.
    const baselineAt = (await client.query<{ at: string }>(`SELECT (clock_timestamp() AT TIME ZONE 'UTC')::text AS at`))
      .rows[0].at;
    const existing = await client.query(`SELECT 1 FROM factory_row_history_baselines WHERE table_name = $1`, [table]);
    if (existing.rowCount === 0) {
      const snapshot = await client.query(
        `INSERT INTO factory_row_history (table_name, record_id, company_id, op, recorded_at, actor, new_values)
         SELECT $1, (img->>'id')::bigint, erp_factory_row_history_company_id($1,img), 'S', $2::timestamp,
                'system:row-history-baseline', img
           FROM (SELECT to_jsonb(t) AS img FROM ${table} t) AS rows`,
        [table, baselineAt]
      );
      snapshotRows = snapshot.rowCount ?? 0;
    }
    await client.query(
      `INSERT INTO factory_row_history_baselines (table_name, baseline_at, snapshot_rows, version)
       VALUES ($1, $2::timestamp, $3, $4)
       ON CONFLICT (table_name) DO UPDATE SET version = EXCLUDED.version`,
      [table, baselineAt, snapshotRows, FACTORY_ROW_HISTORY_VERSION]
    );
  });
  return snapshotRows;
}

export type FactoryRowHistoryBaselines = { recorded: string[]; skipped: string[]; failed: string[] };

/**
 * Records the baseline of every tracked table that has none at
 * FACTORY_ROW_HISTORY_VERSION (data only: the history triggers come from the
 * schema migrations; a table whose triggers are missing is reported as failed
 * and gets no baseline). Never throws (history must not stop the server).
 */
export async function recordFactoryRowHistoryBaselines(
  pool: Pick<Pool, "connect">
): Promise<FactoryRowHistoryBaselines> {
  const outcome: FactoryRowHistoryBaselines = { recorded: [], skipped: [], failed: [] };
  const client = await pool.connect();
  try {
    const status = await trackedTableStatus(client);
    const pending = status.filter((row) => row.present && !row.baselined);
    outcome.skipped = FACTORY_ROW_HISTORY_TABLES.map(([table]) => table).filter(
      (table) => !pending.some((row) => row.table_name === table)
    );
    for (const row of pending) {
      const table = row.table_name;
      if (Number(row.triggers) !== 3) {
        outcome.failed.push(table);
        logger.warn(`[startup] Factory row history triggers missing on ${table}; no baseline recorded`, {
          triggers: Number(row.triggers),
        });
        continue;
      }
      try {
        const rows = await recordTableBaseline(client, table);
        outcome.recorded.push(table);
        logger.info(`[startup] ✓ Factory row history baseline recorded for ${table} (${rows} baseline rows)`);
      } catch (error) {
        outcome.failed.push(table);
        logger.warn(`[startup] Factory row history baseline not recorded for ${table}; retried on the next boot`, {
          error: getErrorMessage(error),
        });
      }
    }
    if (pending.length === 0) {
      logger.info(`[startup] ✓ Factory row history baselines already recorded (${FACTORY_ROW_HISTORY_VERSION})`);
    }
  } catch (error) {
    logger.error("[startup] ✗ Factory row history baselines could not be recorded; the server starts without them", {
      version: FACTORY_ROW_HISTORY_VERSION,
      error: getErrorMessage(error),
    });
  } finally {
    client.release();
  }
  return outcome;
}
