-- Factory Container Planner Phase 5
-- Customer/product allocations inside planned containers.
BEGIN;
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '90s';

CREATE TABLE IF NOT EXISTS factory_container_plan_allocations (
  id                 SERIAL PRIMARY KEY,
  company_id         INTEGER NOT NULL,
  plan_id            INTEGER NOT NULL REFERENCES factory_container_plans(id) ON DELETE CASCADE,
  plan_container_id  INTEGER NOT NULL REFERENCES factory_container_plan_containers(id) ON DELETE CASCADE,
  customer_id        INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  order_id           INTEGER,
  article_code       VARCHAR(100) NOT NULL,
  product_name       TEXT NOT NULL,
  allocated_qty      INTEGER NOT NULL,
  notes              TEXT,
  created_by         VARCHAR(100),
  created_by_name    TEXT,
  created_at         TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT factory_container_plan_allocations_qty_nonnegative CHECK (allocated_qty >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS factory_container_plan_allocations_unique
  ON factory_container_plan_allocations(plan_container_id, customer_id, article_code);

CREATE INDEX IF NOT EXISTS factory_container_plan_allocations_plan_idx
  ON factory_container_plan_allocations(company_id, plan_id);

CREATE INDEX IF NOT EXISTS factory_container_plan_allocations_customer_idx
  ON factory_container_plan_allocations(company_id, customer_id);

COMMIT;
