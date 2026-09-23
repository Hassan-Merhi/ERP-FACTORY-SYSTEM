-- Factory Container Planner Phase 4
-- Physical bale reservation/assignment for saved container plans.
BEGIN;
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '90s';

CREATE TABLE IF NOT EXISTS factory_container_plan_bales (
  id                 SERIAL PRIMARY KEY,
  company_id         INTEGER NOT NULL,
  plan_id            INTEGER NOT NULL REFERENCES factory_container_plans(id) ON DELETE CASCADE,
  plan_container_id  INTEGER NOT NULL REFERENCES factory_container_plan_containers(id) ON DELETE CASCADE,
  bale_id            INTEGER NOT NULL,
  article_code       VARCHAR(100) NOT NULL,
  bale_code          VARCHAR(100) NOT NULL,
  reference_number   VARCHAR(100) NOT NULL,
  product_name       TEXT NOT NULL,
  weight_kg          DECIMAL(15,3) NOT NULL DEFAULT 0,
  assigned_via       TEXT NOT NULL DEFAULT 'MANUAL',
  assigned_by        VARCHAR(100),
  assigned_by_name   TEXT,
  created_at         TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS factory_container_plan_bales_bale_unique
  ON factory_container_plan_bales(company_id, bale_id);

CREATE INDEX IF NOT EXISTS factory_container_plan_bales_container_idx
  ON factory_container_plan_bales(plan_container_id, article_code);

CREATE INDEX IF NOT EXISTS factory_container_plan_bales_plan_idx
  ON factory_container_plan_bales(company_id, plan_id);

COMMIT;
