// Full offline mode (Phase A3): the PC's own database.
//
// The PC runs the same schema as the cloud (built with `node scripts/db/migrate.mjs apply`
// against the PC's local PostgreSQL). This module adds the PC-only bookkeeping
// schema `pc_local` and applies rows from the cloud's full copy and change feed.
//
// It runs ONLY against the PC's own local database, never against the cloud:
// it switches off foreign-key triggers while applying (rows of other companies
// that a row points to are not on the PC) and lets secret columns be empty.

const STATIC_SQL = String.raw`
CREATE SCHEMA IF NOT EXISTS pc_local;

CREATE TABLE IF NOT EXISTS pc_local.state (
  id integer PRIMARY KEY CHECK (id = 1),
  cursor text,
  schema_version text,
  tables text[] NOT NULL DEFAULT '{}',
  copy_complete boolean NOT NULL DEFAULT false,
  last_sync_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO pc_local.state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
-- The cloud account whose companies this copy holds.
ALTER TABLE pc_local.state ADD COLUMN IF NOT EXISTS cloud_user_id text;

CREATE TABLE IF NOT EXISTS pc_local.copy_progress (
  table_name text PRIMARY KEY,
  after text,
  done boolean NOT NULL DEFAULT false
);

-- Last feed seq applied to each row (apply only a higher seq; copied rows count as 0).
CREATE TABLE IF NOT EXISTS pc_local.applied (
  table_name text NOT NULL,
  row_key jsonb NOT NULL,
  seq bigint NOT NULL,
  PRIMARY KEY (table_name, row_key)
);

-- Password hashes of the people who signed in on this PC while online; the
-- cloud never sends passwords, so these are the only ones that work offline.
CREATE TABLE IF NOT EXISTS pc_local.local_logins (
  user_id text PRIMARY KEY,
  password_hash text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Phase B: entries made on this PC while offline.
ALTER TABLE pc_local.state ADD COLUMN IF NOT EXISTS device_id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE pc_local.state ADD COLUMN IF NOT EXISTS cloud_user_id text;

CREATE TABLE IF NOT EXISTS pc_local.outbox (
  id bigserial PRIMARY KEY,
  operation_id uuid NOT NULL UNIQUE,
  kind text NOT NULL,
  input jsonb NOT NULL,
  local_ref integer,
  captured_at timestamptz NOT NULL DEFAULT now(),
  user_id text NOT NULL,
  company_id integer NOT NULL,
  -- unconfirmed: the local save may or may not have committed (the server
  -- stopped mid-request); someone at the PC sends or discards it.
  status text NOT NULL CHECK (status IN ('capturing', 'unconfirmed', 'pending', 'waiting', 'applied', 'conflict', 'refused')),
  code text,
  overridable boolean NOT NULL DEFAULT false,
  receipt jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- A finished envelope (edits and deletes): built by the live route in the same
-- transaction as the change, delivered as is.
ALTER TABLE pc_local.outbox ADD COLUMN IF NOT EXISTS envelope jsonb;

-- Local refs for operations that do not name a created row (never a cloud id).
CREATE SEQUENCE IF NOT EXISTS pc_local.local_ref_seq START 1900000000 MINVALUE 1900000000 MAXVALUE 2147483647;

-- Every write the local ERP server makes (never the agent's: it applies with
-- session_replication_role = replica, which skips these triggers), so the PC
-- can return to the cloud's version once its entries are delivered.
CREATE TABLE IF NOT EXISTS pc_local.local_writes (
  id bigserial PRIMARY KEY,
  table_name text NOT NULL,
  row_key jsonb NOT NULL,
  op char(1) NOT NULL CHECK (op IN ('I', 'U', 'D')),
  old_row jsonb
);

CREATE TABLE IF NOT EXISTS pc_local.table_keys (
  table_name text PRIMARY KEY,
  key_columns text[] NOT NULL
);

CREATE OR REPLACE FUNCTION pc_local.capture_local_write()
RETURNS trigger
LANGUAGE plpgsql
AS $pc_local$
DECLARE
  cols text[];
  source jsonb;
BEGIN
  SELECT key_columns INTO cols FROM pc_local.table_keys WHERE table_name = TG_TABLE_NAME;
  source := CASE WHEN TG_OP = 'INSERT' THEN to_jsonb(NEW) ELSE to_jsonb(OLD) END;
  INSERT INTO pc_local.local_writes (table_name, row_key, op, old_row)
  SELECT TG_TABLE_NAME,
         (SELECT jsonb_object_agg(c, source -> c) FROM unnest(cols) AS c),
         left(TG_OP, 1),
         CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE source END;
  RETURN NULL;
END
$pc_local$;

CREATE OR REPLACE FUNCTION pc_local.install_write_capture(p_tables text[])
RETURNS void
LANGUAGE plpgsql
AS $pc_local$
DECLARE
  item record;
BEGIN
  FOR item IN
    SELECT c.relname AS tbl, array_agg(a.attname::text ORDER BY array_position(i.indkey::int2[], a.attnum)) AS cols
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
      JOIN pg_index i ON i.indrelid = c.oid AND i.indisprimary
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY (i.indkey)
     WHERE c.relname = ANY (p_tables)
     GROUP BY c.relname
  LOOP
    INSERT INTO pc_local.table_keys (table_name, key_columns) VALUES (item.tbl, item.cols)
    ON CONFLICT (table_name) DO UPDATE SET key_columns = EXCLUDED.key_columns;
    EXECUTE format('DROP TRIGGER IF EXISTS pc_local_capture ON public.%I', item.tbl);
    EXECUTE format(
      'CREATE TRIGGER pc_local_capture AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION pc_local.capture_local_write()',
      item.tbl);
  END LOOP;
END
$pc_local$;

-- Rows the PC creates itself get ids from 1,000,000,000 up (the offline range
-- the cloud translates), so they never collide with a cloud row.
CREATE OR REPLACE FUNCTION pc_local.use_local_id_range()
RETURNS void
LANGUAGE plpgsql
AS $pc_local$
DECLARE
  item record;
BEGIN
  FOR item IN
    SELECT s.schemaname, s.sequencename
      FROM pg_sequences s
     WHERE s.schemaname = 'public' AND s.max_value >= 1500000000
       AND COALESCE(s.last_value, 0) < 1000000000
  LOOP
    PERFORM setval(format('%I.%I', item.schemaname, item.sequencename)::regclass, 1000000000, false);
  END LOOP;
END
$pc_local$;

-- Put back the cloud's version of every row the local server changed.
CREATE OR REPLACE FUNCTION pc_local.revert_local_writes()
RETURNS integer
LANGUAGE plpgsql
AS $pc_local$
DECLARE
  item record;
  n integer := 0;
BEGIN
  FOR item IN SELECT * FROM pc_local.local_writes ORDER BY id DESC LOOP
    IF item.op = 'I' THEN
      PERFORM pc_local.delete_row(item.table_name, item.row_key);
    ELSE
      PERFORM pc_local.apply_row(item.table_name, item.row_key, item.old_row);
    END IF;
    n := n + 1;
  END LOOP;
  DELETE FROM pc_local.local_writes;
  RETURN n;
END
$pc_local$;

CREATE OR REPLACE FUNCTION pc_local.apply_row(p_table text, p_key jsonb, p_row jsonb)
RETURNS void
LANGUAGE plpgsql
AS $pc_local$
DECLARE
  rel regclass := to_regclass(format('public.%I', p_table));
  cols text;
  sets text;
  keys text;
BEGIN
  IF rel IS NULL THEN
    RAISE EXCEPTION 'PC_LOCAL_TABLE_MISSING' USING ERRCODE = '22023', DETAIL = p_table;
  END IF;
  -- Only the columns the cloud sent: a removed secret column keeps its local value.
  SELECT string_agg(format('%I', a.attname), ', ' ORDER BY a.attnum),
         string_agg(format('%I = EXCLUDED.%I', a.attname, a.attname), ', ' ORDER BY a.attnum)
    INTO cols, sets
    FROM pg_attribute a
   WHERE a.attrelid = rel AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''
     AND p_row ? a.attname::text;
  SELECT string_agg(format('%I', k), ', ') INTO keys FROM jsonb_object_keys(p_key) AS k;
  IF cols IS NULL OR keys IS NULL THEN
    RAISE EXCEPTION 'PC_LOCAL_ROW_INVALID' USING ERRCODE = '22023', DETAIL = p_table;
  END IF;
  EXECUTE format(
    'INSERT INTO public.%I (%s) OVERRIDING SYSTEM VALUE SELECT %s FROM jsonb_populate_record(NULL::public.%I, $1) ON CONFLICT (%s) DO UPDATE SET %s',
    p_table, cols, cols, p_table, keys, sets)
  USING p_row;
END
$pc_local$;

CREATE OR REPLACE FUNCTION pc_local.delete_row(p_table text, p_key jsonb)
RETURNS void
LANGUAGE plpgsql
AS $pc_local$
DECLARE
  rel regclass := to_regclass(format('public.%I', p_table));
  t_list text;
  x_list text;
BEGIN
  IF rel IS NULL THEN
    RAISE EXCEPTION 'PC_LOCAL_TABLE_MISSING' USING ERRCODE = '22023', DETAIL = p_table;
  END IF;
  SELECT string_agg(format('t.%I', k), ', '), string_agg(format('x.%I', k), ', ')
    INTO t_list, x_list
    FROM jsonb_object_keys(p_key) AS k;
  IF t_list IS NULL THEN
    RAISE EXCEPTION 'PC_LOCAL_ROW_INVALID' USING ERRCODE = '22023', DETAIL = p_table;
  END IF;
  EXECUTE format(
    'DELETE FROM public.%I t WHERE (%s) = (SELECT %s FROM jsonb_populate_record(NULL::public.%I, $1) x)',
    p_table, t_list, x_list, p_table)
  USING p_key;
END
$pc_local$;

CREATE OR REPLACE FUNCTION pc_local.clear_table(p_table text)
RETURNS void
LANGUAGE plpgsql
AS $pc_local$
BEGIN
  IF to_regclass(format('public.%I', p_table)) IS NULL THEN
    RAISE EXCEPTION 'PC_LOCAL_TABLE_MISSING' USING ERRCODE = '22023', DETAIL = p_table;
  END IF;
  EXECUTE format('DELETE FROM public.%I', p_table);
  DELETE FROM pc_local.applied WHERE table_name = p_table;
END
$pc_local$;

-- The cloud never sends a removed secret column, so it may be empty here.
CREATE OR REPLACE FUNCTION pc_local.allow_empty_secrets(p_redact jsonb)
RETURNS void
LANGUAGE plpgsql
AS $pc_local$
DECLARE
  item record;
BEGIN
  FOR item IN
    SELECT r.key AS tbl, c.value AS col
      FROM jsonb_each(p_redact) AS r
      CROSS JOIN LATERAL jsonb_array_elements_text(r.value) AS c(value)
      JOIN information_schema.columns ic
        ON ic.table_schema = 'public' AND ic.table_name = r.key AND ic.column_name = c.value
     WHERE ic.is_nullable = 'NO'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN %I DROP NOT NULL', item.tbl, item.col);
  END LOOP;
END
$pc_local$;
`;

