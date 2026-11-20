-- 0012_factory_loading_agents.sql
--
-- Factory Invoices: reusable loading agents (#3360). That change added
-- customer_orders.agent_name to the application schema and the
-- factory_loading_agents table its routes read and write
-- (server/routes/factory/customer-orders/registerOrderCrudRoutesPart3.ts), but
-- shipped them only as a hand-run script
-- (docs/sql/factory-loading-agents-tableplus.sql). This migration applies the
-- same statements, so every database the migrations build (tests, fresh
-- installs, deploys) has them. Every statement is IF NOT EXISTS: on a database
-- where the script was already run, nothing changes.
--
-- Additive only: one new table with its indexes, and one nullable column. No
-- existing row is read or changed.

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
