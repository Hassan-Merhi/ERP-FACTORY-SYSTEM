#!/usr/bin/env bash
# Isolated validation of migrations/20261024_001_permissions_control_center_shadow.sql
# and its additive follow-up migrations/20261107_001_permissions_v2_policy_mode_audit.sql.
#
# Creates a THROWAWAY PostgreSQL cluster in a temporary directory (never a
# configured DATABASE_URL), installs the application's real company-scope
# functions from migrations/0016_company_scope_rls_readiness.sql and the base
# tables the migration references, then checks:
#   1. the migration is atomic: with a missing dependency it fails and leaves no table;
#   2. it applies cleanly and is idempotent (second run succeeds, nothing duplicated);
#   3. FORCE row-level security isolates companies for a non-superuser table owner;
#   4. a user override needs a role assignment in the same company;
#   5. the change audit is append-only (UPDATE and DELETE refused);
#   6. vouchers and live role_feature_permissions are byte-for-byte unchanged;
#   7. the follow-up migration is idempotent and lets the audit record policy
#      mode changes while still refusing unknown subject types.
#
# This is NOT the staging gate: it proves the SQL's behaviour on PostgreSQL 16,
# not the production schema, data volume or service role. See
# docs/permissions-control-center-activation.md for the staging procedure.
#
# Usage: scripts/permissions/validate-shadow-migration.sh   (needs initdb/pg_ctl/psql)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MIGRATION="$ROOT/migrations/20261024_001_permissions_control_center_shadow.sql"
MODE_AUDIT_MIGRATION="$ROOT/migrations/20261107_001_permissions_v2_policy_mode_audit.sql"
SCOPE_SQL="$ROOT/migrations/0016_company_scope_rls_readiness.sql"
PG_BIN="${PG_BIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
[[ -x "$PG_BIN/initdb" ]] || { echo "initdb not found; set PG_BIN" >&2; exit 2; }

