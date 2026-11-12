/**
 * Harness for testing database guards (triggers, check constraints, policies)
 * directly in SQL.
 *
 * A guard is only proven by attempting the write it forbids. Doing that through
 * the application needs a full fixture for every table, and proves the route
 * refuses, not the database. Here each test:
 *
 *   1. opens one transaction that is always rolled back,
 *   2. seeds the row to attack with triggers and foreign keys switched off
 *      (session_replication_role = replica), so no parent rows are needed,
 *   3. switches them back on and attempts the forbidden write.
 *
 * Check constraints and NOT NULL still apply while seeding, so a seeded row is
 * always one the schema itself accepts.
 */
import type { PoolClient } from "pg";
import { expect } from "vitest";

import { pool } from "../../server/db";

type Row = Record<string, unknown>;

interface ColumnInfo {
  name: string;
  dataType: string;
  udtName: string;
  maxLength: number | null;
  required: boolean;
}

interface ForeignKey {
  columns: string[];
  parentTable: string;
  parentColumns: string[];
}

/**
 * Values the type-based placeholders cannot guess: columns a check constraint
 * restricts to a list, a pattern or a relation between columns. They apply
 * whenever the table is seeded, including as a stub parent, and a caller's own
 * values win. Add a table here when seeding it reports a check violation.
 */
const CHECK_SATISFYING_VALUES: Record<string, Row> = {
  accounting_fiscal_review_signoffs: { review_kind: "ACCOUNTING" },
  factory_production_target_bonus_weekly_methods: {
    effective_week: "2026-01-12",
    method: "per_extra_bale",
    flat_bonus_usd: "0",
  },
};

const columnCache = new Map<string, ColumnInfo[]>();
const foreignKeyCache = new Map<string, ForeignKey[]>();
const enumCache = new Map<string, string>();
let seedSequence = 0;

/** Runs `work` in a transaction that is rolled back whatever happens. */
export async function withRollback<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    return await work(client);
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
}

async function columnsOf(client: PoolClient, table: string): Promise<ColumnInfo[]> {
  const cached = columnCache.get(table);
  if (cached) return cached;
  const { rows } = await client.query(
    `SELECT column_name, data_type, udt_name, character_maximum_length,
            (is_nullable = 'NO' AND column_default IS NULL
              AND is_identity = 'NO' AND is_generated = 'NEVER') AS required
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position`,
    [table]
  );
  if (rows.length === 0) throw new Error(`Table ${table} does not exist`);
  const columns = rows.map((row) => ({
    name: row.column_name as string,
    dataType: row.data_type as string,
    udtName: row.udt_name as string,
    maxLength: row.character_maximum_length as number | null,
    required: row.required as boolean,
  }));
  columnCache.set(table, columns);
  return columns;
}

async function foreignKeysOf(client: PoolClient, table: string): Promise<ForeignKey[]> {
  const cached = foreignKeyCache.get(table);
  if (cached) return cached;
  const { rows } = await client.query(
    `SELECT p.relname::text AS parent_table,
            ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
                    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum ORDER BY k.ord) AS columns,
            ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(attnum, ord)
                    JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum ORDER BY k.ord) AS parent_columns
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_class p ON p.oid = c.confrelid
      WHERE c.contype = 'f' AND t.relname = $1 AND t.relnamespace = 'public'::regnamespace
      ORDER BY cardinality(c.conkey) DESC, c.conname`,
    [table]
  );
  const keys = rows.map((row) => ({
    columns: row.columns as string[],
    parentTable: row.parent_table as string,
    parentColumns: row.parent_columns as string[],
  }));
  foreignKeyCache.set(table, keys);
  return keys;
}

async function firstEnumLabel(client: PoolClient, udtName: string): Promise<string> {
  const cached = enumCache.get(udtName);
  if (cached) return cached;
  const { rows } = await client.query(
    `SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = $1 ORDER BY e.enumsortorder LIMIT 1`,
    [udtName]
  );
  if (rows.length === 0) throw new Error(`No placeholder value for column type ${udtName}`);
  enumCache.set(udtName, rows[0].enumlabel);
  return rows[0].enumlabel;
}

