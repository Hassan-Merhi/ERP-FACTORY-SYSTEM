/**
 * Read-only PostgreSQL catalog snapshot.
 *
 * Serialises every application schema object into one line per object:
 *
 *     kind <TAB> identity <TAB> JSON definition
 *
 * Two databases with the same set of lines have the same schema, object for
 * object. The JSON definition carries everything needed to recreate the object
 * (scripts/db/lib/schemaDdl.mjs compiles DDL from it), so a committed manifest is
 * both the expected-schema contract and the source for safe adoption DDL.
 *
 * Used by:
 *   - scripts/db/migrate.mjs  (manifest, verify and adopt modes);
 *   - server/schema/verifyDatabaseSchema.ts  (read-only startup verification);
 *   - the migration test suite (fresh install == committed manifest).
 *
 * Every query here is a plain catalog SELECT. Nothing is created, altered or
 * locked beyond AccessShare on catalog tables. Table contents are never read.
 */

/** Schemas that are never part of the application schema. */
const SYSTEM_SCHEMA_FILTER = `n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
  AND n.nspname NOT LIKE 'pg_temp_%' AND n.nspname NOT LIKE 'pg_toast_temp_%'`;

/** Objects owned by an extension are recreated by CREATE EXTENSION, not by migrations. */
const notExtensionMember = (classId, oidExpr) =>
  `NOT EXISTS (SELECT 1 FROM pg_depend dep WHERE dep.classid = '${classId}'::regclass
     AND dep.objid = ${oidExpr} AND dep.deptype = 'e')`;

/**
 * Bookkeeping tables owned by the migration runner itself. They are created by
 * the runner, never by a migration, so they are excluded from schema comparison.
 */
export const MIGRATION_HISTORY_TABLE = "schema_migrations";
const RUNNER_TABLES = `('${MIGRATION_HISTORY_TABLE}')`;

/** Object kinds in the order DDL must be applied to an empty database. */
export const KIND_ORDER = [
  "schema",
  "extension",
  "type",
  "function",
  "sequence",
  "table",
  "column",
  "constraint",
  "index",
  "view",
  "trigger",
  "policy",
  "event_trigger",
];

