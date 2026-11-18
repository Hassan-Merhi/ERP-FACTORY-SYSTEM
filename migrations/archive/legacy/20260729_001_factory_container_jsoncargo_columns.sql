-- Factory container creation repair (2026-07-29)
--
-- Drizzle generates INSERT statements that enumerate every column declared on
-- shared/schema/factory.ts, using DEFAULT for omitted values. These JSONCargo
-- fields were declared in the schema but never added to the production table.
-- Production runs with RUN_STARTUP_MIGRATIONS=false, so the missing first field
-- (json_cargo_last_checked_at) caused every new factory-container INSERT to fail.

BEGIN;
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '90s';

ALTER TABLE factory_containers
  ADD COLUMN IF NOT EXISTS json_cargo_last_checked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS json_cargo_tracking_status TEXT,
  ADD COLUMN IF NOT EXISTS json_cargo_error TEXT;

COMMIT;
