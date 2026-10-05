/**
 * Production booted for years without the ordered startup pass, so its Sheets &
 * Sacks log is an older ad hoc table: legacy columns the app never writes,
 * unconstrained numeric types, a naive created_at and no action check. The
 * always-on ensure converges it to the shape a fresh database gets, but only
 * where the data allows. Reproduce both cases in throwaway schemas (the ensure
 * uses unqualified names, so search_path points it there).
 */
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../server/db";
import { ensureFactorySheetsSacksSchema } from "../server/startup/factorySheetsSacksSchema";

const schemaPrefix = `fss_guard_test_${process.pid}`;
let client: PoolClient;

const LEGACY_LOG = `
  CREATE TABLE factory_sheets_sacks_log (
    id SERIAL PRIMARY KEY,
    entry_id INTEGER,
    company_id INTEGER,
    color TEXT,
    current_stock INTEGER NOT NULL DEFAULT 0,
    packs_to_deduct INTEGER NOT NULL DEFAULT 0,
    pieces_per_pack INTEGER NOT NULL DEFAULT 500,
    pieces_to_deduct INTEGER NOT NULL DEFAULT 0,
    remaining_stock INTEGER NOT NULL DEFAULT 0,
    reason TEXT,
    created_by INTEGER,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    item_id INTEGER,
    item_name TEXT,
    item_type TEXT,
    action TEXT NOT NULL DEFAULT 'deduct',
    pieces NUMERIC NOT NULL DEFAULT 0,
    packs INTEGER,
    unit_price NUMERIC NOT NULL DEFAULT 0,
    total_value NUMERIC NOT NULL DEFAULT 0,
    notes TEXT
  );
  CREATE INDEX idx_factory_sheets_sacks_log_item_id ON factory_sheets_sacks_log (item_id);
`;

async function useSchema(name: string): Promise<void> {
  await client.query(`CREATE SCHEMA ${name}`);
  await client.query(`SET search_path TO ${name}`);
}

async function logColumns(schema: string): Promise<Record<string, string>> {
  const result = await client.query<{ column_name: string; shape: string }>(
    `SELECT column_name,
            format_type(a.atttypid, a.atttypmod) || CASE WHEN a.attnotnull THEN ' not null' ELSE '' END AS shape
       FROM information_schema.columns c
       JOIN pg_attribute a ON a.attrelid = format('%I.%I', c.table_schema, c.table_name)::regclass
                          AND a.attname = c.column_name
      WHERE c.table_schema = $1 AND c.table_name = 'factory_sheets_sacks_log'`,
    [schema]
  );
  return Object.fromEntries(result.rows.map((row) => [row.column_name, row.shape]));
}

beforeAll(async () => {
  client = await pool.connect();
});

afterAll(async () => {
  await client.query(`SET search_path TO DEFAULT`);
  for (const suffix of ["fresh", "legacy", "held"]) {
    await client.query(`DROP SCHEMA IF EXISTS ${schemaPrefix}_${suffix} CASCADE`);
  }
  client.release();
});

describe("factory sheets & sacks runtime schema", () => {
  it("converges a legacy log to the fresh shape and keeps its rows", async () => {
    await useSchema(`${schemaPrefix}_fresh`);
    await ensureFactorySheetsSacksSchema(client);
    const fresh = await logColumns(`${schemaPrefix}_fresh`);

    await useSchema(`${schemaPrefix}_legacy`);
    await client.query(LEGACY_LOG);
    await client.query(`
      INSERT INTO factory_sheets_sacks_log
        (company_id, item_id, item_name, item_type, action, pieces, packs, unit_price, total_value, created_at, updated_at)
      VALUES (1, 7, 'Sheet A', 'Sheet', 'IN', 500, 1, 0.012345, 6.1725, '2026-01-02 03:04:05', '2026-01-02 03:04:05')
    `);
    await ensureFactorySheetsSacksSchema(client);
    await ensureFactorySheetsSacksSchema(client);

    expect(await logColumns(`${schemaPrefix}_legacy`)).toEqual(fresh);
    const row = await client.query(
      `SELECT pieces, unit_price::text, total_value::text, created_at FROM factory_sheets_sacks_log`
    );
    expect(row.rows).toEqual([
      { pieces: 500, unit_price: "0.012345", total_value: "6.1725", created_at: new Date("2026-01-02T03:04:05Z") },
    ]);
    await expect(
      client.query(
        `INSERT INTO factory_sheets_sacks_log (company_id, item_id, item_name, item_type, action) VALUES (1, 7, 'x', 'Sheet', 'deduct')`
      )
    ).rejects.toThrow(/factory_sheets_sacks_log_action_check/);
    const legacyIndex = await client.query(
      `SELECT 1 FROM pg_indexes WHERE schemaname = $1 AND indexname = 'idx_factory_sheets_sacks_log_item_id'`,
      [`${schemaPrefix}_legacy`]
    );
    expect(legacyIndex.rowCount).toBe(0);
  });

  it("keeps legacy columns and loose types that still hold data", async () => {
    await useSchema(`${schemaPrefix}_held`);
    await client.query(LEGACY_LOG);
    await client.query(`
      INSERT INTO factory_sheets_sacks_log (company_id, item_id, item_name, item_type, action, pieces, unit_price, reason)
      VALUES (1, 7, 'Sheet A', 'Sheet', 'deduct', 1.5, 0.1234567, 'kept')
    `);
    await ensureFactorySheetsSacksSchema(client);

    const columns = await logColumns(`${schemaPrefix}_held`);
    expect(columns.reason).toBe("text");
    expect(columns.entry_id).toBeUndefined();
    expect(columns.pieces).toBe("numeric not null");
    expect(columns.unit_price).toBe("numeric not null");
    const row = await client.query(
      `SELECT pieces::text, unit_price::text, action, reason FROM factory_sheets_sacks_log`
    );
    expect(row.rows).toEqual([{ pieces: "1.5", unit_price: "0.1234567", action: "deduct", reason: "kept" }]);
  });
});
