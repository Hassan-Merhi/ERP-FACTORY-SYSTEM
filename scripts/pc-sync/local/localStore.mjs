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
    "SELECT cursor, schema_version, tables, copy_complete, last_sync_at, cloud_user_id FROM pc_local.state WHERE id = 1"
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
