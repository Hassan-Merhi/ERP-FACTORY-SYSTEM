import type { Pool, PoolClient } from "pg";

import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { AUDIT_ACTOR_SETTINGS, UNKNOWN_AUDIT_ACTOR } from "./auditActorContext";

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
 * When a table's trigger is installed, every existing row is copied as op S in
 * the same transaction, under a SHARE ROW EXCLUSIVE lock (reads continue,
 * writes wait), so the snapshot and the trigger start at the same instant:
 * factory_row_history_baselines.baseline_at, read after the lock. Changes are
 * stamped with clock_timestamp(), the moment they are written: now() is the
 * transaction's start and would date a change made by a transaction begun
 * before the baseline, or before midnight, too early.
 *
 * Production disables the bulk startup migrations, so this runs on every boot.
 * A table already at FACTORY_ROW_HISTORY_VERSION with its triggers present is
 * skipped without DDL or locks. Each table installs in its own transaction and
 * takes no other table lock, so it cannot deadlock against the instance still
 * serving traffic during a deploy; a table it cannot lock within the timeout
 * is left for the next boot. History is evidence, not a write guard, so a
 * failure is logged and the server starts.
 */
export const FACTORY_ROW_HISTORY_VERSION = "2026-10-factory-row-history-v4-tenanted";

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
  ["property_contracts", []],
  ["property_monthly_ledger", []],
  ["property_payments", []],
  ["ledger_accounts", []],
];

const INSTALL_LOCK_KEY = 2026_10_240;
const LOCK_TIMEOUT = "5s";

const actor = `COALESCE(NULLIF(btrim(current_setting('${AUDIT_ACTOR_SETTINGS.actorId}', true)), ''), '${UNKNOWN_AUDIT_ACTOR}')`;

