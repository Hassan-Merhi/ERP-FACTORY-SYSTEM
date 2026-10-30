/**
 * Loading-only requested article supplements.
 *
 * Unconditional boot ensure: production may skip the bulk startup migration
 * array. These rows are never inserted into customer_proforma_lines.
 */
import type { Pool } from "pg";

export async function ensureContainerExtraExpectedLines(pool: Pick<Pool, "query">): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customer_order_extra_expected_lines (
      id BIGSERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL,
      order_id INTEGER NOT NULL REFERENCES customer_orders(id) ON DELETE CASCADE,
      article_code VARCHAR(100) NOT NULL,
      product_name TEXT NOT NULL,
      expected_qty INTEGER NOT NULL CHECK (expected_qty > 0 AND expected_qty <= 100000),
      price_per_bale NUMERIC(18,4) NOT NULL CHECK (price_per_bale >= 0),
      created_at TIMESTAMP NOT NULL DEFAULT now(),
      updated_at TIMESTAMP NOT NULL DEFAULT now(),
      CONSTRAINT customer_order_extra_expected_lines_unique
        UNIQUE (company_id, order_id, article_code)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS customer_order_extra_expected_lines_order_idx
    ON customer_order_extra_expected_lines(company_id, order_id)
  `);
}
