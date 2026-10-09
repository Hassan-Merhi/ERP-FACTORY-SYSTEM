/**
 * Production never runs migrations/*.sql, so the retail barcode and label
 * schema must come from the always-on guard. Rebuild the tables it depends on
 * in a throwaway schema (the guard uses unqualified names, so search_path
 * points it there) and check the guard repairs and then leaves them alone.
 */
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../server/db";
import { ensureRetailBarcodeLabelSchema } from "../server/startup/ensureRuntimeSchema";

const schema = `retail_label_guard_test_${process.pid}`;
let client: PoolClient;

async function tables(): Promise<string[]> {
  const result = await client.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = $1 AND table_name IN ('retail_barcode_sequences', 'retail_label_print_events')
     ORDER BY table_name`,
    [schema]
  );
  return result.rows.map((row) => row.table_name);
}

async function hasBarcodeSource(): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = 'retail_product_variants' AND column_name = 'barcode_source'`,
    [schema]
  );
  return result.rowCount === 1;
}

beforeAll(async () => {
  client = await pool.connect();
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`SET search_path TO ${schema}`);
  // The shape production has before the guard runs.
  await client.query(`
    CREATE TABLE companies (id SERIAL PRIMARY KEY);
    CREATE TABLE users (id VARCHAR PRIMARY KEY);
    CREATE TABLE retail_product_variants (id SERIAL PRIMARY KEY, barcode VARCHAR(191) NOT NULL);
    CREATE TABLE retail_stock_movements (id SERIAL PRIMARY KEY, variant_id INTEGER, created_at TIMESTAMP);
    INSERT INTO retail_product_variants (barcode) VALUES ('8412345678905'), ('2000000000015');
  `);
});

afterAll(async () => {
  await client.query(`SET search_path TO DEFAULT`);
  await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  client.release();
});

describe("retail barcode and label runtime schema", () => {
  it("adds barcode_source, the sequence and label-print tables on a database that predates them", async () => {
    expect(await hasBarcodeSource()).toBe(false);
    expect(await tables()).toEqual([]);

    await ensureRetailBarcodeLabelSchema(client as unknown as Pool);

    expect(await hasBarcodeSource()).toBe(true);
    expect(await tables()).toEqual(["retail_barcode_sequences", "retail_label_print_events"]);
    const rows = await client.query(`SELECT barcode_source FROM retail_product_variants ORDER BY id`);
    expect(rows.rows).toEqual([{ barcode_source: "manual" }, { barcode_source: "manual" }]);
  });

  it("is a no-op when run again", async () => {
    await ensureRetailBarcodeLabelSchema(client as unknown as Pool);
    expect(await hasBarcodeSource()).toBe(true);
    expect(await tables()).toEqual(["retail_barcode_sequences", "retail_label_print_events"]);
  });
});