async function placeholder(client: PoolClient, column: ColumnInfo, sequence: number): Promise<unknown> {
  switch (column.dataType) {
    case "integer":
    case "bigint":
    case "smallint":
      return 900000 + sequence;
    case "numeric":
    case "real":
    case "double precision":
      return "1";
    case "boolean":
      return false;
    case "date":
      return "2026-01-15";
    case "timestamp without time zone":
    case "timestamp with time zone":
      return "2026-01-15T10:00:00Z";
    case "json":
    case "jsonb":
      return "{}";
    case "uuid":
      return `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
    case "bytea":
      return Buffer.from([0]);
    case "ARRAY":
      return "{}";
    case "USER-DEFINED":
      return firstEnumLabel(client, column.udtName);
    default: {
      const text = `guard-${sequence}`;
      return column.maxLength !== null && text.length > column.maxLength ? text.slice(-column.maxLength) : text;
    }
  }
}

/**
 * Makes sure every foreign key the row carries points at a row that exists.
 *
 * Foreign keys are off while seeding, but PostgreSQL re-checks them when a row
 * created in the same transaction is later updated, so an allowed update on an
 * orphan row would fail for the wrong reason. Parents are stubs: they are
 * seeded without parents of their own.
 */
async function seedParents(client: PoolClient, table: string, row: Row): Promise<void> {
  for (const key of await foreignKeysOf(client, table)) {
    if (key.columns.some((column) => row[column] === undefined || row[column] === null)) continue;
    const conditions = key.parentColumns.map((column, index) => `"${column}" = $${index + 1}`).join(" AND ");
    const wanted = key.columns.map((column) => row[column]);
    const existing = await client.query(`SELECT 1 FROM "${key.parentTable}" WHERE ${conditions} LIMIT 1`, wanted);
    if (existing.rowCount) continue;
    const parentValues = Object.fromEntries(key.parentColumns.map((column, index) => [column, wanted[index]]));
    await seedRow(client, key.parentTable, parentValues, { parents: false });
  }
}

/**
 * Inserts one row into `table`, filling every required column the caller did
 * not supply, and returns it. Triggers and foreign keys are off for the insert
 * only; stub parent rows are created for the foreign keys the row carries.
 */
export async function seedRow(
  client: PoolClient,
  table: string,
  values: Row = {},
  options: { parents: boolean } = { parents: true }
): Promise<Row> {
  const columns = await columnsOf(client, table);
  const known = new Set(columns.map((column) => column.name));
  for (const name of Object.keys(values)) {
    if (!known.has(name)) throw new Error(`${table} has no column ${name}`);
  }

  seedSequence += 1;
  const row: Row = { ...CHECK_SATISFYING_VALUES[table], ...values };
  for (const column of columns) {
    if (column.required && !(column.name in row)) {
      row[column.name] = await placeholder(client, column, seedSequence);
    }
  }
  if (options.parents) await seedParents(client, table, row);

  const names = Object.keys(row);
  const text =
    names.length === 0
      ? `INSERT INTO "${table}" DEFAULT VALUES RETURNING *`
      : `INSERT INTO "${table}" (${names.map((name) => `"${name}"`).join(", ")})
         VALUES (${names.map((_, index) => `$${index + 1}`).join(", ")}) RETURNING *`;

  // A savepoint keeps a refused seed (a check constraint the placeholder values
  // break, say) from aborting the transaction and hiding the real error.
  await client.query("SAVEPOINT guard_seed");
  await client.query("SET LOCAL session_replication_role = replica");
  try {
    const { rows } = await client.query(
      text,
      names.map((name) => row[name])
    );
    await client.query("SET LOCAL session_replication_role = origin");
    await client.query("RELEASE SAVEPOINT guard_seed");
    return rows[0];
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT guard_seed");
    await client.query("SET LOCAL session_replication_role = origin");
    throw new Error(`Could not seed ${table}: ${(error as Error).message}`, { cause: error });
  }
}

export interface Refusal {
  /** SQLSTATE the guard raises. */
  code?: string;
  /** Text the guard's message must contain. */
  message?: string | RegExp;
  /** Constraint name, for check / unique / foreign-key refusals. */
  constraint?: string;
}

/**
 * Runs a statement that the database must refuse, and checks how it refused.
 * The statement runs inside a savepoint, so the surrounding transaction stays
 * usable and the test can go on to show that an allowed write still works.
 */
export async function expectRefused(
  client: PoolClient,
  text: string,
  params: unknown[],
  refusal: Refusal
): Promise<void> {
  let caught: (Error & { code?: string; constraint?: string }) | null = null;
  await client.query("SAVEPOINT guard_attempt");
  try {
    await client.query(text, params);
  } catch (error) {
    caught = error as Error & { code?: string; constraint?: string };
  }
  await client.query("ROLLBACK TO SAVEPOINT guard_attempt");

  expect(caught, `The database accepted a write it must refuse: ${text}`).not.toBeNull();
  if (refusal.code !== undefined) expect(caught?.code, caught?.message).toBe(refusal.code);
  if (refusal.constraint !== undefined) expect(caught?.constraint, caught?.message).toBe(refusal.constraint);
  if (typeof refusal.message === "string") expect(caught?.message).toContain(refusal.message);
  else if (refusal.message) expect(caught?.message).toMatch(refusal.message);
}

/** Runs a statement the database must accept and returns the affected rows. */
export async function expectAccepted(client: PoolClient, text: string, params: unknown[] = []): Promise<Row[]> {
  const result = await client.query(text, params);
  expect(result.rowCount, `The statement matched no row: ${text}`).toBeGreaterThan(0);
  return result.rows;
}

/** Re-reads a row by id, to show a refused write left it untouched. */
export async function reread(client: PoolClient, table: string, id: unknown): Promise<Row> {
  const { rows } = await client.query(`SELECT * FROM "${table}" WHERE id = $1`, [id]);
  expect(rows, `${table} row ${String(id)} is gone`).toHaveLength(1);
  return rows[0];
}
