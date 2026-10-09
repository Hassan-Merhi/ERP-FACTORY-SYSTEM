/**
 * Priority Scan Wave 1 schema foundation.
 *
 * Production can run with RUN_STARTUP_MIGRATIONS=false, while CI creates the
 * same table from the Drizzle schema. Keep this additive ensure idempotent so a
 * deployment never serves Priority Scan configuration routes before the table
 * and uniqueness boundaries exist.
 */
export const PRIORITY_SCAN_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS customer_order_priority_scan_configs (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL,
      order_id INTEGER NOT NULL REFERENCES customer_orders(id) ON DELETE CASCADE,
      color VARCHAR(64) NOT NULL,
      color_key VARCHAR(64) NOT NULL,
      priority INTEGER NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_by VARCHAR(100),
      created_by_name TEXT,
      updated_by VARCHAR(100),
      updated_by_name TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT now(),
      updated_at TIMESTAMP NOT NULL DEFAULT now(),
      CONSTRAINT copsc_priority_positive CHECK (priority > 0)
    )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS copsc_company_order_unique
     ON customer_order_priority_scan_configs(company_id, order_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS copsc_active_color_unique
     ON customer_order_priority_scan_configs(company_id, color_key)
     WHERE enabled = TRUE`,
  `CREATE UNIQUE INDEX IF NOT EXISTS copsc_active_priority_unique
     ON customer_order_priority_scan_configs(company_id, priority)
     WHERE enabled = TRUE`,
  `CREATE INDEX IF NOT EXISTS copsc_company_enabled_priority_idx
     ON customer_order_priority_scan_configs(company_id, enabled, priority)`,
  `CREATE TABLE IF NOT EXISTS factory_priority_scan_history (
      id BIGSERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL,
      order_id INTEGER NOT NULL,
      bale_id INTEGER NOT NULL,
      reference_number VARCHAR(100) NOT NULL,
      product_name TEXT,
      article_code VARCHAR(50),
      priority INTEGER NOT NULL,
      color VARCHAR(64) NOT NULL,
      business_date DATE NOT NULL,
      scanned_by TEXT,
      scanned_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
  `CREATE INDEX IF NOT EXISTS fpsh_company_date_scanned_idx
     ON factory_priority_scan_history(company_id, business_date, scanned_at DESC, id DESC)`,
  `ALTER TABLE factory_priority_scan_history
     ADD COLUMN IF NOT EXISTS allocation_source VARCHAR(32) NOT NULL DEFAULT 'manual'`,
  `ALTER TABLE factory_priority_scan_history
     ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ`,
  `CREATE TABLE IF NOT EXISTS factory_priority_auto_allocations (
      id BIGSERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL,
      bale_id INTEGER NOT NULL REFERENCES factory_bales(id),
      order_id INTEGER NOT NULL REFERENCES customer_orders(id),
      reference_number VARCHAR(100) NOT NULL,
      priority INTEGER NOT NULL,
      color VARCHAR(64) NOT NULL,
      allocation_source VARCHAR(32) NOT NULL,
      allocated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      reversed_at TIMESTAMPTZ,
      reversed_by TEXT,
      reversal_reason TEXT
    )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS fpaa_company_bale_active_unique
     ON factory_priority_auto_allocations(company_id, bale_id)
     WHERE reversed_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS fpaa_company_order_active_idx
     ON factory_priority_auto_allocations(company_id, order_id)
     WHERE reversed_at IS NULL`,
] as const;

type StartupQueryable = {
  query: (queryText: string) => Promise<unknown>;
};

export async function ensurePriorityScanSchema(database: StartupQueryable): Promise<void> {
  for (const statement of PRIORITY_SCAN_SCHEMA_SQL) {
    await database.query(statement);
  }
}
