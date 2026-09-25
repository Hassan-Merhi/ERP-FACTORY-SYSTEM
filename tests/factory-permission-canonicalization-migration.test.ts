/**
 * Runs the Factory page-key migrations (v1 renames and the Wave 5
 * canonicalization) against PostgreSQL in a throwaway schema, and checks the
 * rows they leave behind. This replaces assertions on the migration's source text:
 * what matters is which permissions users end up with, and that re-running at
 * every startup changes nothing.
 */
import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { coreTablesAndColumns } from "../server/startup-schema/001-core-tables-and-columns";

const statementIndex = (marker: string) => {
  const index = coreTablesAndColumns.findIndex((statement) => statement.includes(marker));
  if (index < 0) throw new Error(`startup statement not found: ${marker}`);
  return index;
};

// v1 is a single guarded DO block; Wave 5 is the three idempotent statements
// that precede the row recording 'factory-permission-canonicalization-v2'.
const v1Statement = coreTablesAndColumns[statementIndex("'factory-page-key-renames-v1'")];
const wave5LogIndex = statementIndex("'factory-permission-canonicalization-v2'");
const wave5Statements = coreTablesAndColumns.slice(wave5LogIndex - 3, wave5LogIndex + 1);

const schema = `wave5_canon_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
let client: PoolClient;

async function runMigrations() {
  await client.query(v1Statement);
  for (const statement of wave5Statements) await client.query(statement);
}

async function pageKeys(userId: string): Promise<string[]> {
  const { rows } = await client.query<{ page_key: string }>(
    "SELECT page_key FROM factory_user_page_access WHERE company_id = 1 AND user_id = $1 ORDER BY page_key",
    [userId]
  );
  return rows.map((row) => row.page_key);
}

async function hiddenFields(userId: string): Promise<string[]> {
  const { rows } = await client.query<{ hidden_cost_fields: string[] }>(
    "SELECT hidden_cost_fields FROM factory_user_profiles WHERE company_id = 1 AND user_id = $1",
    [userId]
  );
  return rows[0].hidden_cost_fields;
}

beforeAll(async () => {
  client = await pool.connect();
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`SET search_path TO ${schema}`);
  await client.query(`CREATE TABLE migrations_log (key text PRIMARY KEY, applied_at timestamp NOT NULL DEFAULT now())`);
  await client.query(`CREATE TABLE factory_user_page_access (
      id serial PRIMARY KEY,
      company_id integer NOT NULL,
      user_id varchar NOT NULL,
      page_key text NOT NULL,
      created_at timestamp NOT NULL DEFAULT now()
    )`);
  await client.query(
    `CREATE UNIQUE INDEX factory_user_page_access_unique ON factory_user_page_access (company_id, user_id, page_key)`
  );
  await client.query(`CREATE TABLE factory_user_profiles (
      id serial PRIMARY KEY,
      company_id integer NOT NULL,
      user_id varchar NOT NULL,
      display_name text NOT NULL,
      hidden_cost_fields text[] NOT NULL DEFAULT '{}'
    )`);

  await client.query(
    `INSERT INTO factory_user_page_access (company_id, user_id, page_key) VALUES
      (1, 'legacy', 'factory/stock-allocation-v2'),
      (1, 'legacy', 'factory/stock-allocation-v3'),
      (1, 'legacy', 'factory/raw-stock'),
      (1, 'legacy', 'factory/daybook'),
      (1, 'legacy', 'factory/mix-batches'),
      (1, 'already-canonical', 'factory/stock-allocation-v5'),
      (1, 'already-canonical', 'factory/stock-allocation-v2'),
      (1, 'daybook-only', 'factory/daybook'),
      (1, 'v1-era', 'factory/create'),
      (1, 'v1-era', 'factory/users'),
      (1, 'v1-era', 'factory/sales/new')`
  );
  await client.query(
    `INSERT INTO factory_user_profiles (company_id, user_id, display_name, hidden_cost_fields) VALUES
      (1, 'legacy', 'Legacy user',
        ARRAY['hide_tab_production_analytics', 'hide_tab_stockentry_attendance_register',
              'hide_tab_daybook_transactions', 'inventory_avg_rate']),
      (1, 'daybook-only', 'Daybook user', ARRAY['hide_tab_daybook_transactions'])`
  );

  await runMigrations();
});

afterAll(async () => {
  if (!client) return;
  await client.query("RESET search_path");
  await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  client.release();
});

describe("Factory permission canonicalization migration", () => {
  it("moves V2/V3 stock allocation and renamed pages onto their canonical keys", async () => {
    expect(await pageKeys("legacy")).toEqual([
      "factory/daybook",
      "factory/raw-materials",
      "factory/stock-allocation-v5",
    ]);
  });

  it("does not duplicate a canonical key the user already had", async () => {
    expect(await pageKeys("already-canonical")).toEqual(["factory/stock-allocation-v5"]);
  });

  it("never treats the canonical Daybook page as stale", async () => {
    expect(await pageKeys("daybook-only")).toEqual(["factory/daybook"]);
  });

  it("carries pages the v1 renames once deleted onto their canonical owners", async () => {
    expect(await pageKeys("v1-era")).toEqual(["factory/accounts", "factory/invoicing", "factory/settings"]);
  });

  it("drops deprecated tab keys and keeps valid tab and cost restrictions", async () => {
    expect(await hiddenFields("legacy")).toEqual(["hide_tab_daybook_transactions", "inventory_avg_rate"]);
    expect(await hiddenFields("daybook-only")).toEqual(["hide_tab_daybook_transactions"]);
  });

  it("is idempotent across startups and records each migration once", async () => {
    const before = await client.query(
      "SELECT company_id, user_id, page_key FROM factory_user_page_access ORDER BY 1, 2, 3"
    );

    await runMigrations();

    const after = await client.query(
      "SELECT company_id, user_id, page_key FROM factory_user_page_access ORDER BY 1, 2, 3"
    );
    expect(after.rows).toEqual(before.rows);
    const { rows } = await client.query<{ key: string }>("SELECT key FROM migrations_log ORDER BY key");
    expect(rows.map((row) => row.key)).toEqual([
      "factory-page-key-renames-v1",
      "factory-permission-canonicalization-v2",
    ]);
  });
});