export const FACTORY_ROW_HISTORY_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS factory_row_history (
     id bigserial PRIMARY KEY,
     table_name text NOT NULL,
     record_id bigint NOT NULL,
     company_id integer,
     op varchar(1) NOT NULL,
     recorded_at timestamp NOT NULL DEFAULT clock_timestamp(),
     actor text,
     old_values jsonb,
     new_values jsonb
   )`,
  // Stamped when the change is written, not when its transaction began (now()).
  `ALTER TABLE factory_row_history ALTER COLUMN recorded_at SET DEFAULT clock_timestamp()`,
  `CREATE INDEX IF NOT EXISTS factory_row_history_record_idx ON factory_row_history (table_name, record_id, id)`,
  `CREATE INDEX IF NOT EXISTS factory_row_history_recorded_idx ON factory_row_history (table_name, recorded_at)`,
  `CREATE TABLE IF NOT EXISTS factory_row_history_baselines (
     table_name text PRIMARY KEY,
     baseline_at timestamp NOT NULL,
     snapshot_rows integer NOT NULL,
     version text NOT NULL
   )`,
  // Three source tables have no company_id of their own. Resolve the company
  // from their immutable parent identifier instead of silently writing NULL.
  // During cascaded deletes the parent may already be gone, so preserve the
  // last positively attributed owner when one exists.
  `CREATE OR REPLACE FUNCTION erp_factory_row_history_company_id(
       p_table text, p_row jsonb
     ) RETURNS integer LANGUAGE plpgsql STABLE AS $fn$
   DECLARE v_company integer;
   BEGIN
     IF p_row ? 'company_id' THEN
       RETURN (p_row->>'company_id')::integer;
     END IF;
     IF p_table IN ('customer_order_bales','customer_order_charges') THEN
       SELECT company_id INTO v_company FROM customer_orders
        WHERE id = (p_row->>'order_id')::integer;
     ELSIF p_table = 'factory_mix_batch_sources' THEN
       SELECT company_id INTO v_company FROM factory_mix_batches
        WHERE id = (p_row->>'mix_batch_id')::integer;
     END IF;
     IF v_company IS NULL THEN
       -- Reads of the history are tenant-scoped; outside any scope (22023) the
       -- owner stays unknown rather than failing the write being recorded.
       BEGIN
         SELECT company_id INTO v_company FROM factory_row_history
          WHERE table_name = p_table
            AND record_id = (p_row->>'id')::bigint
            AND company_id IS NOT NULL
          ORDER BY id DESC LIMIT 1;
       EXCEPTION WHEN SQLSTATE '22023' THEN
         v_company := NULL;
       END;
     END IF;
     RETURN v_company;
   END
   $fn$`,
  `CREATE OR REPLACE FUNCTION erp_factory_row_history() RETURNS trigger
   LANGUAGE plpgsql AS $fn$
   DECLARE
     v_actor text := ${actor};
     v_noise text[] := TG_ARGV;
   BEGIN
     IF TG_OP = 'INSERT' THEN
       INSERT INTO factory_row_history (table_name, record_id, company_id, op, recorded_at, actor, new_values)
       SELECT TG_TABLE_NAME, (img->>'id')::bigint, erp_factory_row_history_company_id(TG_TABLE_NAME,img), 'I', clock_timestamp(), v_actor, img
         FROM (SELECT to_jsonb(n) AS img FROM history_new n) AS rows;
     ELSIF TG_OP = 'UPDATE' THEN
       INSERT INTO factory_row_history (table_name, record_id, company_id, op, recorded_at, actor, old_values, new_values)
       SELECT TG_TABLE_NAME, (rows.after->>'id')::bigint, erp_factory_row_history_company_id(TG_TABLE_NAME,rows.after), 'U', clock_timestamp(), v_actor,
              diff.old_values, diff.new_values
         FROM (SELECT to_jsonb(o) AS before, to_jsonb(n) AS after
                 FROM history_old o JOIN history_new n ON n.id = o.id) AS rows
        CROSS JOIN LATERAL (
          SELECT jsonb_object_agg(e.key, e.value) AS old_values,
                 jsonb_object_agg(e.key, rows.after -> e.key) AS new_values,
                 bool_or(e.key <> 'updated_at'
                         AND NOT EXISTS (SELECT 1 FROM unnest(v_noise) AS p WHERE starts_with(e.key, p))) AS material
            FROM jsonb_each(rows.before) AS e
           WHERE e.value IS DISTINCT FROM rows.after -> e.key
        ) AS diff
        WHERE diff.material;
     ELSE
       INSERT INTO factory_row_history (table_name, record_id, company_id, op, recorded_at, actor, old_values)
       SELECT TG_TABLE_NAME, (img->>'id')::bigint, erp_factory_row_history_company_id(TG_TABLE_NAME,img), 'D', clock_timestamp(), v_actor, img
         FROM (SELECT to_jsonb(o) AS img FROM history_old o) AS rows;
     END IF;
     RETURN NULL;
   END
   $fn$`,
  // Read access is always company-scoped, even for the table owner; rows of
  // unknown ownership are never exposed to any tenant. Rows arrive only from
  // the triggers, recording a write the database already accepted, so INSERT
  // is never refused: a scope check here would roll back that write whenever
  // it ran outside a tenant scope (an unscoped job, a startup repair).
  `ALTER TABLE factory_row_history ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE factory_row_history FORCE ROW LEVEL SECURITY`,
  `DROP POLICY IF EXISTS factory_row_history_tenant_read ON factory_row_history`,
  `CREATE POLICY factory_row_history_tenant_read ON factory_row_history
      FOR SELECT USING (erp_company_scope_matches(company_id))`,
  `DROP POLICY IF EXISTS factory_row_history_tenant_insert ON factory_row_history`,
  `CREATE POLICY factory_row_history_tenant_insert ON factory_row_history
      FOR INSERT WITH CHECK (true)`,
  // Append-only, like audit_log: history that can be rewritten proves nothing.
  `CREATE OR REPLACE FUNCTION erp_factory_row_history_append_only() RETURNS trigger
   LANGUAGE plpgsql AS $fn$
   BEGIN
     RAISE EXCEPTION USING ERRCODE = '42501',
       MESSAGE = 'FACTORY_ROW_HISTORY_APPEND_ONLY: factory_row_history cannot be changed, deleted or truncated';
   END
   $fn$`,
  `DROP TRIGGER IF EXISTS factory_row_history_append_only ON factory_row_history`,
  `CREATE TRIGGER factory_row_history_append_only BEFORE UPDATE OR DELETE ON factory_row_history
     FOR EACH ROW EXECUTE FUNCTION erp_factory_row_history_append_only()`,
  `DROP TRIGGER IF EXISTS factory_row_history_no_truncate ON factory_row_history`,
  `CREATE TRIGGER factory_row_history_no_truncate BEFORE TRUNCATE ON factory_row_history
     FOR EACH STATEMENT EXECUTE FUNCTION erp_factory_row_history_append_only()`,
];

function tableTriggerDdl(table: string, noisePrefixes: readonly string[]): string[] {
  const args = noisePrefixes.map((prefix) => `'${prefix.replace(/'/g, "''")}'`).join(", ");
  return (["INSERT", "UPDATE", "DELETE"] as const).flatMap((op) => {
    const name = `${table}_row_history_${op.toLowerCase()}`;
    const referencing =
      op === "INSERT"
        ? "REFERENCING NEW TABLE AS history_new"
        : op === "DELETE"
          ? "REFERENCING OLD TABLE AS history_old"
          : "REFERENCING OLD TABLE AS history_old NEW TABLE AS history_new";
    return [
      `DROP TRIGGER IF EXISTS ${name} ON ${table}`,
      `CREATE TRIGGER ${name} AFTER ${op} ON ${table} ${referencing}
         FOR EACH STATEMENT EXECUTE FUNCTION erp_factory_row_history(${args})`,
    ];
  });
}

