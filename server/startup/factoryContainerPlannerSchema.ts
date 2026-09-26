import type { PoolClient } from "pg";

/**
 * Factory Container Planner schema, ensured on every boot.
 *
 * The planner tables were authored as registered versioned migrations
 * (migrations/20260921_001 and 20260922_001..003), but production never runs the
 * versioned runner and can boot with RUN_STARTUP_MIGRATIONS=false, so the
 * tables were never created there and every planner request failed with
 * `relation "factory_container_plans" does not exist`. These statements mirror
 * those migration files (minus their BEGIN/COMMIT/SET LOCAL wrappers) and are
 * all idempotent, so boot converges on fresh, upgraded and already-migrated
 * databases alike.
 */

// Draft plans, per-container locks and quantity lines. Mirrors migrations/20260921_001_factory_container_planner_phase2.sql.
const PHASE2_SQL = `
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
`;

// Physical bale assignment. Mirrors migrations/20260922_001_factory_container_planner_phase4.sql.
const PHASE4_SQL = `
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
`;

// Customer/product allocations. Mirrors migrations/20260922_002_factory_container_planner_phase5.sql.
const PHASE5_SQL = `
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
`;

// Shipment lifecycle, timeline and documents. Mirrors migrations/20260922_003_factory_container_planner_phase6.sql.
const PHASE6_SQL = `
ALTER TABLE factory_container_plan_containers
  ADD COLUMN IF NOT EXISTS lifecycle_status TEXT NOT NULL DEFAULT 'PLANNED',
  ADD COLUMN IF NOT EXISTS container_number VARCHAR(60),
  ADD COLUMN IF NOT EXISTS carrier VARCHAR(120),
  ADD COLUMN IF NOT EXISTS booking_number VARCHAR(60),
  ADD COLUMN IF NOT EXISTS vessel_name VARCHAR(120),
  ADD COLUMN IF NOT EXISTS destination VARCHAR(160),
  ADD COLUMN IF NOT EXISTS etd DATE,
  ADD COLUMN IF NOT EXISTS eta DATE,
  ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS status_changed_by VARCHAR(100);

CREATE INDEX IF NOT EXISTS factory_container_plan_containers_lifecycle_idx
  ON factory_container_plan_containers(company_id, lifecycle_status);

CREATE TABLE IF NOT EXISTS factory_container_plan_container_events (
  id                 SERIAL PRIMARY KEY,
  company_id         INTEGER NOT NULL,
  plan_id            INTEGER NOT NULL REFERENCES factory_container_plans(id) ON DELETE CASCADE,
  plan_container_id  INTEGER NOT NULL REFERENCES factory_container_plan_containers(id) ON DELETE CASCADE,
  from_status        TEXT,
  to_status          TEXT NOT NULL,
  note               TEXT,
  created_by         VARCHAR(100),
  created_by_name    TEXT,
  created_at         TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS factory_container_plan_container_events_container_idx
  ON factory_container_plan_container_events(plan_container_id, created_at);

CREATE TABLE IF NOT EXISTS factory_container_plan_documents (
  id                 SERIAL PRIMARY KEY,
  company_id         INTEGER NOT NULL,
  plan_id            INTEGER NOT NULL REFERENCES factory_container_plans(id) ON DELETE CASCADE,
  plan_container_id  INTEGER NOT NULL REFERENCES factory_container_plan_containers(id) ON DELETE CASCADE,
  document_type      TEXT NOT NULL,
  title              TEXT NOT NULL,
  reference          VARCHAR(120),
  file_url           TEXT,
  issued_on          DATE,
  uploaded_by        VARCHAR(100),
  uploaded_by_name   TEXT,
  created_at         TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS factory_container_plan_documents_container_idx
  ON factory_container_plan_documents(plan_container_id, document_type);
`;

// Phase order matters: later phases reference the plan and container tables.
export const factoryContainerPlannerSchema: readonly string[] = [PHASE2_SQL, PHASE4_SQL, PHASE5_SQL, PHASE6_SQL];

type StartupPool = { connect: () => Promise<Pick<PoolClient, "query" | "release">> };

export async function ensureFactoryContainerPlannerSchema(pool: StartupPool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '15s'");
    await client.query("SET LOCAL statement_timeout = '90s'");
    for (const statement of factoryContainerPlannerSchema) await client.query(statement);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Boot-time wrapper: retries transient failures (a lock timeout while another
 * instance is still serving) and then rethrows, so startup fails and the
 * previous deployment stays live instead of a new one going healthy without
 * the planner tables.
 */
export async function ensureFactoryContainerPlannerSchemaOnBoot(
  pool: StartupPool,
  { attempts = 3, backoffMs = [2_000, 5_000] }: { attempts?: number; backoffMs?: readonly number[] } = {}
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await ensureFactoryContainerPlannerSchema(pool);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        const delay = backoffMs[Math.min(attempt - 1, backoffMs.length - 1)] ?? 0;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
}