const QUERIES = {
  schema: `
    SELECT quote_ident(n.nspname) AS identity, json_build_object() AS definition
      FROM pg_namespace n WHERE ${SYSTEM_SCHEMA_FILTER} AND n.nspname <> 'public'`,
  extension: `
    SELECT quote_ident(e.extname) AS identity, json_build_object('schema', n.nspname) AS definition
      FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
     WHERE e.extname <> 'plpgsql'`,
  type: `
    SELECT format('%I.%I', n.nspname, t.typname) AS identity,
           CASE t.typtype
             WHEN 'e' THEN json_build_object('kind', 'enum', 'labels',
               (SELECT json_agg(enumlabel ORDER BY enumsortorder) FROM pg_enum WHERE enumtypid = t.oid))
             ELSE json_build_object('kind', 'domain', 'base', format_type(t.typbasetype, t.typtypmod),
               'notNull', t.typnotnull, 'default', t.typdefault,
               'checks', (SELECT json_agg(pg_get_constraintdef(c.oid) ORDER BY c.conname)
                            FROM pg_constraint c WHERE c.contypid = t.oid))
           END AS definition
      FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE ${SYSTEM_SCHEMA_FILTER} AND t.typtype IN ('e','d')
       AND ${notExtensionMember("pg_type", "t.oid")}`,
  sequence: `
    SELECT format('%I.%I', n.nspname, c.relname) AS identity,
           json_build_object('type', format_type(s.seqtypid, NULL), 'start', s.seqstart::text,
             'increment', s.seqincrement::text, 'min', s.seqmin::text, 'max', s.seqmax::text,
             'cache', s.seqcache::text, 'cycle', s.seqcycle,
             'ownedBy', (SELECT format('%I.%I.%I', tn.nspname, tc.relname, a.attname)
                           FROM pg_depend d JOIN pg_class tc ON tc.oid = d.refobjid
                           JOIN pg_namespace tn ON tn.oid = tc.relnamespace
                           JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
                          WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid
                            AND d.deptype = 'a' AND d.refclassid = 'pg_class'::regclass
                          LIMIT 1)) AS definition
      FROM pg_sequence s JOIN pg_class c ON c.oid = s.seqrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE ${SYSTEM_SCHEMA_FILTER} AND ${notExtensionMember("pg_class", "c.oid")}
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass
                        AND d.objid = c.oid AND d.deptype = 'i')`,
  table: `
    SELECT format('%I.%I', n.nspname, c.relname) AS identity,
           json_build_object('kind', c.relkind, 'unlogged', c.relpersistence = 'u',
             'rls', c.relrowsecurity, 'forceRls', c.relforcerowsecurity,
             'partitionKey', pg_get_partkeydef(c.oid),
             'comment', obj_description(c.oid, 'pg_class')) AS definition
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE ${SYSTEM_SCHEMA_FILTER} AND c.relkind IN ('r','p')
       AND c.relname NOT IN ${RUNNER_TABLES}
       AND ${notExtensionMember("pg_class", "c.oid")}`,
  column: `
    SELECT format('%I.%I.%I', n.nspname, c.relname, a.attname) AS identity,
           json_build_object('type', format_type(a.atttypid, a.atttypmod), 'notNull', a.attnotnull,
             'default', CASE WHEN a.attgenerated = '' THEN pg_get_expr(d.adbin, d.adrelid) END,
             'identity', nullif(a.attidentity::text, ''),
             'generated', CASE WHEN a.attgenerated <> '' THEN pg_get_expr(d.adbin, d.adrelid) END,
             'collation', CASE WHEN a.attcollation <> 0 AND a.attcollation <> t.typcollation
                               THEN (SELECT quote_ident(collname) FROM pg_collation WHERE oid = a.attcollation)
                          END,
             'comment', col_description(c.oid, a.attnum)) AS definition
      FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_type t ON t.oid = a.atttypid
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE ${SYSTEM_SCHEMA_FILTER} AND c.relkind IN ('r','p')
       AND a.attnum > 0 AND NOT a.attisdropped
       AND c.relname NOT IN ${RUNNER_TABLES}
       AND ${notExtensionMember("pg_class", "c.oid")}`,
  constraint: `
    SELECT format('%I.%I.%I', n.nspname, c.relname, con.conname) AS identity,
           json_build_object('type', con.contype, 'def', pg_get_constraintdef(con.oid, true),
             'validated', con.convalidated) AS definition
      FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE ${SYSTEM_SCHEMA_FILTER} AND con.contype IN ('p','u','f','c','x')
       AND c.relname NOT IN ${RUNNER_TABLES}
       AND ${notExtensionMember("pg_class", "c.oid")}`,
  index: `
    SELECT format('%I.%I', n.nspname, i.relname) AS identity,
           json_build_object('table', format('%I.%I', tn.nspname, c.relname),
             'def', pg_get_indexdef(i.oid), 'valid', ix.indisvalid,
             'constraint', EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.oid
                                     AND k.contype IN ('p','u','x'))) AS definition
      FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid
      JOIN pg_class c ON c.oid = ix.indrelid
      JOIN pg_namespace n ON n.oid = i.relnamespace
      JOIN pg_namespace tn ON tn.oid = c.relnamespace
     WHERE ${SYSTEM_SCHEMA_FILTER}
       AND c.relname NOT IN ${RUNNER_TABLES}
       AND ${notExtensionMember("pg_class", "c.oid")}`,
  view: `
    SELECT format('%I.%I', n.nspname, c.relname) AS identity,
           json_build_object('materialized', c.relkind = 'm', 'def', pg_get_viewdef(c.oid, true)) AS definition
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE ${SYSTEM_SCHEMA_FILTER} AND c.relkind IN ('v','m')
       AND ${notExtensionMember("pg_class", "c.oid")}`,
  function: `
    SELECT format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)) AS identity,
           json_build_object('kind', p.prokind,
             'def', CASE WHEN p.prokind IN ('f','p') THEN pg_get_functiondef(p.oid) END,
             -- Role-independent privilege fact: can PUBLIC execute it? Matters for
             -- SECURITY DEFINER functions that must only be callable by a granted role.
             'publicExecute', p.proacl IS NULL OR EXISTS (
               SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'),
             -- Guard installers' version markers live in function comments and are
             -- read at runtime (installed*Version readers, integrity diagnostic).
             'comment', obj_description(p.oid, 'pg_proc')
           ) AS definition
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE ${SYSTEM_SCHEMA_FILTER} AND ${notExtensionMember("pg_proc", "p.oid")}`,
  trigger: `
    SELECT format('%I.%I.%I', n.nspname, c.relname, t.tgname) AS identity,
           json_build_object('table', format('%I.%I', n.nspname, c.relname),
             'def', pg_get_triggerdef(t.oid, false), 'enabled', t.tgenabled) AS definition
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE ${SYSTEM_SCHEMA_FILTER} AND NOT t.tgisinternal`,
  policy: `
    SELECT format('%I.%I.%I', n.nspname, c.relname, pol.polname) AS identity,
           json_build_object('table', format('%I.%I', n.nspname, c.relname),
             'name', pol.polname, 'cmd', pol.polcmd, 'permissive', pol.polpermissive,
             'roles', (SELECT json_agg(CASE WHEN r = 0 THEN 'public' ELSE quote_ident(r::regrole::text) END
                                       ORDER BY 1) FROM unnest(pol.polroles) r),
             'using', pg_get_expr(pol.polqual, pol.polrelid),
             'check', pg_get_expr(pol.polwithcheck, pol.polrelid)) AS definition
      FROM pg_policy pol JOIN pg_class c ON c.oid = pol.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE ${SYSTEM_SCHEMA_FILTER}`,
  event_trigger: `
    SELECT quote_ident(e.evtname) AS identity,
           json_build_object('event', e.evtevent, 'function', e.evtfoid::regproc::text,
             'tags', e.evttags, 'enabled', e.evtenabled) AS definition
      FROM pg_event_trigger e`,
};

