// Full offline mode (Phase A): the SQL that installs the cloud change feed.
//
// DBA / maintenance-window step only. renderChangeFeedInstallSql(rules, keys)
// produces one script for the exact schema it was generated from:
// - pc_sync.table_policy: one row per synced table (from the resolved policy);
// - pc_sync.changes: every committed insert, update or delete of a synced row,
//   with its transaction id, the companies it belongs to and the row itself,
//   secret columns removed before anything is stored;
// - one AFTER ROW trigger per synced table, and a statement trigger for
//   TRUNCATE so a PC knows to reload that table.
// Excluded tables get no trigger. Nothing here grants the application role
// any write access to pc_sync; the trigger function runs as its owner.

const literal = (value) => `'${String(value).replace(/'/g, "''")}'`;

export const PC_SYNC_TRIGGER = "pc_sync_capture";
export const PC_SYNC_TRUNCATE_TRIGGER = "pc_sync_capture_truncate";

const STATIC_SQL = `
CREATE SCHEMA IF NOT EXISTS pc_sync;
REVOKE ALL ON SCHEMA pc_sync FROM PUBLIC;

CREATE TABLE IF NOT EXISTS pc_sync.table_policy (
  table_name text PRIMARY KEY,
  mode text NOT NULL CHECK (mode IN ('company', 'self', 'members', 'derived', 'shared')),
  self_column text,
  members_table text,
  members_column text,
  company_columns text[] NOT NULL DEFAULT '{}',
  parents jsonb NOT NULL DEFAULT '[]'::jsonb,
  redact text[] NOT NULL DEFAULT '{}',
  key_columns text[] NOT NULL
);
REVOKE ALL ON pc_sync.table_policy FROM PUBLIC;

CREATE TABLE IF NOT EXISTS pc_sync.changes (
  seq bigserial PRIMARY KEY,
  txid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  table_name text NOT NULL,
  op char(1) NOT NULL CHECK (op IN ('I', 'U', 'D', 'T')),
  row_key jsonb,
  row_data jsonb,
  company_ids integer[] NOT NULL DEFAULT '{}',
  current_company_ids integer[] NOT NULL DEFAULT '{}',
  shared boolean NOT NULL DEFAULT false,
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS pc_sync_changes_txid_seq_idx ON pc_sync.changes (txid, seq);
CREATE INDEX IF NOT EXISTS pc_sync_changes_company_ids_idx ON pc_sync.changes USING gin (company_ids);
REVOKE ALL ON pc_sync.changes FROM PUBLIC;
REVOKE ALL ON SEQUENCE pc_sync.changes_seq_seq FROM PUBLIC;

-- The companies a row belongs to, following parent links (at most 8 deep).
CREATE OR REPLACE FUNCTION pc_sync.row_companies(p_table text, p_row jsonb, p_depth integer DEFAULT 0)
RETURNS integer[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pc_sync, public
AS $pc_sync$
DECLARE
  rule pc_sync.table_policy%ROWTYPE;
  result integer[] := '{}';
  found_ids integer[];
  column_name text;
  parent jsonb;
  parent_row jsonb;
  link text;
BEGIN
  IF p_row IS NULL OR p_depth > 8 THEN
    RETURN result;
  END IF;
  SELECT * INTO rule FROM pc_sync.table_policy WHERE table_name = p_table;
  IF NOT FOUND THEN
    RETURN result;
  END IF;
  IF rule.mode = 'company' THEN
    IF p_row ? 'company_id' AND jsonb_typeof(p_row->'company_id') = 'number' THEN
      result := ARRAY[(p_row->>'company_id')::integer];
    END IF;
  ELSIF rule.mode = 'self' THEN
    IF jsonb_typeof(p_row->rule.self_column) = 'number' THEN
      result := ARRAY[(p_row->>rule.self_column)::integer];
    END IF;
  ELSIF rule.mode = 'members' THEN
    EXECUTE format('SELECT coalesce(array_agg(DISTINCT company_id), ''{}'') FROM public.%I WHERE %I::text = $1',
                   rule.members_table, rule.members_column)
      INTO found_ids USING p_row->>'id';
    result := found_ids;
  ELSIF rule.mode = 'derived' THEN
    FOREACH column_name IN ARRAY rule.company_columns LOOP
      IF jsonb_typeof(p_row->column_name) = 'number' THEN
        result := result || (p_row->>column_name)::integer;
      END IF;
    END LOOP;
    FOR parent IN SELECT value FROM jsonb_array_elements(rule.parents) LOOP
      link := p_row->>(parent->>'column');
      IF link IS NOT NULL THEN
        EXECUTE format('SELECT to_jsonb(p) FROM public.%I p WHERE p.id::text = $1', parent->>'table')
          INTO parent_row USING link;
        result := result || pc_sync.row_companies(parent->>'table', parent_row, p_depth + 1);
      END IF;
    END LOOP;
  END IF;
  RETURN ARRAY(SELECT DISTINCT unnest(result) ORDER BY 1);
END
$pc_sync$;
REVOKE ALL ON FUNCTION pc_sync.row_companies(text, jsonb, integer) FROM PUBLIC;

CREATE OR REPLACE FUNCTION pc_sync.capture()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pc_sync, public
AS $pc_sync$
DECLARE
  rule pc_sync.table_policy%ROWTYPE;
  new_row jsonb;
  old_row jsonb;
  stored jsonb;
  key jsonb := '{}'::jsonb;
  key_column text;
  companies integer[];
  current_companies integer[] := '{}';
  old_companies integer[] := '{}';
BEGIN
  SELECT * INTO rule FROM pc_sync.table_policy WHERE table_name = TG_TABLE_NAME;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF TG_OP <> 'INSERT' THEN old_row := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN new_row := to_jsonb(NEW); END IF;
  FOREACH key_column IN ARRAY rule.key_columns LOOP
    key := key || jsonb_build_object(key_column, coalesce(new_row, old_row)->key_column);
  END LOOP;
  IF rule.mode = 'shared' THEN
    companies := '{}';
  ELSE
    -- An update that moves a row between companies reaches both: the old
    -- company's PCs learn the row left them (the reader sends them only its key).
    current_companies := pc_sync.row_companies(TG_TABLE_NAME, new_row);
    old_companies := pc_sync.row_companies(TG_TABLE_NAME, old_row);
    companies := ARRAY(SELECT DISTINCT unnest(current_companies || old_companies) ORDER BY 1);
    IF cardinality(companies) = 0 THEN
      RETURN NULL; -- belongs to no company: no PC may hold it.
    END IF;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    stored := new_row - rule.redact;
  END IF;
  INSERT INTO pc_sync.changes (table_name, op, row_key, row_data, company_ids, current_company_ids, shared)
  VALUES (TG_TABLE_NAME, left(TG_OP, 1), key, stored, companies, current_companies, rule.mode = 'shared');
  -- A row that moved to other companies takes the rows that find their company
  -- through it along (a voucher's lines through the voucher). Those rows did not
  -- change, so tell every PC to copy each such table again (once per table and
  -- transaction). Company moves are rare administrative operations.
  IF TG_OP = 'UPDATE' AND rule.mode <> 'shared' AND current_companies IS DISTINCT FROM old_companies THEN
    WITH RECURSIVE descendant(tbl) AS (
      SELECT p.table_name FROM pc_sync.table_policy p, jsonb_array_elements(p.parents) AS e
       WHERE e->>'table' = TG_TABLE_NAME
      UNION
      SELECT p.table_name FROM descendant d, pc_sync.table_policy p, jsonb_array_elements(p.parents) AS e
       WHERE e->>'table' = d.tbl
    )
    INSERT INTO pc_sync.changes (table_name, op, shared)
    SELECT d.tbl, 'T', true FROM descendant d
     WHERE NOT EXISTS (
       SELECT 1 FROM pc_sync.changes c
        WHERE c.txid = pg_current_xact_id() AND c.table_name = d.tbl AND c.op = 'T');
  END IF;
  RETURN NULL;
END
$pc_sync$;
REVOKE ALL ON FUNCTION pc_sync.capture() FROM PUBLIC;

CREATE OR REPLACE FUNCTION pc_sync.capture_truncate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pc_sync, public
AS $pc_sync$
BEGIN
  -- Every PC must reload this table from a fresh snapshot.
  INSERT INTO pc_sync.changes (table_name, op, shared) VALUES (TG_TABLE_NAME, 'T', true);
  RETURN NULL;
END
$pc_sync$;
REVOKE ALL ON FUNCTION pc_sync.capture_truncate() FROM PUBLIC;

-- Every transaction below this id has finished (committed or rolled back).
CREATE OR REPLACE FUNCTION pc_sync.watermark()
RETURNS text
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pc_sync
AS $pc_sync$ SELECT pg_snapshot_xmin(pg_current_snapshot())::text $pc_sync$;
REVOKE ALL ON FUNCTION pc_sync.watermark() FROM PUBLIC;

-- One page of changes for the given companies, from transactions in
-- [p_from, p_to), after (p_after_txid, p_after_seq), in transaction order.
-- A row that now belongs to none of the companies comes back as op 'D' with
-- its key only: its data belongs to another company.
CREATE OR REPLACE FUNCTION pc_sync.read_changes(
  p_from text, p_to text, p_after_txid text, p_after_seq bigint, p_companies integer[], p_limit integer)
RETURNS TABLE (seq bigint, txid text, table_name text, op char(1), row_key jsonb, row_data jsonb)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pc_sync
AS $pc_sync$
  SELECT c.seq, c.txid::text, c.table_name,
         CASE WHEN c.shared OR c.op IN ('D', 'T') OR c.current_company_ids && p_companies THEN c.op ELSE 'D' END,
         c.row_key,
         CASE WHEN c.shared OR c.current_company_ids && p_companies THEN c.row_data END
    FROM pc_sync.changes c
   WHERE c.txid >= p_from::xid8 AND c.txid < p_to::xid8
     AND (c.txid, c.seq) > (p_after_txid::xid8, p_after_seq)
     AND (c.shared OR c.company_ids && p_companies)
   ORDER BY c.txid, c.seq
   -- 1001: the reader asks for one row more than its largest page (1000) to
   -- know whether the window has more; capping at 1000 would end it early.
   LIMIT least(greatest(p_limit, 1), 1001)
$pc_sync$;
REVOKE ALL ON FUNCTION pc_sync.read_changes(text, text, text, bigint, integer[], integer) FROM PUBLIC;

-- Initial full copy (Phase A2). The cloud's schema version, so a PC with a
-- different schema refuses to load.
CREATE OR REPLACE FUNCTION pc_sync.schema_version()
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $pc_sync$
DECLARE
  version text;
BEGIN
  IF to_regclass('public.schema_migrations') IS NULL THEN
    RETURN NULL;
  END IF;
  EXECUTE 'SELECT max(id) FROM public.schema_migrations' INTO version;
  RETURN version;
END
$pc_sync$;
REVOKE ALL ON FUNCTION pc_sync.schema_version() FROM PUBLIC;

-- Every synced table, in name order.
CREATE OR REPLACE FUNCTION pc_sync.snapshot_tables()
RETURNS SETOF text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pc_sync
AS $pc_sync$ SELECT table_name FROM pc_sync.table_policy ORDER BY table_name $pc_sync$;
REVOKE ALL ON FUNCTION pc_sync.snapshot_tables() FROM PUBLIC;

-- One page of a synced table for the given companies, in key order, after the
-- key p_after (NULL = from the start), secret columns removed.
CREATE OR REPLACE FUNCTION pc_sync.snapshot_page(p_table text, p_companies integer[], p_after jsonb, p_limit integer)
RETURNS TABLE (row_key jsonb, row_data jsonb)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pc_sync, public
AS $pc_sync$
DECLARE
  rule pc_sync.table_policy%ROWTYPE;
  key_list text;
  after_list text;
  key_object text;
  filter text;
  after_clause text := '';
BEGIN
  SELECT * INTO rule FROM pc_sync.table_policy WHERE table_name = p_table;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PC_SYNC_TABLE_NOT_SYNCED' USING ERRCODE = '22023';
  END IF;
  SELECT string_agg(format('t.%I', k), ', '), string_agg(format('x.%I', k), ', '),
         string_agg(format('%L, t.%I', k, k), ', ')
    INTO key_list, after_list, key_object
    FROM unnest(rule.key_columns) AS k;
  filter := CASE rule.mode
    WHEN 'company' THEN 't.company_id = ANY($1)'
    WHEN 'self' THEN format('t.%I = ANY($1)', rule.self_column)
    WHEN 'members' THEN format(
      'EXISTS (SELECT 1 FROM public.%I m WHERE m.%I::text = t.id::text AND m.company_id = ANY($1))',
      rule.members_table, rule.members_column)
    WHEN 'derived' THEN format('pc_sync.row_companies(%L, to_jsonb(t)) && $1', p_table)
    WHEN 'shared' THEN 'true'
  END;
  IF filter IS NULL THEN
    RAISE EXCEPTION 'PC_SYNC_TABLE_NOT_SYNCED' USING ERRCODE = '22023';
  END IF;
  IF p_after IS NOT NULL THEN
    after_clause := format(' AND (%s) > (SELECT %s FROM jsonb_populate_record(NULL::public.%I, $2) x)',
                           key_list, after_list, p_table);
  END IF;
  RETURN QUERY EXECUTE format(
    'SELECT jsonb_build_object(%s), to_jsonb(t) - $3 FROM public.%I t WHERE %s%s ORDER BY %s LIMIT $4',
    key_object, p_table, filter, after_clause, key_list)
  USING p_companies, p_after, rule.redact, least(greatest(p_limit, 1), 1000);
END
$pc_sync$;
REVOKE ALL ON FUNCTION pc_sync.snapshot_page(text, integer[], jsonb, integer) FROM PUBLIC;
`;

