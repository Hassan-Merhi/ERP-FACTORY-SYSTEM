-- 0012_factory_loading_agents.sql
--
-- Factory Invoices: reusable loading agents (per company) and the agent chosen
-- on a customer order. The application has read customer_orders.agent_name and
-- factory_loading_agents since that feature shipped, but the objects were only
-- ever created by hand (docs/sql/factory-loading-agents-tableplus.sql). A
-- database built from these migrations therefore lacked them, and every read
-- of customer_orders failed.
--
-- Additive and idempotent: a database where the manual script was already run
-- is left exactly as it is. No existing row is read or changed.

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
