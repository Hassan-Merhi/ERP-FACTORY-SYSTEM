-- Factory Container Planner Phase 6
-- Shipment lifecycle, timeline, and shipping-document metadata.
BEGIN;
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '90s';

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

COMMIT;
