-- 0012_factory_loading_agents.sql
--
-- Reusable loading agents on Factory Invoices (#3360). That change shipped its
-- schema only as docs/sql/factory-loading-agents-tableplus.sql, so databases
-- built from migrations (CI, fresh installs, db:deploy) had neither the agent
-- list nor customer_orders.agent_name, and every customer-order query failed.
-- Owner decision 2026-11-20: add it as a migration.
--
-- The statements match the TablePlus file exactly and are idempotent, so this
-- is a no-op on a database where that file was already run.
--
-- Additive only: one new table, its indexes, and one nullable column. No
-- existing row is changed.

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
