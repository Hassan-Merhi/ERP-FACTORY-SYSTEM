-- Phase 7: DBA-only PREPARATION of an unprivileged application role.
-- Use on an isolated rehearsal database first, with an approved maintenance plan.
-- Never run against live cloud/LAN while a business writer is active.
-- This does NOT enable LAN-primary, migrate app startup DDL or perform cutover.
--
-- The role is intentionally NOLOGIN. A DBA must configure a DIFFERENT login
-- password through the secret manager and change the application connection,
-- after removing all startup DDL and running restricted-role integration tests.
-- Neither this script nor source control stores credentials.
BEGIN;
DO $phase7$
BEGIN
  IF to_regclass('phase7_writer.state') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_event_trigger
                     WHERE evtname='phase7_writer_guard_ddl' AND evtenabled='O')
  THEN
    RAISE EXCEPTION 'PHASE7_FENCE_NOT_INSTALLED';
  END IF;
  IF EXISTS (SELECT 1 FROM phase7_writer.state
             WHERE singleton AND mode <> 'fenced')
     OR NOT EXISTS (SELECT 1 FROM phase7_writer.state
                    WHERE singleton AND mode='fenced')
  THEN
    RAISE EXCEPTION 'PHASE7_ROLE_SETUP_REQUIRES_FENCED_STATE';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p')
      AND c.relname <> 'session'
      AND NOT EXISTS (SELECT 1 FROM pg_trigger t
        WHERE t.tgrelid=c.oid AND t.tgname='phase7_writer_fence'
          AND t.tgenabled='O' AND NOT t.tgisinternal)
  ) THEN
    RAISE EXCEPTION 'PHASE7_ROLE_SETUP_UNGUARDED_TABLE';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='erp_edge_runtime') THEN
    CREATE ROLE erp_edge_runtime NOLOGIN NOSUPERUSER NOCREATEDB
      NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
END
$phase7$;

-- Public CREATE grants from legacy PostgreSQL clusters would make runtime DDL
-- possible even if not explicitly granted to the new role.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
DO $phase7$
BEGIN
  EXECUTE format('REVOKE CREATE ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO erp_edge_runtime', current_database());
END
$phase7$;

GRANT USAGE ON SCHEMA public TO erp_edge_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO erp_edge_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO erp_edge_runtime;
GRANT USAGE ON SCHEMA phase7_writer TO erp_edge_runtime;
GRANT SELECT ON phase7_writer.state TO erp_edge_runtime;
-- Deliberately NO TRUNCATE, REFERENCES, TRIGGER, CREATE, ownership, schema
-- modification, future-table default privileges or state UPDATE grant.
-- Re-audit after every DDL migration before making a role LOGIN.
COMMIT;
