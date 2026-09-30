import type { Pool } from "pg";

export async function ensureHistoricalSalesCostRepairSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS historical_sales_cost_repair_runs (
      id BIGSERIAL PRIMARY KEY,
      algorithm_version TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('building','blocked','ready','applying','applied','failed')),
      source_cutoff_at TIMESTAMPTZ NOT NULL,
      requested_company_ids INTEGER[],
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      applied_by TEXT,
      applied_at TIMESTAMPTZ,
      audit_hash VARCHAR(64),
      total_sales_rows INTEGER NOT NULL DEFAULT 0,
      changed_rows INTEGER NOT NULL DEFAULT 0,
      blocked_rows INTEGER NOT NULL DEFAULT 0,
      blocked_item_locations INTEGER NOT NULL DEFAULT 0,
      original_total_cost NUMERIC(24,2) NOT NULL DEFAULT 0,
      proposed_total_cost NUMERIC(24,2) NOT NULL DEFAULT 0,
      original_total_profit NUMERIC(24,2) NOT NULL DEFAULT 0,
      proposed_total_profit NUMERIC(24,2) NOT NULL DEFAULT 0,
      report JSONB NOT NULL DEFAULT '{}'::jsonb,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS historical_sales_cost_repair_rows (
      id BIGSERIAL PRIMARY KEY,
      run_id BIGINT NOT NULL REFERENCES historical_sales_cost_repair_runs(id) ON DELETE RESTRICT,
      company_id INTEGER NOT NULL,
      location_id INTEGER NOT NULL,
      stock_item_id INTEGER NOT NULL,
      voucher_id INTEGER NOT NULL,
      sales_item_id INTEGER NOT NULL,
      occurred_at TIMESTAMPTZ NOT NULL,
      evidence TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      original_cost_price NUMERIC(24,2) NOT NULL,
      original_total_cost NUMERIC(24,2) NOT NULL,
      original_profit NUMERIC(24,2) NOT NULL,
      proposed_cost_price NUMERIC(24,2) NOT NULL,
      proposed_total_cost NUMERIC(24,2) NOT NULL,
      proposed_profit NUMERIC(24,2) NOT NULL,
      changed BOOLEAN NOT NULL DEFAULT FALSE,
      status TEXT NOT NULL CHECK (status IN ('ready','blocked','applied','unchanged')),
      blocker_code TEXT,
      blocker_detail TEXT,
      applied_at TIMESTAMPTZ,
      UNIQUE (run_id, sales_item_id)
    );

    CREATE INDEX IF NOT EXISTS historical_sales_cost_repair_rows_run_status_idx
      ON historical_sales_cost_repair_rows(run_id, status);
    CREATE INDEX IF NOT EXISTS historical_sales_cost_repair_rows_company_idx
      ON historical_sales_cost_repair_rows(run_id, company_id);
    CREATE INDEX IF NOT EXISTS historical_sales_cost_repair_rows_sale_idx
      ON historical_sales_cost_repair_rows(sales_item_id);

    CREATE TABLE IF NOT EXISTS historical_sales_cost_repair_checks (
      id BIGSERIAL PRIMARY KEY,
      run_id BIGINT NOT NULL REFERENCES historical_sales_cost_repair_runs(id) ON DELETE RESTRICT,
      company_id INTEGER NOT NULL,
      location_id INTEGER,
      stock_item_id INTEGER,
      check_code TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pass','block','warning')),
      expected_value TEXT,
      actual_value TEXT,
      detail TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS historical_sales_cost_repair_checks_run_idx
      ON historical_sales_cost_repair_checks(run_id, status, company_id);

    CREATE TABLE IF NOT EXISTS historical_sales_cost_repair_apply_log (
      id BIGSERIAL PRIMARY KEY,
      run_id BIGINT NOT NULL REFERENCES historical_sales_cost_repair_runs(id) ON DELETE RESTRICT,
      company_id INTEGER NOT NULL,
      sales_item_id INTEGER NOT NULL,
      before_cost_price NUMERIC(24,2) NOT NULL,
      before_total_cost NUMERIC(24,2) NOT NULL,
      before_profit NUMERIC(24,2) NOT NULL,
      after_cost_price NUMERIC(24,2) NOT NULL,
      after_total_cost NUMERIC(24,2) NOT NULL,
      after_profit NUMERIC(24,2) NOT NULL,
      applied_by TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (run_id, sales_item_id)
    );
  `);
}