/**
 * Take a catalog snapshot. Pass a dedicated client (pg.Client or a checked-out
 * pool client): the snapshot runs in its own read-only transaction.
 * @param {{ query: (sql: string) => Promise<{ rows: Array<Record<string, unknown>> }> }} client
 * @returns {Promise<string[]>} sorted `kind\tidentity\tjson` lines
 */
export async function takeCatalogSnapshot(client, { inTransaction = false } = {}) {
  const lines = [];
  // pg_get_*def() output depends on search_path (it omits schema names that are
  // visible). Pin it so every snapshot renders identically. When the caller
  // already holds a transaction (adoption verifies its own uncommitted DDL),
  // reuse it; otherwise open a read-only one and roll it back.
  if (!inTransaction) await client.query("BEGIN READ ONLY");
  try {
    await client.query("SET LOCAL search_path = public");
    for (const kind of KIND_ORDER) {
      const { rows } = await client.query(QUERIES[kind]);
      for (const row of rows) lines.push(`${kind}\t${row.identity}\t${JSON.stringify(row.definition)}`);
    }
  } finally {
    if (!inTransaction) await client.query("ROLLBACK").catch(() => {});
  }
  return lines.sort();
}

/**
 * Parse snapshot lines into entries.
 * @param {string[]} lines
 * @returns {Array<{ kind: string, identity: string, def: any, raw: string }>}
 */
