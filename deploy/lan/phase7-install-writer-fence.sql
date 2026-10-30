-- Phase 7 database write fence (DBA/maintenance-window installation ONLY).
-- NEVER run casually on a live cloud database. After installation, all covered
-- business writes are FENCED until a privileged DBA explicitly opens an epoch.
--
-- A different DBA-owned role MUST own public tables, this schema and the
-- function. The ERP application role MUST NOT be superuser, have BYPASSRLS,
-- own any public table, be member of owner roles, or hold schema/database CREATE.
-- Stop app instances, scheduler, websocket jobs and integrations before installing.
-- This does not replace proof that a trusted cloud snapshot was restored to LAN.
BEGIN;
CREATE SCHEMA IF NOT EXISTS phase7_writer;
REVOKE ALL ON SCHEMA phase7_writer FROM PUBLIC;

CREATE TABLE IF NOT EXISTS phase7_writer.state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  mode text NOT NULL CHECK (mode IN ('fenced', 'cloud-primary', 'lan-primary')),
  site_id text NOT NULL,
  epoch bigint NOT NULL CHECK (epoch >= 0),
  baseline_sha256 text NOT NULL CHECK (baseline_sha256 ~ '^[0-9a-f]{64}$'),
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON phase7_writer.state FROM PUBLIC;
-- Installation is always fail-closed. Explicitly opening an epoch is a separate
-- owner-controlled step, after role isolation and out-of-band cloud fencing proof.
INSERT INTO phase7_writer.state(singleton, mode, site_id, epoch, baseline_sha256)
VALUES (true, 'fenced', 'unassigned', 0, repeat('0', 64))
ON CONFLICT (singleton) DO NOTHING;

CREATE OR REPLACE FUNCTION phase7_writer.assert_current_epoch()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, phase7_writer
AS $phase7$
DECLARE
  authority record;
BEGIN
  -- Lock is held until transaction COMMIT/ROLLBACK. A DBA changing the epoch or
  -- fencing the site must wait for all in-flight guarded transactions, including
  -- workers and direct SQL, before the state transition can commit.
  SELECT mode, site_id, epoch INTO authority
    FROM phase7_writer.state WHERE singleton = true FOR SHARE;
  IF NOT FOUND OR authority.mode = 'fenced'
     OR authority.mode IS DISTINCT FROM current_setting('phase7_writer.mode', true)
     OR authority.site_id IS DISTINCT FROM current_setting('phase7_writer.site_id', true)
     OR authority.epoch::text IS DISTINCT FROM current_setting('phase7_writer.epoch', true)
  THEN
    RAISE EXCEPTION 'PHASE7_WRITER_EPOCH_FENCED' USING ERRCODE = '55000';
  END IF;
  RETURN NULL; -- BEFORE STATEMENT trigger return value is ignored by PostgreSQL.
END
$phase7$;
REVOKE ALL ON FUNCTION phase7_writer.assert_current_epoch() FROM PUBLIC;

-- All current ordinary/partitioned public tables except the ephemeral HTTP
-- session store. Session writes are intentionally outside the BUSINESS fence:
-- they must never be interpreted as a voucher/stock write permission.
-- Re-run in a maintenance window after EVERY schema change; the runtime
-- verifier blocks LAN-primary if any table lacks the guard.
DO $phase7$
DECLARE
  relation record;
BEGIN
  FOR relation IN
    SELECT n.nspname AS ns, c.relname AS tbl
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
      AND c.relname NOT IN ('session')
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS phase7_writer_fence ON %I.%I', relation.ns, relation.tbl);
    EXECUTE format(
      'CREATE TRIGGER phase7_writer_fence BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON %I.%I FOR EACH STATEMENT EXECUTE FUNCTION phase7_writer.assert_current_epoch()',
      relation.ns, relation.tbl
    );
  END LOOP;
END
$phase7$;
COMMIT;

-- DBA ONLY (separate reviewed transaction, not part of this script):
--   GRANT USAGE ON SCHEMA phase7_writer TO <restricted_app_role>;
--   GRANT SELECT ON phase7_writer.state TO <restricted_app_role>;
--   UPDATE phase7_writer.state SET mode='cloud-primary', site_id='cloud',
--     epoch=<approved_epoch>, baseline_sha256='<approved_digest>',
--     changed_at=clock_timestamp() WHERE singleton;
-- A cloud handoff first updates mode='fenced' and waits for COMMIT.
-- The LAN epoch must be greater than the fenced cloud epoch and only opened
-- after a separately verified data+uploads restore and human approval.
-- FAILBACK requires LAN freeze, complete sync/reconciliation and a fresh cloud
-- epoch; never open two independent databases at once.
