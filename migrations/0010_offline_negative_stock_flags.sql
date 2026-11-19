-- 0010_offline_negative_stock_flags.sql
--
-- Full offline mode (Phase B2). Owner decision 2026-11-17: stock sold twice
-- while PCs were offline goes negative and is flagged; flags may stay open at
-- month end. When the cloud applies a PC's offline entry that takes stock below
-- zero, it applies it anyway and records one row here for an Admin or Developer
-- to review and close.
--
-- Additive only: one new table and its indexes. No existing row is changed.

CREATE TABLE IF NOT EXISTS offline_negative_stock_flags (
  id serial PRIMARY KEY,
  company_id integer NOT NULL REFERENCES companies(id),
  device_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  kind text NOT NULL,
  conflict_code text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  cloud_ref integer,
  created_by varchar NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by varchar,
  resolution_note text,
  CONSTRAINT offline_negative_stock_flags_operation_unique UNIQUE (device_id, operation_id),
  CONSTRAINT offline_negative_stock_flags_resolution_check
    CHECK ((resolved_at IS NULL) = (resolved_by IS NULL))
);

CREATE INDEX IF NOT EXISTS offline_negative_stock_flags_open_idx
  ON offline_negative_stock_flags (company_id, created_at)
  WHERE resolved_at IS NULL;
