/**
 * Production never runs migrations/*.sql and boots with the bulk startup pass
 * disabled, so the retail fashion variant columns must come from the always-on
 * guard. Reproduce a table that predates them in a throwaway schema (the guard
 * uses unqualified names, so search_path points it there) and repair it,
 * leaving the shared retail_product_variants table untouched.
 */
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../server/db";
import { ensureRetailVariantSchema } from "../server/startup/ensureRuntimeSchema";

const schema = `retail_guard_test_${process.pid}`;
let client: PoolClient;

async function columns(): Promise<string[]> {
  const result = await client.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = 'retail_product_variants'
       AND column_name IN ('color', 'image_urls') ORDER BY column_name`,
    [schema]
  );
  return result.rows.map((row) => row.column_name);
}

async function indexes(): Promise<string[]> {
  const result = await client.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes
     WHERE schemaname = $1 AND tablename = 'retail_product_variants'
       AND indexname LIKE 'retail_product_variants_product_%_unique' ORDER BY indexname`,
    [schema]
  );
  return result.rows.map((row) => row.indexname);
}

beforeAll(async () => {
  client = await pool.connect();
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`SET search_path TO ${schema}`);
  // The shape production has before the guard runs: no color or image_urls,
  // and the old (product_id, size) unique index.
  await client.query(`
    CREATE TABLE retail_product_variants (
      id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL,
      size VARCHAR(50) NOT NULL
    );
    CREATE UNIQUE INDEX retail_product_variants_product_size_unique
      ON retail_product_variants (product_id, size);
    INSERT INTO retail_product_variants (product_id, size) VALUES (1, 'M'), (1, 'L');
  `);
});

afterAll(async () => {
  await client.query(`SET search_path TO DEFAULT`);
  await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  client.release();
});

describe("retail variant runtime schema", () => {
  it("adds color and image_urls and swaps the unique index on a table that predates them", async () => {
    expect(await columns()).toEqual([]);
    expect(await indexes()).toEqual(["retail_product_variants_product_size_unique"]);

    await ensureRetailVariantSchema(client as unknown as Pool);

    expect(await columns()).toEqual(["color", "image_urls"]);
    expect(await indexes()).toEqual(["retail_product_variants_product_color_size_unique"]);
    const rows = await client.query(`SELECT color, image_urls FROM retail_product_variants ORDER BY id`);
    expect(rows.rows).toEqual([
      { color: "Default", image_urls: [] },
      { color: "Default", image_urls: [] },
    ]);
  });

  it("is a no-op when run again", async () => {
    await ensureRetailVariantSchema(client as unknown as Pool);
    expect(await columns()).toEqual(["color", "image_urls"]);
    expect(await indexes()).toEqual(["retail_product_variants_product_color_size_unique"]);
  });
});