/**
 * Creates the PC-only bookkeeping schema. Run on the PC's local database only.
 * @param {{ query: Function }} client
 * @param {Record<string, string[]>} redact table -> secret columns the cloud never sends
 */
export async function prepareLocalDatabase(client, redact) {
  await client.query(STATIC_SQL);
  await client.query("SELECT pc_local.allow_empty_secrets($1::jsonb)", [JSON.stringify(redact ?? {})]);
  await client.query("SELECT pc_local.use_local_id_range()");
  // A copy made before entries existed has no write capture yet: install it
  // for the synced tables on every start (idempotent).
  const { rows } = await client.query("SELECT tables FROM pc_local.state WHERE id = 1");
  if (rows[0]?.tables?.length) await installLocalWriteCapture(client, rows[0].tables);
}

/**
 * One lock shared by every entry the local server records and taken alone by
 * the sync process while it checks for outstanding entries, undoes local
 * writes and pulls: an entry can never start in the middle of that.
 */
export const PC_LOCAL_ENTRY_LOCK = 7314002;

/** Records every write the local ERP server makes to these tables (Phase B). */
export async function installLocalWriteCapture(client, tables) {
  await client.query("SELECT pc_local.install_write_capture($1::text[])", [tables]);
}

/**
 * Puts back the cloud's version of every row the local server changed. Call
 * inside inApplyTransaction once the PC's entries are delivered; returns how
 * many writes were undone.
 */