export function parseSnapshot(lines) {
  const entries = [];
  for (const line of lines) {
    if (!line || line.startsWith("#")) continue;
    const first = line.indexOf("\t");
    const second = line.indexOf("\t", first + 1);
    if (first < 0 || second < 0) throw new Error(`Malformed schema manifest line: ${line.slice(0, 120)}`);
    const raw = line.slice(second + 1);
    entries.push({ kind: line.slice(0, first), identity: line.slice(first + 1, second), def: JSON.parse(raw), raw });
  }
  return entries;
}

/**
 * Comparison key for an entry.
 *
 * Constraints and indexes are keyed by what they enforce, not by name: drizzle,
 * pg_dump and hand-written DDL name the same unique constraint differently
 * (`users_username_unique` vs `users_username_key`). The name is cosmetic; the
 * table plus definition is what the application relies on, so an equivalent
 * object under another name satisfies the expectation. Everything else is keyed
 * by its qualified name and compared by full definition.
 */
export function comparisonKey(entry) {
  if (entry.kind === "constraint") {
    const table = entry.identity.slice(0, entry.identity.lastIndexOf("."));
    // NOT VALID is carried by def.validated, not by the key.
    return `constraint\t${table} :: ${entry.def.def.replace(/ NOT VALID$/, "")}`;
  }
  if (entry.kind === "index") {
    return `index\t${entry.def.table} :: ${indexShape(entry.def.def)}`;
  }
  return `${entry.kind}\t${entry.identity}`;
}

/** The comparable part of an entry once its key matched. */
function comparisonValue(entry) {
  // FOREIGN KEY / CHECK constraints are enforced on every new or changed row
  // whether or not historical rows were validated. Adoption adds them NOT VALID
  // to populated tables so production history is never scanned or rewritten;
  // validation is a separate, data-reviewed operator step (reported by verify).
  if (entry.kind === "constraint") return "present";
  if (entry.kind === "index") return entry.def.valid ? "valid" : "invalid";
  return entry.raw;
}

const isNamedShape = (entry) => entry.kind === "constraint" || entry.kind === "index";

/**
 * A database object that is strictly *safer* than the expectation satisfies it,
 * and adoption never loosens it:
 *   - constraint: validated where NOT VALID is expected;
 *   - function:   PUBLIC denied EXECUTE where the baseline allows it;
 *   - table:      row-level security enabled/forced beyond the baseline;
 *   - column:     NOT NULL where the baseline allows NULL.
 * Every other field must match exactly.
 */
function isStricter(expected, actual) {
  const e = expected.def;
  const a = actual.def;
  switch (expected.kind) {
    case "function":
      return e.def === a.def && e.kind === a.kind && e.comment === a.comment && e.publicExecute !== false && a.publicExecute === false;
    case "table":
      return (
        e.kind === a.kind && e.unlogged === a.unlogged && e.partitionKey === a.partitionKey && e.comment === a.comment &&
        (a.rls || !e.rls) && (a.forceRls || !e.forceRls)
      );
    case "column":
      return (
        e.type === a.type && e.default === a.default && e.identity === a.identity &&
        e.generated === a.generated && e.collation === a.collation && e.comment === a.comment && !e.notNull && a.notNull
      );
    default:
      return false;
  }
}

/** `CREATE UNIQUE INDEX name ON public.t USING btree (a)` -> `UNIQUE USING btree (a)`. */
export function indexShape(def) {
  const match = /^CREATE (UNIQUE )?INDEX \S+ ON (?:ONLY )?\S+ (.*)$/s.exec(def);
  return match ? `${match[1] ?? ""}${match[2]}` : def;
}

/**
 * Compare an expected schema (a manifest) with an actual database snapshot.
 *
 * - missing: expected objects with no equivalent in the database;
 * - changed: objects present under the same key with a different definition;
 * - extra:   objects in the database the manifest does not describe (legacy
 *            tables, archives, extra indexes). Extras are reported, never removed.
 *
 * A constraint expected as validated is satisfied by a NOT VALID equivalent only
 * as a `changed` entry, so it is surfaced rather than silently accepted.
 *
 * @param {string[]} expectedLines
 * @param {string[]} actualLines
 */