WORK="$(mktemp -d)"
PORT="${VALIDATION_PG_PORT:-55439}"
cleanup() {
  "$PG_BIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# initdb/postgres refuse to run as root; use an unprivileged account when needed.
RUN=()
if [[ "$(id -u)" == "0" ]]; then
  chown -R postgres "$WORK" 2>/dev/null || { echo "running as root needs a 'postgres' OS user" >&2; exit 2; }
  RUN=(runuser -u postgres --)
fi

"${RUN[@]}" "$PG_BIN/initdb" -D "$WORK/data" -U validator -A trust >/dev/null
"${RUN[@]}" "$PG_BIN/pg_ctl" -D "$WORK/data" -o "-p $PORT -k $WORK -c listen_addresses=''" -l "$WORK/pg.log" -w start >/dev/null
export PGOPTIONS="-c client_min_messages=warning"
PSQL=(psql -X -q -v ON_ERROR_STOP=1 -h "$WORK" -p "$PORT" -U validator)
"${PSQL[@]}" -d postgres -c "CREATE DATABASE shadow_validation" >/dev/null
DB=("${PSQL[@]}" -d shadow_validation)

pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1" >&2; exit 1; }

# Base tables referenced by the migration, plus business tables it must not touch.
"${DB[@]}" <<'SQL'
CREATE TABLE companies (id integer PRIMARY KEY, name text NOT NULL);
CREATE TABLE users (id varchar PRIMARY KEY, username text NOT NULL);
CREATE TABLE user_company_roles (id serial PRIMARY KEY, user_id varchar NOT NULL, company_id integer NOT NULL, role text NOT NULL);
CREATE TABLE vouchers (id serial PRIMARY KEY, company_id integer NOT NULL, amount numeric(20,2) NOT NULL);
CREATE TABLE role_feature_permissions (id serial PRIMARY KEY, company_id integer NOT NULL, role text NOT NULL, feature_key text NOT NULL, enabled boolean NOT NULL);
INSERT INTO companies VALUES (1, 'Company A'), (2, 'Company B');
INSERT INTO users VALUES ('admin-a', 'admin_a'), ('clerk-a', 'clerk_a'), ('clerk-b', 'clerk_b');
INSERT INTO user_company_roles (user_id, company_id, role) VALUES
  ('admin-a', 1, 'Admin'), ('clerk-a', 1, 'Create Only'), ('clerk-b', 2, 'Manager');
INSERT INTO vouchers (company_id, amount) VALUES (1, 100.00), (1, 250.50), (2, 75.25);
INSERT INTO role_feature_permissions (company_id, role, feature_key, enabled) VALUES
  (1, 'Manager', 'page_vouchers', true), (2, 'Normal User', 'page_suppliers', false);
SQL

BUSINESS_SNAPSHOT="SELECT md5(string_agg(t::text, '|' ORDER BY t::text)) FROM (SELECT 'v' AS k, v::text AS t FROM vouchers v UNION ALL SELECT 'r', r::text FROM role_feature_permissions r) s"
before="$("${DB[@]}" -At -c "$BUSINESS_SNAPSHOT")"

# 1. Atomic: without the scope functions the migration must fail as a whole.
if "${DB[@]}" -f "$MIGRATION" >/dev/null 2>"$WORK/atomic.err"; then
  fail "migration applied without erp_company_scope_matches"
fi
remaining="$("${DB[@]}" -At -c "SELECT count(*) FROM pg_tables WHERE tablename LIKE 'access_%'")"
[[ "$remaining" == "0" ]] || fail "a failed run left $remaining access_* tables behind"
pass "atomic: a failed run rolls back completely (no access_* tables left)"

# Install the application's real company-scope functions (0016, up to the
# function used by the shadow policies).
awk '/^CREATE OR REPLACE FUNCTION erp_company_scope_matches/{f=1} {print} f && /^\$company_scope_match\$;/{exit}' "$SCOPE_SQL" > "$WORK/scope.sql"
"${DB[@]}" -f "$WORK/scope.sql" >/dev/null

# 2. Applies and is idempotent.
"${DB[@]}" -f "$MIGRATION" >/dev/null || fail "migration did not apply"
"${DB[@]}" -f "$MIGRATION" >/dev/null || fail "second run of the migration failed"
tables="$("${DB[@]}" -At -c "SELECT count(*) FROM pg_tables WHERE tablename IN ('access_role_templates','access_role_rules','access_user_overrides','access_policy_versions','access_policy_change_audit')")"
[[ "$tables" == "5" ]] || fail "expected 5 shadow tables, found $tables"
forced="$("${DB[@]}" -At -c "SELECT count(*) FROM pg_class WHERE relname LIKE 'access_%' AND relkind='r' AND relrowsecurity AND relforcerowsecurity")"
[[ "$forced" == "5" ]] || fail "expected FORCE RLS on 5 tables, found $forced"
policies="$("${DB[@]}" -At -c "SELECT count(*) FROM pg_policies WHERE policyname='access_company_scope'")"
[[ "$policies" == "5" ]] || fail "expected 5 company-scope policies, found $policies (duplicated on re-run?)"
pass "applies cleanly, is idempotent, and forces RLS with one policy on each of the 5 tables"

# 3. Company isolation for a non-superuser owner (FORCE RLS applies to owners).
"${DB[@]}" <<'SQL' >/dev/null
CREATE ROLE app_runtime LOGIN NOSUPERUSER NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO app_runtime;
GRANT SELECT ON companies, users, user_company_roles TO app_runtime;
DO $own$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['access_role_templates','access_role_rules','access_user_overrides','access_policy_versions','access_policy_change_audit'] LOOP
    EXECUTE format('ALTER TABLE %I OWNER TO app_runtime', t);
  END LOOP;
  FOR t IN SELECT sequencename FROM pg_sequences WHERE sequencename LIKE 'access_%' LOOP
    EXECUTE format('ALTER SEQUENCE %I OWNER TO app_runtime', t);
  END LOOP;
END $own$;
SQL
APP=(psql -X -q -v ON_ERROR_STOP=1 -h "$WORK" -p "$PORT" -U app_runtime -d shadow_validation)

"${APP[@]}" <<'SQL' >/dev/null
BEGIN;
SELECT set_config('app.current_company_id', '1', true);
INSERT INTO access_policy_versions (company_id, revision, mode, updated_by) VALUES (1, 1, 'shadow', 'admin-a');
INSERT INTO access_role_templates (company_id, role_key, display_name) VALUES (1, 'Create Only', 'Create Only');
COMMIT;
BEGIN;
SELECT set_config('app.company_scope_maintenance', 'on', true);
INSERT INTO access_policy_versions (company_id, revision, mode, updated_by) VALUES (2, 4, 'shadow', 'admin-a');
COMMIT;
SQL

visible="$("${APP[@]}" -At -c "SET app.current_company_id = '1'" -c "SELECT string_agg(company_id::text, ',' ORDER BY company_id) FROM access_policy_versions")"
[[ "$visible" == "1" ]] || fail "company 1 session saw policy rows for companies: $visible"
if "${APP[@]}" -c "BEGIN; SELECT set_config('app.current_company_id','1',true); INSERT INTO access_role_templates (company_id, role_key, display_name) VALUES (2, 'Manager', 'Manager'); COMMIT;" >/dev/null 2>&1; then
  fail "company 1 session wrote a company 2 template"
fi
if "${APP[@]}" -c "BEGIN; SELECT set_config('app.current_company_id','1',true); UPDATE access_policy_versions SET mode='active' WHERE company_id=2; COMMIT;" >/dev/null 2>&1; then :; fi
mode2="$("${DB[@]}" -At -c "SELECT mode FROM access_policy_versions WHERE company_id=2")"
[[ "$mode2" == "shadow" ]] || fail "company 1 session changed company 2's policy mode to $mode2"
if "${APP[@]}" -c "SELECT count(*) FROM access_policy_versions" >/dev/null 2>&1; then
  fail "a session without app.current_company_id could read policy rows"
fi
pass "RLS isolates companies for a non-superuser owner; missing tenant identity fails closed"

# 4. Overrides require a role assignment in the same company.
if "${APP[@]}" -c "BEGIN; SELECT set_config('app.current_company_id','1',true); INSERT INTO access_user_overrides (company_id, user_id, resource_key, action_key, decision, updated_by) VALUES (1, 'clerk-b', 'erp.suppliers', 'create', 'allow', 'admin-a'); COMMIT;" >/dev/null 2>"$WORK/override.err"; then
  fail "override accepted for a user with no role in the company"
fi
grep -q "ACCESS_OVERRIDE_COMPANY_ROLE_REQUIRED" "$WORK/override.err" || fail "override refusal did not name ACCESS_OVERRIDE_COMPANY_ROLE_REQUIRED"
"${APP[@]}" -c "BEGIN; SELECT set_config('app.current_company_id','1',true); INSERT INTO access_user_overrides (company_id, user_id, resource_key, action_key, decision, updated_by) VALUES (1, 'clerk-a', 'erp.suppliers', 'create', 'allow', 'admin-a'); COMMIT;" >/dev/null
pass "user overrides require a role assignment in the same company"

# 5. Audit is append-only.
"${APP[@]}" -c "BEGIN; SELECT set_config('app.current_company_id','1',true); INSERT INTO access_policy_change_audit (company_id, revision, actor_id, subject_type, subject_key, before_rules, after_rules, reason) VALUES (1, 1, 'admin-a', 'role', 'Create Only', '[]', '[]', 'Validation audit row'); COMMIT;" >/dev/null
for statement in "UPDATE access_policy_change_audit SET reason='Rewritten history row' WHERE company_id=1" "DELETE FROM access_policy_change_audit WHERE company_id=1"; do
  if "${APP[@]}" -c "BEGIN; SELECT set_config('app.current_company_id','1',true); $statement; COMMIT;" >/dev/null 2>"$WORK/audit.err"; then
    fail "audit accepted: $statement"
  fi
  grep -q "ACCESS_POLICY_AUDIT_APPEND_ONLY" "$WORK/audit.err" || fail "audit refusal did not name ACCESS_POLICY_AUDIT_APPEND_ONLY"
done
pass "policy change audit refuses UPDATE and DELETE"

# 5b. Follow-up migration: idempotent, widens the audit subject check only.
"${DB[@]}" -f "$MODE_AUDIT_MIGRATION" >/dev/null || fail "policy mode audit migration did not apply"
"${DB[@]}" -f "$MODE_AUDIT_MIGRATION" >/dev/null || fail "second run of the policy mode audit migration failed"
checks="$("${DB[@]}" -At -c "SELECT count(*) FROM pg_constraint WHERE conname='access_policy_change_audit_subject_type_check'")"
[[ "$checks" == "1" ]] || fail "expected one subject_type check after re-run, found $checks"
"${APP[@]}" -c "BEGIN; SELECT set_config('app.current_company_id','1',true); INSERT INTO access_policy_change_audit (company_id, revision, actor_id, subject_type, subject_key, before_rules, after_rules, reason) VALUES (1, 900, 'admin-a', 'policy_mode', 'shadow', '[]', '[]', 'Validation mode audit row'); COMMIT;" >/dev/null || fail "policy_mode audit row refused"
if "${APP[@]}" -c "BEGIN; SELECT set_config('app.current_company_id','1',true); INSERT INTO access_policy_change_audit (company_id, revision, actor_id, subject_type, subject_key, before_rules, after_rules, reason) VALUES (1, 901, 'admin-a', 'anything', 'x', '[]', '[]', 'Validation bad subject row'); COMMIT;" >/dev/null 2>&1; then
  fail "audit accepted an unknown subject_type"
fi
existing="$("${DB[@]}" -At -c "SELECT count(*) FROM access_policy_change_audit WHERE subject_type='role'")"
[[ "$existing" == "1" ]] || fail "existing role audit rows changed ($existing)"
pass "policy mode audit migration is idempotent, accepts policy_mode and still refuses unknown subjects"

# 6. Business data unchanged.
after="$("${DB[@]}" -At -c "$BUSINESS_SNAPSHOT")"
[[ "$before" == "$after" ]] || fail "vouchers or role_feature_permissions changed"
pass "vouchers and live role_feature_permissions are unchanged (md5 $after)"

# 7. The application's own store against the migrated database (needs node + tsx).
if [[ "${SKIP_STORE_CHECK:-0}" != "1" && -x "$ROOT/node_modules/.bin/tsx" ]]; then
  "${DB[@]}" -c "GRANT SELECT ON user_company_roles, users, companies, role_feature_permissions TO app_runtime" >/dev/null
  (cd "$ROOT" && DATABASE_URL="postgresql://app_runtime@localhost:$PORT/shadow_validation?host=$WORK" \
    PGSSLMODE=disable NODE_ENV=test node_modules/.bin/tsx scripts/permissions/store-concurrency-check.ts) || fail "store checks failed"
fi

final="$("${DB[@]}" -At -c "$BUSINESS_SNAPSHOT")"
[[ "$before" == "$final" ]] || fail "business data changed during the store checks"
pass "business data still unchanged after the store checks"

echo "Shadow migration validation passed on $("${DB[@]}" -At -c 'SHOW server_version')."
