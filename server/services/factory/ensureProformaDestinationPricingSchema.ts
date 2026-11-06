/**
 * Additive, always-on schema guard for proforma destination-specific pricing.
 * Historical proforma lines and legacy customer agreed-price lists stay intact.
 */
import type { Pool } from "pg";

export async function ensureProformaDestinationPricingSchema(pool: Pool): Promise<void> {
  await pool.query(`
    ALTER TABLE customer_proformas
      ADD COLUMN IF NOT EXISTS destination TEXT;

    CREATE TABLE IF NOT EXISTS customer_destination_price_lists (
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      destination TEXT NOT NULL,
      article_code VARCHAR(50) NOT NULL,
      price_per_bale NUMERIC(20,2) NOT NULL CHECK (price_per_bale > 0),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (company_id, customer_id, destination, article_code),
      CONSTRAINT cdpl_destination_not_blank CHECK (length(trim(destination)) > 0)
    );
    CREATE INDEX IF NOT EXISTS customer_destination_price_lists_customer_idx
      ON customer_destination_price_lists (company_id, customer_id, destination);
  `);
}
