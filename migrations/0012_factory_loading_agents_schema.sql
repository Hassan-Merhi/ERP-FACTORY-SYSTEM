-- 0012_factory_loading_agents_schema.sql
--
-- Add the factory loading-agent reference table and customer-order agent field
-- to the authoritative migration registry. Previously these were documented
-- only as a manual TablePlus pre-deploy SQL script, so a fresh migrated CI
-- database lacked customer_orders.agent_name and related customer-order write
-- routes failed at runtime.
--
-- Additive only: no existing order, amount, voucher or inventory row changes.
-- Indexes follow the existing manual SQL contract in
-- docs/sql/factory-loading-agents-tableplus.sql.

CREATE TABLE IF NOT EXISTS factory_loading_agents (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL,
  name VARCHAR(200) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT factory_loading_agents_name_not_blank CHECK (length(btrim(name)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS factory_loading_agents_company_name_ci_uniq
  ON factory_loading_agents (company_id, lower(name));

CREATE INDEX IF NOT EXISTS factory_loading_agents_company_idx
  ON factory_loading_agents (company_id);

ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS agent_name VARCHAR(200);