/**
 * @param {Map<string, object>} rules resolved policy (resolvePcSyncPolicy().rules)
 * @param {Map<string, string[]>} keys table -> primary key columns
 * @param {{ grantTo?: string }} options grantTo: the application role allowed to read pages
 */
export function renderChangeFeedInstallSql(rules, keys, { grantTo } = {}) {
  const policyRows = [...rules]
    .filter(([, rule]) => rule.mode !== "excluded")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([table, rule]) => {
      const key = keys.get(table);
      if (!key?.length) throw new Error(`${table} has no primary key; the change feed needs one to identify rows.`);
      return {
        table_name: table,
        mode: rule.mode,
        self_column: rule.mode === "self" ? rule.column : null,
        members_table: rule.mode === "members" ? rule.table : null,
        members_column: rule.mode === "members" ? rule.column : null,
        company_columns: rule.companyColumns ?? [],
        parents: rule.parents ?? [],
        redact: rule.redact ?? [],
        key_columns: key,
      };
    });
  if (grantTo !== undefined && !/^[a-z_][a-z0-9_]*$/.test(grantTo)) {
    throw new Error(`Unsafe application role name: ${grantTo}`);
  }
  const lines = [
    "-- Full offline mode (Phase A): cloud change feed.",
    "-- DBA / maintenance-window installation ONLY, generated for one exact schema by",
    "-- scripts/pc-sync/render-change-feed-sql.mjs. Re-generate and re-run after EVERY schema change.",
    "-- Never run casually on a live database; review the generated file first.",
    "BEGIN;",
    STATIC_SQL.trim(),
    "",
    "-- One row per synced table, from config/pc-sync-table-policy.json resolved against this schema.",
    "TRUNCATE pc_sync.table_policy;",
    `INSERT INTO pc_sync.table_policy SELECT * FROM jsonb_populate_recordset(NULL::pc_sync.table_policy, ${literal(
      JSON.stringify(policyRows)
    )}::jsonb);`,
    "",
    "-- A capture trigger on every synced table, and on no other.",
    `DO $pc_sync$
DECLARE
  relation record;
BEGIN
  FOR relation IN
    SELECT c.relname AS tbl
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS ${PC_SYNC_TRIGGER} ON public.%I', relation.tbl);
    EXECUTE format('DROP TRIGGER IF EXISTS ${PC_SYNC_TRUNCATE_TRIGGER} ON public.%I', relation.tbl);
  END LOOP;
  FOR relation IN SELECT table_name AS tbl FROM pc_sync.table_policy LOOP
    EXECUTE format(
      'CREATE TRIGGER ${PC_SYNC_TRIGGER} AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION pc_sync.capture()',
      relation.tbl);
    EXECUTE format(
      'CREATE TRIGGER ${PC_SYNC_TRUNCATE_TRIGGER} AFTER TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION pc_sync.capture_truncate()',
      relation.tbl);
  END LOOP;
END
$pc_sync$;`,
  ];
  if (grantTo) {
    // The application role may only read through these functions.
    lines.push(
      "",
      `DO $pc_sync$
DECLARE
  app_role text := ${literal(grantTo)};
BEGIN
  EXECUTE format('GRANT USAGE ON SCHEMA pc_sync TO %I', app_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION pc_sync.watermark() TO %I', app_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION pc_sync.read_changes(text, text, text, bigint, integer[], integer) TO %I', app_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION pc_sync.schema_version() TO %I', app_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION pc_sync.snapshot_tables() TO %I', app_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION pc_sync.snapshot_page(text, integer[], jsonb, integer) TO %I', app_role);
END
$pc_sync$;`
    );
  }
  lines.push("COMMIT;", "");
  return lines.join("\n");
}

/**
 * The columns that identify a row of every public table: its primary key, or,
 * for a table without one, its first full (non-partial, non-expression)
 * unique index.
 */
export async function readPrimaryKeys(client) {
  const { rows } = await client.query(
    `SELECT c.relname AS table_name, ic.relname AS index_name, i.indisprimary AS is_primary,
            a.attname AS column_name
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indrelid
       JOIN pg_class ic ON ic.oid = i.indexrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, position) ON true
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
      WHERE n.nspname = 'public' AND i.indisunique AND i.indpred IS NULL AND i.indexprs IS NULL
      ORDER BY c.relname, i.indisprimary DESC, ic.relname, k.position`
  );
  const keys = new Map();
  const chosen = new Map();
  for (const row of rows) {
    if (!chosen.has(row.table_name)) chosen.set(row.table_name, row.index_name);
    if (chosen.get(row.table_name) !== row.index_name) continue;
    if (!keys.has(row.table_name)) keys.set(row.table_name, []);
    keys.get(row.table_name).push(row.column_name);
  }
  return keys;
}
