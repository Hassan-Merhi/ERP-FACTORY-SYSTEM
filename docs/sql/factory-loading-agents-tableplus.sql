-- Run in TablePlus against the intended ERP + Factory PostgreSQL database BEFORE deploying.
-- No existing loadings or accounting data are modified.
BEGIN;
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
COMMIT;
-- Verification:
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'customer_orders' AND column_name = 'agent_name';
-- SELECT company_id, name FROM factory_loading_agents ORDER BY company_id, name;
