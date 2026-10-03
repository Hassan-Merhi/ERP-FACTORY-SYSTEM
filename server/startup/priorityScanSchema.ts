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
] as const;

type StartupQueryable = {
  query: (queryText: string) => Promise<unknown>;
};

export async function ensurePriorityScanSchema(database: StartupQueryable): Promise<void> {
  for (const statement of PRIORITY_SCAN_SCHEMA_SQL) {
    await database.query(statement);
  }
}