async function functionsInstalled(client: PoolClient): Promise<boolean> {
  const result = await client.query<{ ready: boolean }>(
    `SELECT obj_description(to_regprocedure('erp_factory_row_history()'), 'pg_proc') = $1
        AND to_regclass('public.factory_row_history_baselines') IS NOT NULL
        AND EXISTS (SELECT 1 FROM pg_class WHERE oid=to_regclass('public.factory_row_history')
                     AND relrowsecurity AND relforcerowsecurity)
        AND (SELECT count(*) FROM pg_policies
               WHERE schemaname='public' AND tablename='factory_row_history'
                 AND policyname IN ('factory_row_history_tenant_read','factory_row_history_tenant_insert'))=2
        AND (SELECT count(*) FROM pg_trigger
              WHERE tgrelid = to_regclass('public.factory_row_history') AND NOT tgisinternal
                AND tgname IN ('factory_row_history_append_only', 'factory_row_history_no_truncate')) = 2 AS ready`,
    [FACTORY_ROW_HISTORY_VERSION]
  );
  return result.rows[0]?.ready === true;
}

/** Tracked tables that exist but are not installed at this version. */
async function tablesToInstall(client: PoolClient): Promise<Array<readonly [string, readonly string[]]>> {
  const result = await client.query<{ table_name: string; ready: boolean; present: boolean }>(
    `SELECT t.table_name,
            to_regclass('public.' || t.table_name) IS NOT NULL AS present,
            EXISTS (SELECT 1 FROM factory_row_history_baselines b
                     WHERE b.table_name = t.table_name AND b.version = $2)
              AND (SELECT count(*) FROM pg_trigger tg
                    WHERE tg.tgrelid = to_regclass('public.' || t.table_name) AND NOT tg.tgisinternal
                      AND tg.tgenabled = 'O'
                      AND tg.tgname IN (t.table_name || '_row_history_insert', t.table_name || '_row_history_update',
                                        t.table_name || '_row_history_delete')) = 3 AS ready
       FROM unnest($1::text[]) AS t(table_name)`,
    [FACTORY_ROW_HISTORY_TABLES.map(([table]) => table), FACTORY_ROW_HISTORY_VERSION]
  );
  const pending = new Set(result.rows.filter((row) => row.present && !row.ready).map((row) => row.table_name));
  return FACTORY_ROW_HISTORY_TABLES.filter(([table]) => pending.has(table));
}

async function inTransaction(client: PoolClient, work: () => Promise<void>): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
    await client.query("SELECT pg_advisory_xact_lock($1)", [INSTALL_LOCK_KEY]);
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
 * Installs one table: lock it against writes, snapshot its rows (first install
 * only), create its triggers and record the baseline, all in one transaction.
 */
async function installTable(client: PoolClient, table: string, noisePrefixes: readonly string[]): Promise<number> {
  let snapshotRows = 0;
  await inTransaction(client, async () => {
    await client.query(`LOCK TABLE ${table} IN SHARE ROW EXCLUSIVE MODE`);
    // Taken after the lock: no write recorded before this instant is missing from the snapshot,
    // and every later write waits for this commit and is stamped after it.
    const baselineAt = (await client.query<{ at: string }>(`SELECT clock_timestamp()::timestamp::text AS at`)).rows[0]
      .at;
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
    for (const statement of tableTriggerDdl(table, noisePrefixes)) {
      await client.query(statement);
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

export type FactoryRowHistoryInstall = { installed: string[]; skipped: string[]; failed: string[] };

/** Installs whatever is missing; never throws (history must not stop the server). */
export async function ensureFactoryRowHistory(pool: Pick<Pool, "connect">): Promise<FactoryRowHistoryInstall> {
  const outcome: FactoryRowHistoryInstall = { installed: [], skipped: [], failed: [] };
  const client = await pool.connect();
  try {
    if (!(await functionsInstalled(client))) {
      await inTransaction(client, async () => {
        for (const statement of FACTORY_ROW_HISTORY_DDL) await client.query(statement);
        await client.query(`COMMENT ON FUNCTION erp_factory_row_history() IS '${FACTORY_ROW_HISTORY_VERSION}'`);
      });
    }
    const pending = await tablesToInstall(client);
    outcome.skipped = FACTORY_ROW_HISTORY_TABLES.map(([table]) => table).filter(
      (table) => !pending.some(([name]) => name === table)
    );
    for (const [table, noisePrefixes] of pending) {
      try {
        const rows = await installTable(client, table, noisePrefixes);
        outcome.installed.push(table);
        logger.info(`[startup] ✓ Factory row history installed on ${table} (${rows} baseline rows)`);
      } catch (error) {
        outcome.failed.push(table);
        logger.warn(`[startup] Factory row history not installed on ${table}; retried on the next boot`, {
          error: getErrorMessage(error),
        });
      }
    }
    if (pending.length === 0) {
      logger.info(`[startup] ✓ Factory row history already installed (${FACTORY_ROW_HISTORY_VERSION})`);
    }
  } catch (error) {
    logger.error("[startup] ✗ Factory row history could not be installed; the server starts without it", {
      version: FACTORY_ROW_HISTORY_VERSION,
      error: getErrorMessage(error),
    });
  } finally {
    client.release();
  }
  return outcome;
}
