/**
 * Compile PostgreSQL DDL from schema manifest entries.
 *
 * Two uses:
 *   - compileCreateSchema(entries): ordered DDL that builds the described schema
 *     in an empty database (used to construct and cross-check the baseline);
 *   - planAdoption(comparison): the minimal DDL that brings an existing database
 *     up to the manifest, plus the list of differences that must NOT be changed
 *     automatically (they block adoption until a reviewed migration handles them).
 *
 * Adoption never drops tables, columns, constraints, indexes or policies and
 * never weakens security (RLS stays enabled where it is enabled). It only adds
 * missing objects, widens column types losslessly, replaces function/trigger
 * bodies with the reviewed baseline versions, and tightens constraints
 * (validation, NOT NULL) inside one transaction, so any data that violates the
 * expected schema aborts the whole adoption with no change made.
 */
import { KIND_ORDER, indexShape } from "../../../server/schema/schemaCatalog.mjs";

/** Split a dotted identifier list produced by format('%I.%I') respecting quotes. */
export function splitIdentifier(identity) {
  const parts = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < identity.length; i += 1) {
    const ch = identity[i];
    if (ch === '"') {
      if (quoted && identity[i + 1] === '"') {
        current += '""';
        i += 1;
        continue;
      }
      quoted = !quoted;
      current += ch;
    } else if (ch === "." && !quoted) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

const tableOf = (identity) => splitIdentifier(identity).slice(0, 2).join(".");
const lastPart = (identity) => splitIdentifier(identity).at(-1);

const POLICY_COMMANDS = { r: "SELECT", a: "INSERT", w: "UPDATE", d: "DELETE", "*": "ALL" };

/** Column definition fragment for CREATE TABLE / ADD COLUMN. */
export function columnSql(entry) {
  const def = entry.def;
  let sql = `${lastPart(entry.identity)} ${def.type}`;
  if (def.collation) sql += ` COLLATE ${def.collation}`;
  if (def.generated) sql += ` GENERATED ALWAYS AS (${def.generated}) STORED`;
  if (def.identity) sql += ` GENERATED ${def.identity === "a" ? "ALWAYS" : "BY DEFAULT"} AS IDENTITY`;
  if (def.default !== null && def.default !== undefined) sql += ` DEFAULT ${def.default}`;
  if (def.notNull) sql += " NOT NULL";
  return sql;
}

function sequenceSql(entry) {
  const d = entry.def;
  return (
    `CREATE SEQUENCE ${entry.identity} AS ${d.type} START WITH ${d.start} INCREMENT BY ${d.increment} ` +
    `MINVALUE ${d.min} MAXVALUE ${d.max} CACHE ${d.cache}${d.cycle ? " CYCLE" : " NO CYCLE"};`
  );
}

function policySql(entry) {
  const d = entry.def;
  let sql = `CREATE POLICY ${lastPart(entry.identity)} ON ${d.table} AS ${d.permissive ? "PERMISSIVE" : "RESTRICTIVE"}`;
  sql += ` FOR ${POLICY_COMMANDS[d.cmd]} TO ${(d.roles ?? ["public"]).join(", ")}`;
  if (d.using) sql += ` USING (${d.using})`;
  if (d.check) sql += ` WITH CHECK (${d.check})`;
  return `${sql};`;
}

function triggerEnabledSql(entry) {
  const table = entry.def.table;
  const name = lastPart(entry.identity);
  switch (entry.def.enabled) {
    case "D":
      return `ALTER TABLE ${table} DISABLE TRIGGER ${name};`;
    case "R":
      return `ALTER TABLE ${table} ENABLE REPLICA TRIGGER ${name};`;
    case "A":
      return `ALTER TABLE ${table} ENABLE ALWAYS TRIGGER ${name};`;
    default:
      return `ALTER TABLE ${table} ENABLE TRIGGER ${name};`;
  }
}

function rlsSql(entry) {
  const out = [];
  if (entry.def.rls) out.push(`ALTER TABLE ${entry.identity} ENABLE ROW LEVEL SECURITY;`);
  if (entry.def.forceRls) out.push(`ALTER TABLE ${entry.identity} FORCE ROW LEVEL SECURITY;`);
  return out;
}

const withSemicolon = (sql) => (sql.trimEnd().endsWith(";") ? sql.trimEnd() : `${sql.trimEnd()};`);

/** Constraint creation; foreign keys are emitted after every other constraint. */
function constraintSql(entry) {
  return `ALTER TABLE ${tableOf(entry.identity)} ADD CONSTRAINT ${lastPart(entry.identity)} ${entry.def.def};`;
}

const CONSTRAINT_ORDER = { p: 0, u: 1, x: 2, c: 3, f: 4 };

/**
 * DDL that creates every entry in an empty database, in dependency order.
 * @param {Array<{kind:string, identity:string, def:any}>} entries
 * @returns {string[]} statements
 */
export function compileCreateSchema(entries) {
  const phases = compileCreatePhases(entries);
  return [...phases.pre, ...phases.tables, ...phases.post];
}

/**
 * Same as compileCreateSchema, split into phases so adoption can insert column
 * additions and definition changes at the right dependency point.
 * pre: settings, schemas, extensions, sequences; tables: CREATE TABLE, functions;
 * post: sequence ownership, constraints, indexes, triggers, RLS, policies.
 */
export function compileCreatePhases(entries) {
  const byKind = Object.fromEntries(KIND_ORDER.map((kind) => [kind, []]));
  for (const entry of entries) {
    if (!byKind[entry.kind]) throw new Error(`Unsupported manifest object kind: ${entry.kind}`);
    byKind[entry.kind].push(entry);
  }
  for (const kind of ["type", "event_trigger"]) {
    if (byKind[kind].length) throw new Error(`Manifest contains ${kind} objects; extend schemaDdl.mjs first`);
  }
  const out = ["SET LOCAL check_function_bodies = false;"];
  for (const e of byKind.schema) out.push(`CREATE SCHEMA IF NOT EXISTS ${e.identity};`);
  for (const e of byKind.extension) out.push(`CREATE EXTENSION IF NOT EXISTS ${e.identity} WITH SCHEMA ${e.def.schema};`);
  for (const e of byKind.sequence) out.push(sequenceSql(e));
  const columnsByTable = new Map();
  for (const c of byKind.column) {
    const table = tableOf(c.identity);
    if (!columnsByTable.has(table)) columnsByTable.set(table, []);
    columnsByTable.get(table).push(c);
  }
  const pre = out.splice(0);
  for (const t of byKind.table) {
    const cols = (columnsByTable.get(t.identity) ?? []).map((c) => `    ${columnSql(c)}`);
    let sql = `CREATE ${t.def.unlogged ? "UNLOGGED " : ""}TABLE ${t.identity} (\n${cols.join(",\n")}\n)`;
    if (t.def.partitionKey) sql += ` PARTITION BY ${t.def.partitionKey}`;
    out.push(`${sql};`);
  }
  // Functions follow tables: some take table row types as arguments. Column
  // defaults only use built-in functions, and check constraints come later.
  for (const e of byKind.function) if (e.def.def) out.push(withSemicolon(e.def.def));
  const tables = out.splice(0);
  for (const s of byKind.sequence) if (s.def.ownedBy) out.push(`ALTER SEQUENCE ${s.identity} OWNED BY ${s.def.ownedBy};`);
  const constraints = [...byKind.constraint].sort(
    (a, b) => CONSTRAINT_ORDER[a.def.type] - CONSTRAINT_ORDER[b.def.type] || a.identity.localeCompare(b.identity)
  );
  // Foreign keys go last: they may reference a plain UNIQUE index.
  for (const c of constraints) if (c.def.type !== "f") out.push(constraintSql(c));
  // An index-backed constraint (PK/UNIQUE/EXCLUDE) creates its own index.
  const constraintIndexes = new Set(
    constraints
      .filter((c) => c.def.type !== "f" && c.def.type !== "c")
      .map((c) => `${splitIdentifier(c.identity)[0]}.${lastPart(c.identity)}`)
  );
  for (const i of byKind.index) {
    if (!i.def.constraint && !constraintIndexes.has(i.identity)) out.push(withSemicolon(i.def.def));
  }
  for (const c of constraints) if (c.def.type === "f") out.push(constraintSql(c));
  for (const t of byKind.trigger) {
    out.push(withSemicolon(t.def.def));
    if (t.def.enabled !== "O") out.push(triggerEnabledSql(t));
  }
  for (const t of byKind.table) out.push(...rlsSql(t));
  for (const p of byKind.policy) out.push(policySql(p));
  return { pre, tables, post: out };
}

// ---------------------------------------------------------------------------
// Adoption planning
// ---------------------------------------------------------------------------

const NUMERIC = /^numeric\((\d+),(\d+)\)$/;
const VARCHAR = /^character varying\((\d+)\)$/;
const INTEGER_RANK = { smallint: 1, integer: 2, bigint: 3 };

/**
 * Whether converting a column from `from` to `to` can never silently lose or
 * reinterpret stored values: the conversion is either exact or fails loudly
 * (which rolls the adoption back). Only these conversions are applied
 * automatically; anything else is a blocker for a reviewed migration.
 */
export function isLosslessTypeChange(from, to) {
  if (from === to) return true;
  const nf = NUMERIC.exec(from);
  const nt = NUMERIC.exec(to);
  if (nf && nt) {
    // Scale must not shrink (that rounds silently). Fewer integer digits is
    // fail-safe: PostgreSQL raises "numeric field overflow" instead of storing
    // a wrong value, which aborts the whole adoption transaction.
    const [sf, st] = [nf[2], nt[2]].map(Number);
    return st >= sf;
  }
  if (nf && to === "numeric") return true;
  if (INTEGER_RANK[from] && INTEGER_RANK[to]) return INTEGER_RANK[to] >= INTEGER_RANK[from];
  if (INTEGER_RANK[from] && nt) return Number(nt[1]) - Number(nt[2]) >= 19;
  const vf = VARCHAR.exec(from);
  const vt = VARCHAR.exec(to);
  if (vf && vt) return Number(vt[1]) >= Number(vf[1]);
  if ((vf || from === "character varying") && (to === "text" || to === "character varying")) return true;
  if (from === "text" && to === "character varying") return true;
  // Integers render to text exactly; used for user-id columns widened to varchar.
  if (INTEGER_RANK[from] && (to === "text" || to === "character varying")) return true;
  if (INTEGER_RANK[from] && vt) return Number(vt[1]) >= 20;
  return false;
}

/**
 * Plan the DDL that brings an existing database up to the manifest.
 *
 * @param {{missing: any[], changed: Array<{key:string, expected:any, actual:any}>}} comparison
 * @returns {{ statements: string[], blockers: string[], notes: string[] }}
 */
export function planAdoption(comparison) {
  const blockers = [];
  const notes = [];
  const missing = comparison.missing;
  const missingTables = new Set(missing.filter((e) => e.kind === "table").map((e) => e.identity));
  // Columns of a table being created are created with it; other missing
  // columns are added to the existing table.
  const phases = compileCreatePhases(
    missing.filter((e) => e.kind !== "column" || missingTables.has(tableOf(e.identity)))
  );
  const addColumns = missing
    .filter((e) => e.kind === "column" && !missingTables.has(tableOf(e.identity)))
    .map((c) => `ALTER TABLE ${tableOf(c.identity)} ADD COLUMN ${columnSql(c)};`);
  // Missing tables need their RLS flags; existing tables with changed flags are handled below.
  const changeStatements = [];
  for (const { expected, actual } of comparison.changed) {
    const where = `${expected.kind} ${expected.identity}`;
    switch (expected.kind) {
      case "column": {
        const e = expected.def;
        const a = actual.def;
        const table = tableOf(expected.identity);
        const col = lastPart(expected.identity);
        if (e.identity !== a.identity || e.generated !== a.generated || e.collation !== a.collation) {
          blockers.push(`${where}: identity/generated/collation differs; needs a reviewed migration`);
          break;
        }
        if (e.type !== a.type) {
          if (!isLosslessTypeChange(a.type, e.type)) {
            blockers.push(`${where}: type ${a.type} -> ${e.type} is not provably lossless`);
            break;
          }
          changeStatements.push(`ALTER TABLE ${table} ALTER COLUMN ${col} TYPE ${e.type} USING ${col}::${e.type};`);
        }
        if ((e.default ?? null) !== (a.default ?? null)) {
          changeStatements.push(
            e.default === null || e.default === undefined
              ? `ALTER TABLE ${table} ALTER COLUMN ${col} DROP DEFAULT;`
              : `ALTER TABLE ${table} ALTER COLUMN ${col} SET DEFAULT ${e.default};`
          );
        }
        if (e.notNull && !a.notNull) changeStatements.push(`ALTER TABLE ${table} ALTER COLUMN ${col} SET NOT NULL;`);
        if (!e.notNull && a.notNull) {
          notes.push(`${where}: database is NOT NULL where the baseline allows NULL; kept (stricter)`);
        }
        break;
      }
      case "function":
        if (!expected.def.def) {
          blockers.push(`${where}: aggregate/window function differs`);
          break;
        }
        changeStatements.push(withSemicolon(expected.def.def));
        break;
      case "trigger":
        if (/^CREATE CONSTRAINT TRIGGER/.test(expected.def.def)) {
          blockers.push(`${where}: constraint trigger differs`);
          break;
        }
        if (expected.def.def !== actual.def.def) {
          changeStatements.push(withSemicolon(expected.def.def.replace(/^CREATE TRIGGER/, "CREATE OR REPLACE TRIGGER")));
        }
        if (expected.def.enabled !== actual.def.enabled) changeStatements.push(triggerEnabledSql(expected));
        break;
      case "policy":
        changeStatements.push(`DROP POLICY ${lastPart(expected.identity)} ON ${expected.def.table};`);
        changeStatements.push(policySql(expected));
        break;
      case "table": {
        const e = expected.def;
        const a = actual.def;
        if (e.kind !== a.kind || e.unlogged !== a.unlogged || e.partitionKey !== a.partitionKey) {
          blockers.push(`${where}: table kind/persistence/partitioning differs`);
          break;
        }
        if (e.rls && !a.rls) changeStatements.push(`ALTER TABLE ${expected.identity} ENABLE ROW LEVEL SECURITY;`);
        if (e.forceRls && !a.forceRls) changeStatements.push(`ALTER TABLE ${expected.identity} FORCE ROW LEVEL SECURITY;`);
        if ((!e.rls && a.rls) || (!e.forceRls && a.forceRls)) {
          notes.push(`${where}: database enforces row-level security beyond the baseline; kept (stricter)`);
        }
        break;
      }
      case "sequence": {
        const e = expected.def;
        const a = actual.def;
        if (e.type !== a.type && !isLosslessTypeChange(a.type, e.type)) {
          blockers.push(`${where}: sequence type ${a.type} -> ${e.type} narrows`);
          break;
        }
        if (e.type !== a.type) changeStatements.push(`ALTER SEQUENCE ${expected.identity} AS ${e.type};`);
        if (e.increment !== a.increment || e.cycle !== a.cycle || e.cache !== a.cache || e.min !== a.min || e.max !== a.max) {
          changeStatements.push(
            `ALTER SEQUENCE ${expected.identity} INCREMENT BY ${e.increment} MINVALUE ${e.min} MAXVALUE ${e.max} CACHE ${e.cache}${e.cycle ? " CYCLE" : " NO CYCLE"};`
          );
        }
        if ((e.ownedBy ?? null) !== (a.ownedBy ?? null)) {
          changeStatements.push(`ALTER SEQUENCE ${expected.identity} OWNED BY ${e.ownedBy ?? "NONE"};`);
        }
        break;
      }
      case "constraint":
        if (expected.def.def.replace(/ NOT VALID$/, "") !== actual.def.def.replace(/ NOT VALID$/, "")) {
          blockers.push(`${where}: a constraint with this name enforces "${actual.def.def}" instead of "${expected.def.def}"`);
          break;
        }
        // Same table + definition, but the database copy is NOT VALID.
        changeStatements.push(`ALTER TABLE ${tableOf(actual.identity)} VALIDATE CONSTRAINT ${lastPart(actual.identity)};`);
        break;
      case "index":
        blockers.push(
          expected.def.def === actual.def.def || indexShape(expected.def.def) === indexShape(actual.def.def)
            ? `${where}: an equivalent index exists but is INVALID; rebuild it under review`
            : `${where}: an index with this name is "${actual.def.def}" instead of "${expected.def.def}"`
        );
        break;
      default:
        blockers.push(`${where}: unsupported change`);
    }
  }
  // Order: new functions/sequences/tables, added columns, then definition
  // changes (which may reference new columns or functions), then constraints,
  // indexes, triggers, RLS and policies for new objects, then trigger/policy
  // replacements.
  const late = changeStatements.filter((sql) => /^(CREATE OR REPLACE TRIGGER|DROP POLICY|CREATE POLICY|ALTER TABLE \S+ (ENABLE|DISABLE)( REPLICA| ALWAYS)? TRIGGER)/.test(sql));
  const early = changeStatements.filter((sql) => !late.includes(sql));
  const statements = [...phases.pre, ...phases.tables, ...addColumns, ...early, ...phases.post, ...late];
  return { statements: statements.length > 1 ? statements : [], blockers, notes };
}

export { indexShape };