export function compareSnapshots(expectedLines, actualLines) {
  const expected = new Map(parseSnapshot(expectedLines).map((e) => [comparisonKey(e), e]));
  const actual = new Map(parseSnapshot(actualLines).map((e) => [comparisonKey(e), e]));
  const missing = [];
  const changed = [];
  const extra = [];
  for (const [key, entry] of expected) {
    const other = actual.get(key);
    if (!other) missing.push(entry);
    else if (comparisonValue(other) !== comparisonValue(entry) && !isStricter(entry, other)) {
      changed.push({ key, expected: entry, actual: other });
    }
  }
  for (const [key, entry] of actual) if (!expected.has(key)) extra.push(entry);
  // A UNIQUE constraint is satisfied by an equivalent plain unique index (same
  // table, same columns, no predicate): uniqueness and FK targeting are the same.
  for (let i = missing.length - 1; i >= 0; i -= 1) {
    const entry = missing[i];
    if (entry.kind !== "constraint" || entry.def.type !== "u") continue;
    const match = /^UNIQUE (\(.*\))$/.exec(entry.def.def);
    if (!match) continue;
    const table = entry.identity.slice(0, entry.identity.lastIndexOf("."));
    if (actual.has(`index\t${table} :: UNIQUE USING btree ${match[1]}`)) missing.splice(i, 1);
  }
  // A missing constraint/index whose name is taken on the database by a
  // different definition is a changed object, not an absent one (creating it
  // would collide). The twin may also satisfy another expectation, so look it
  // up among all actual objects, not only the extras.
  const actualByName = new Map();
  for (const entry of actual.values()) if (isNamedShape(entry)) actualByName.set(`${entry.kind}\t${entry.identity}`, entry);
  for (let i = missing.length - 1; i >= 0; i -= 1) {
    const entry = missing[i];
    if (!isNamedShape(entry)) continue;
    const twin = actualByName.get(`${entry.kind}\t${entry.identity}`);
    if (!twin) continue;
    missing.splice(i, 1);
    const extraIndex = extra.indexOf(twin);
    if (extraIndex >= 0) extra.splice(extraIndex, 1);
    changed.push({ key: comparisonKey(entry), expected: entry, actual: twin });
  }
  // A UNIQUE constraint is satisfied by an equivalent plain unique index (same
  // table, same columns, no predicate): uniqueness and FK targeting are the same.
  for (let i = missing.length - 1; i >= 0; i -= 1) {
    const entry = missing[i];
    if (entry.kind !== "constraint" || entry.def.type !== "u") continue;
    const match = /^UNIQUE (\(.*\))$/.exec(entry.def.def);
    if (!match) continue;
    const table = entry.identity.slice(0, entry.identity.lastIndexOf("."));
    if (actual.has(`index\t${table} :: UNIQUE USING btree ${match[1]}`)) missing.splice(i, 1);
  }
  const byKey = (a, b) => comparisonKey(a).localeCompare(comparisonKey(b));
  return {
    missing: missing.sort(byKey),
    changed: changed.sort((a, b) => a.key.localeCompare(b.key)),
    extra: extra.sort(byKey),
  };
}

/** Count entries per object kind, for compact reports. */
export function summariseSnapshot(lines) {
  const counts = {};
  for (const line of lines) {
    if (!line || line.startsWith("#")) continue;
    const kind = line.slice(0, line.indexOf("\t"));
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  return counts;
}

/** Summarise a comparison result per kind (for logs and errors). */
export function summariseComparison(result) {
  const count = (list, pick) =>
    list.reduce((acc, item) => {
      const kind = pick(item);
      acc[kind] = (acc[kind] ?? 0) + 1;
      return acc;
    }, {});
  return {
    missing: count(result.missing, (e) => e.kind),
    changed: count(result.changed, (c) => c.expected.kind),
    extra: count(result.extra, (e) => e.kind),
  };
}