export async function revertLocalWrites(client) {
  const { rows } = await client.query("SELECT pc_local.revert_local_writes() AS n");
  return Number(rows[0].n);
}

export async function countLocalWrites(client) {
  const { rows } = await client.query("SELECT count(*)::int AS n FROM pc_local.local_writes");
  return rows[0].n;
}

/** The schema version of the PC's database, compared with the cloud's before loading. */
export async function localSchemaVersion(client) {
  const { rows } = await client.query(
    "SELECT CASE WHEN to_regclass('public.schema_migrations') IS NULL THEN NULL ELSE (SELECT max(id)::text FROM public.schema_migrations) END AS version"
  );
  return rows[0]?.version ?? null;
}

export async function readLocalState(client) {
  const { rows } = await client.query(
    "SELECT cursor, schema_version, tables, copy_complete, last_sync_at, device_id, cloud_user_id FROM pc_local.state WHERE id = 1"
  );
  return rows[0];
}

/**
 * Runs `work` in one transaction with foreign-key triggers switched off, so
 * rows can arrive in any order and may point to rows of other companies.
 */
export async function inApplyTransaction(client, work) {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL session_replication_role = replica");
    const result = await work();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

/** A row from the full copy (seq 0). */
export async function applyCopiedRow(client, table, key, row) {
  await client.query("SELECT pc_local.apply_row($1, $2::jsonb, $3::jsonb)", [
    table,
    JSON.stringify(key),
    JSON.stringify(row),
  ]);
}

/**
 * A change from the feed. Applied only when its seq is higher than the last one
 * applied to that row. Returns false when it was older and skipped.
 */
export async function applyFeedChange(client, change) {
  const key = JSON.stringify(change.key);
  const { rows } = await client.query(
    "SELECT seq FROM pc_local.applied WHERE table_name = $1 AND row_key = $2::jsonb",
    [change.table, key]
  );
  if (rows[0] && Number(rows[0].seq) >= change.seq) return false;
  if (change.op === "D") {
    await client.query("SELECT pc_local.delete_row($1, $2::jsonb)", [change.table, key]);
  } else {
    await client.query("SELECT pc_local.apply_row($1, $2::jsonb, $3::jsonb)", [
      change.table,
      key,
      JSON.stringify(change.row),
    ]);
  }
  await client.query(
    `INSERT INTO pc_local.applied (table_name, row_key, seq) VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (table_name, row_key) DO UPDATE SET seq = EXCLUDED.seq`,
    [change.table, key, change.seq]
  );
  return true;
}

/**
 * Puts back the local password hashes the cloud does not send. Anyone who never
 * signed in on this PC gets "!", which no password matches.
 */
export async function restoreLocalLogins(client) {
  await client.query(
    `UPDATE public.users u SET password = COALESCE(l.password_hash, '!')
       FROM public.users v LEFT JOIN pc_local.local_logins l ON l.user_id = v.id::text
      WHERE u.id = v.id AND u.password IS DISTINCT FROM COALESCE(l.password_hash, '!')`
  );
}
