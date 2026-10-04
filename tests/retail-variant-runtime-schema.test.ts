/**
 * Production never runs migrations/*.sql and boots with the bulk startup pass
 * disabled, so the retail fashion variant columns must come from the always-on
 * guard. Reproduce a production database that predates them and repair it.
 */
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "../server/db";
import { ensureRetailVariantSchema } from "../server/startup/ensureRuntimeSchema";

async function columns(): Promise<string[]> {
  const result = await pool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'retail_product_variants'
       AND column_name IN ('color', 'image_urls') ORDER BY column_name`
  );
  return result.rows.map((row) => row.column_name);
}

async function indexes(): Promise<string[]> {
  const result = await pool.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = 'retail_product_variants'
       AND indexname LIKE 'retail_product_variants_product_%_unique' ORDER BY indexname`
  );
  return result.rows.map((row) => row.indexname);
}

afterAll(async () => {
  await ensureRetailVariantSchema(pool);
});

describe("retail variant runtime schema", () => {
  it("adds color and image_urls and swaps the unique index on a database that predates them", async () => {
    await pool.query(`
      DROP INDEX IF EXISTS retail_product_variants_product_color_size_unique;
      ALTER TABLE retail_product_variants DROP COLUMN IF EXISTS color, DROP COLUMN IF EXISTS image_urls;
      CREATE UNIQUE INDEX IF NOT EXISTS retail_product_variants_product_size_unique
        ON retail_product_variants (product_id, size);
    `);
    expect(await columns()).toEqual([]);
    expect(await indexes()).toEqual(["retail_product_variants_product_size_unique"]);

    await ensureRetailVariantSchema(pool);

    expect(await columns()).toEqual(["color", "image_urls"]);
    expect(await indexes()).toEqual(["retail_product_variants_product_color_size_unique"]);
  });

  it("is a no-op when run again", async () => {
    await ensureRetailVariantSchema(pool);
    expect(await columns()).toEqual(["color", "image_urls"]);
    expect(await indexes()).toEqual(["retail_product_variants_product_color_size_unique"]);
  });
});
