-- Permission Control Center Phase 2 — ADDITIVE, SHADOW-ONLY.
-- REVIEW AND APPLY MANUALLY AFTER BACKUP. Never executes from application startup.
-- Depends on erp_company_scope_matches(company_id) and existing companies/users tables.
-- No vouchers, stock, accounts, or live role_feature_permissions are rewritten.
BEGIN;

CREATE TABLE IF NOT EXISTS access_role_templates (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  role_key TEXT NOT NULL CHECK(length(btrim(role_key)) BETWEEN 2 AND 80),
  display_name TEXT NOT NULL CHECK(length(btrim(display_name)) BETWEEN 2 AND 100),
  system_managed BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(company_id, role_key),
  UNIQUE(company_id, id)
);

CREATE TABLE IF NOT EXISTS access_role_rules (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  role_id BIGINT NOT NULL,
  resource_key TEXT NOT NULL CHECK(length(btrim(resource_key)) BETWEEN 3 AND 120),
  action_key TEXT NOT NULL CHECK(length(btrim(action_key)) BETWEEN 2 AND 80),
  decision TEXT NOT NULL CHECK(decision IN ('allow', 'deny', 'inherit')),
  updated_by VARCHAR NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT access_role_rules_template_fk FOREIGN KEY(company_id, role_id)
    REFERENCES access_role_templates(company_id, id) ON DELETE RESTRICT,
  UNIQUE(company_id, role_id, resource_key, action_key)
);

CREATE TABLE IF NOT EXISTS access_user_overrides (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  user_id VARCHAR NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  resource_key TEXT NOT NULL CHECK(length(btrim(resource_key)) BETWEEN 3 AND 120),
  action_key TEXT NOT NULL CHECK(length(btrim(action_key)) BETWEEN 2 AND 80),
  decision TEXT NOT NULL CHECK(decision IN ('allow', 'deny', 'inherit')),
  updated_by VARCHAR NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(company_id, user_id, resource_key, action_key)
);

CREATE TABLE IF NOT EXISTS access_policy_versions (
  company_id INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE RESTRICT,
  revision BIGINT NOT NULL DEFAULT 0 CHECK(revision >= 0),
  mode TEXT NOT NULL DEFAULT 'shadow' CHECK(mode IN ('shadow', 'active', 'rolled_back')),
  updated_by VARCHAR REFERENCES users(id) ON DELETE RESTRICT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS access_policy_change_audit (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  revision BIGINT NOT NULL CHECK(revision > 0),
  actor_id VARCHAR NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  subject_type TEXT NOT NULL CHECK(subject_type IN ('role', 'user')),
  subject_key TEXT NOT NULL CHECK(length(btrim(subject_key)) BETWEEN 1 AND 120),
  before_rules JSONB NOT NULL,
  after_rules JSONB NOT NULL,
  reason TEXT NOT NULL CHECK(length(btrim(reason)) BETWEEN 10 AND 500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(company_id, revision)
);

CREATE INDEX IF NOT EXISTS access_role_templates_company_idx
  ON access_role_templates(company_id);
CREATE INDEX IF NOT EXISTS access_role_rules_company_role_idx
  ON access_role_rules(company_id, role_id);
CREATE INDEX IF NOT EXISTS access_user_overrides_company_user_idx
  ON access_user_overrides(company_id, user_id);
CREATE INDEX IF NOT EXISTS access_policy_change_audit_company_created_idx
  ON access_policy_change_audit(company_id, created_at DESC);

-- All five stores remain strictly restricted to the active DB company.
-- FORCE RLS also protects application table-owner connections.
DO $access_rls$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'access_role_templates','access_role_rules','access_user_overrides',
    'access_policy_versions','access_policy_change_audit'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS access_company_scope ON %I', table_name);
    EXECUTE format(
      'CREATE POLICY access_company_scope ON %I
       USING (erp_company_scope_matches(company_id))
       WITH CHECK (erp_company_scope_matches(company_id))', table_name
    );
  END LOOP;
END $access_rls$;

-- FK(user_id) verifies identity; this extra guard binds the override to a
-- role assignment IN THE SAME COMPANY even if there are historic duplicates.
CREATE OR REPLACE FUNCTION access_override_company_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $access_override_guard$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM user_company_roles ucr
     WHERE ucr.user_id = NEW.user_id AND ucr.company_id = NEW.company_id
  ) THEN
    RAISE EXCEPTION 'ACCESS_OVERRIDE_COMPANY_ROLE_REQUIRED' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $access_override_guard$;
DROP TRIGGER IF EXISTS access_override_company_guard_trg ON access_user_overrides;
CREATE TRIGGER access_override_company_guard_trg
BEFORE INSERT OR UPDATE OF company_id, user_id ON access_user_overrides
FOR EACH ROW EXECUTE FUNCTION access_override_company_guard();

-- An audit entry can be appended only; UPDATE/DELETE is prohibited, even in
-- rollback attempts made through an ordinary application session.
CREATE OR REPLACE FUNCTION access_policy_audit_append_only()
RETURNS TRIGGER LANGUAGE plpgsql AS $access_audit_guard$
BEGIN
  RAISE EXCEPTION 'ACCESS_POLICY_AUDIT_APPEND_ONLY' USING ERRCODE = '23514';
END $access_audit_guard$;
DROP TRIGGER IF EXISTS access_policy_audit_append_only_trg ON access_policy_change_audit;
CREATE TRIGGER access_policy_audit_append_only_trg
BEFORE UPDATE OR DELETE ON access_policy_change_audit
FOR EACH ROW EXECUTE FUNCTION access_policy_audit_append_only();

COMMIT;
