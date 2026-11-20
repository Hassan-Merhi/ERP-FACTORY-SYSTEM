-- 0012_factory_loading_agents.sql
--
-- REQUIRES OWNER SIGN-OFF (schema change that every deploy applies).
--
-- Factory Invoices gained reusable loading agents in #3360. That change added
-- customer_orders.agent_name to shared/schema and reads and writes a
-- factory_loading_agents table, but shipped its DDL only as a manual script
-- (docs/sql/factory-loading-agents-tableplus.sql). A database built from
-- migrations therefore had neither object, and every query that selects
-- customer_orders failed with "column agent_name does not exist".
--
-- This is that script's DDL, unchanged, without its BEGIN/COMMIT (the runner
-- owns the transaction). Every statement is IF NOT EXISTS, so it is a no-op on
-- a database where the manual script has already been run.
--
-- Additive only: one new table with two indexes, and one nullable column. No
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
