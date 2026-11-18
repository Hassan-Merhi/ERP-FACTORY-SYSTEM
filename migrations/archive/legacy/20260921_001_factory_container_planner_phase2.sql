-- Factory Container Planner Phase 2
-- Persistent draft plans, per-container locks, and quantity allocations.
-- These tables are planning-only and do not reserve physical bale IDs.
BEGIN;
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '90s';

CREATE TABLE IF NOT EXISTS factory_container_plans (
  id                       SERIAL PRIMARY KEY,
  company_id               INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name                     TEXT NOT NULL,
  status                   TEXT NOT NULL DEFAULT 'DRAFT',
  capacity_bales           INTEGER NOT NULL,
  include_garbage_wipers   BOOLEAN NOT NULL DEFAULT false,
  source_stock_total       INTEGER NOT NULL DEFAULT 0,
  source_committed_total   INTEGER NOT NULL DEFAULT 0,
  source_loading_total     INTEGER NOT NULL DEFAULT 0,
  source_plannable_total   INTEGER NOT NULL DEFAULT 0,
  client_request_id        VARCHAR(100),
  revision                 INTEGER NOT NULL DEFAULT 1,
  created_by               VARCHAR(100),
  created_by_name          TEXT,
  created_at               TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT factory_container_plans_capacity_positive CHECK (capacity_bales > 0),
  CONSTRAINT factory_container_plans_status_check CHECK (status IN ('DRAFT', 'READY'))
);

CREATE UNIQUE INDEX IF NOT EXISTS factory_container_plans_request_unique
  ON factory_container_plans(company_id, client_request_id);

CREATE INDEX IF NOT EXISTS factory_container_plans_company_updated_idx
  ON factory_container_plans(company_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS factory_container_plan_containers (
  id              SERIAL PRIMARY KEY,
  company_id      INTEGER NOT NULL,
  plan_id         INTEGER NOT NULL REFERENCES factory_container_plans(id) ON DELETE CASCADE,
  position        INTEGER NOT NULL,
  name            TEXT NOT NULL,
  capacity_bales  INTEGER NOT NULL,
  is_locked       BOOLEAN NOT NULL DEFAULT false,
  locked_at       TIMESTAMP,
  locked_by       VARCHAR(100),
  locked_by_name  TEXT,
  created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT factory_container_plan_containers_capacity_positive CHECK (capacity_bales > 0),
  CONSTRAINT factory_container_plan_containers_position_nonnegative CHECK (position >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS factory_container_plan_containers_position_unique
  ON factory_container_plan_containers(plan_id, position);

CREATE INDEX IF NOT EXISTS factory_container_plan_containers_company_idx
  ON factory_container_plan_containers(company_id, plan_id);

CREATE TABLE IF NOT EXISTS factory_container_plan_lines (
  id                 SERIAL PRIMARY KEY,
  company_id         INTEGER NOT NULL,
  plan_id            INTEGER NOT NULL REFERENCES factory_container_plans(id) ON DELETE CASCADE,
  plan_container_id  INTEGER NOT NULL REFERENCES factory_container_plan_containers(id) ON DELETE CASCADE,
  article_code       VARCHAR(100) NOT NULL,
  product_name       TEXT NOT NULL,
  planned_qty        INTEGER NOT NULL,
  created_at         TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT factory_container_plan_lines_qty_nonnegative CHECK (planned_qty >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS factory_container_plan_lines_article_unique
  ON factory_container_plan_lines(plan_container_id, article_code);

CREATE INDEX IF NOT EXISTS factory_container_plan_lines_company_plan_idx
  ON factory_container_plan_lines(company_id, plan_id);

COMMIT;
