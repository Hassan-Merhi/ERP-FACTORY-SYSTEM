-- Permissions Control Center V2 — ADDITIVE follow-up to
-- 20261024_001_permissions_control_center_shadow.sql.
-- REVIEW AND APPLY MANUALLY AFTER BACKUP, after the shadow migration.
-- Never executes from application startup.
--
-- Lets the append-only policy audit record company policy mode changes
-- (shadow / active / rolled_back) as subject_type 'policy_mode'. No row is
-- rewritten, no rule or mode is changed, and existing role/user audit rows
-- stay valid under the widened check. Idempotent.
BEGIN;

ALTER TABLE access_policy_change_audit
  DROP CONSTRAINT IF EXISTS access_policy_change_audit_subject_type_check;
ALTER TABLE access_policy_change_audit
  ADD CONSTRAINT access_policy_change_audit_subject_type_check
  CHECK (subject_type IN ('role', 'user', 'policy_mode'));

COMMIT;
