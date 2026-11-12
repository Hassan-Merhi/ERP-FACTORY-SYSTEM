#!/usr/bin/env bash
# Permissions Control Center V2 — staging migration and data certification.
#
# OPERATOR TOOL. Run only against an approved STAGING database. It refuses to
# run without explicit approval and refuses anything that looks like
# production. Every step writes evidence to $CERT_OUT_DIR.
#
# Steps:
#   1. safety checks (approval, typed database name, production refusal);
#   2. pg_dump backup of staging, restored into a SCRATCH database and compared
#      table by table with staging (proves the backup can be restored);
#   3. baseline snapshot: per company, row count and md5 of every business and
#      permission table, plus voucher debit/credit totals;
#   4. applies migrations/20261024_001_permissions_control_center_shadow.sql and
#      migrations/20261107_001_permissions_v2_policy_mode_audit.sql;
#   5. verifies the five access_* tables, FORCE row-level security, the
#      company-scope policies, both triggers and the audit subject check; with
#      STAGING_APP_ROLE set, also verifies RLS isolation as the service role;
#   6. after snapshot; any difference in business or permission data fails;
#   7. rollback drill on the SCRATCH copy: applies the migrations there,
#      activates and rolls back a company policy with audit rows, and proves
#      business data is unchanged, then restores SCRATCH from the backup and
#      proves it matches the baseline again.
#
# Nothing here drops a table, deletes audit rows or changes business data on
# staging. The additive migrations stay applied on staging (the approved target
# state). A production database is never touched.
#
# Required environment:
#   STAGING_DATABASE_URL          staging connection string (superuser or owner)
#   SCRATCH_DATABASE_URL          an EMPTY disposable database for the restore drill
#   PERMISSIONS_STAGING_APPROVED  must be "yes" (written approval exists)
#   CONFIRM_DATABASE_NAME         must equal the staging database name
# Optional:
#   PRODUCTION_DATABASE_URL       if set, refused when it matches staging
#   STAGING_APP_ROLE              the application's non-superuser role, for RLS checks
#   CERT_OUT_DIR                  evidence directory (default ./permissions-staging-evidence-<utc>)
#   CERT_MODE=rehearsal           allow a local non-staging database for a dry run;
#                                 the evidence is marked REHEARSAL and is NOT staging evidence
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SHADOW_SQL="$ROOT/migrations/20261024_001_permissions_control_center_shadow.sql"
MODE_SQL="$ROOT/migrations/20261107_001_permissions_v2_policy_mode_audit.sql"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${CERT_OUT_DIR:-$PWD/permissions-staging-evidence-$STAMP}"
MODE="${CERT_MODE:-staging}"

die() { echo "REFUSED  $1" >&2; exit 2; }
fail() { echo "FAIL  $1" | tee -a "$OUT/result.log" >&2; exit 1; }
pass() { echo "PASS  $1" | tee -a "$OUT/result.log"; }
note() { echo "NOTE  $1" | tee -a "$OUT/result.log"; }

# ── 1. Safety checks ────────────────────────────────────────────────────────
[[ -n "${STAGING_DATABASE_URL:-}" ]] || die "STAGING_DATABASE_URL is not set"
[[ -n "${SCRATCH_DATABASE_URL:-}" ]] || die "SCRATCH_DATABASE_URL is not set (an empty disposable database)"
[[ "${PERMISSIONS_STAGING_APPROVED:-}" == "yes" ]] || die "PERMISSIONS_STAGING_APPROVED=yes is required (record the approval first)"
[[ "$STAGING_DATABASE_URL" != "$SCRATCH_DATABASE_URL" ]] || die "SCRATCH_DATABASE_URL must differ from STAGING_DATABASE_URL"
if [[ -n "${PRODUCTION_DATABASE_URL:-}" && "$PRODUCTION_DATABASE_URL" == "$STAGING_DATABASE_URL" ]]; then
  die "STAGING_DATABASE_URL equals PRODUCTION_DATABASE_URL"
fi
for tool in psql pg_dump pg_restore; do command -v "$tool" >/dev/null || die "$tool is not installed"; done

PSQL_OPTS=(-X -q -v ON_ERROR_STOP=1)
STAGING=(psql "${PSQL_OPTS[@]}" "$STAGING_DATABASE_URL")
SCRATCH=(psql "${PSQL_OPTS[@]}" "$SCRATCH_DATABASE_URL")

db_name="$("${STAGING[@]}" -At -c "SELECT current_database()")"
[[ "${CONFIRM_DATABASE_NAME:-}" == "$db_name" ]] || die "CONFIRM_DATABASE_NAME must equal the connected database name ($db_name)"
if [[ "$db_name" =~ [Pp][Rr][Oo][Dd] ]]; then die "database name '$db_name' looks like production"; fi
if [[ -n "${PRODUCTION_DATABASE_URL:-}" ]]; then
  prod_id="$(psql "${PSQL_OPTS[@]}" "$PRODUCTION_DATABASE_URL" -At -c "SELECT system_identifier::text || ':' || current_database() FROM pg_control_system()" 2>/dev/null || true)"
  stag_id="$("${STAGING[@]}" -At -c "SELECT system_identifier::text || ':' || current_database() FROM pg_control_system()" 2>/dev/null || true)"
  [[ -z "$prod_id" || "$prod_id" != "$stag_id" ]] || die "staging and production are the same cluster and database"
fi
scratch_tables="$("${SCRATCH[@]}" -At -c "SELECT count(*) FROM pg_tables WHERE schemaname='public'")"
[[ "$scratch_tables" == "0" ]] || die "SCRATCH_DATABASE_URL is not empty ($scratch_tables tables)"

mkdir -p "$OUT"
: > "$OUT/result.log"
{
  echo "mode=$MODE"
  echo "started_utc=$STAMP"
  echo "database=$db_name"
  echo "server_version=$("${STAGING[@]}" -At -c 'SHOW server_version')"
  echo "commit=$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
  echo "operator=${USER:-unknown}"
} > "$OUT/context.txt"
if [[ "$MODE" == "rehearsal" ]]; then
  note "REHEARSAL run on '$db_name': this evidence is NOT staging certification"
fi
pass "safety checks: approval recorded, database name confirmed, not production, scratch database empty"

# ── Snapshot helper ─────────────────────────────────────────────────────────
SNAPSHOT_TABLES=(
  vouchers voucher_entries ledger_accounts suppliers customers stock_items inventory
  inventory_value_movements canonical_stock_movements retail_variant_inventory retail_stock_movements
  bales factory_bales production_bales bale_transfers containers factory_containers container_sales
  factory_payrolls erp_payroll_runs employee_bonuses worker_bonuses factory_target_bonus_payments
  employee_attendance factory_attendance property_units property_contracts property_payments
  fiscal_period_closures role_feature_permissions user_company_roles user_security_permissions
  erp_user_page_access
)

snapshot() {
  # $1 = psql connection array name, $2 = output file
  local -n conn="$1"
  local out="$2"
  : > "$out"
  for table in "${SNAPSHOT_TABLES[@]}"; do
    local has_company
    has_company="$("${conn[@]}" -At -c "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='$table' AND column_name='company_id'")"
    if [[ "$has_company" == "1" ]]; then
      "${conn[@]}" -At -F $'\t' -c "BEGIN READ ONLY; SELECT set_config('app.company_scope_maintenance','on',true);
        SELECT '$table', company_id, count(*), md5(string_agg(t::text, '|' ORDER BY t::text)) FROM $table t GROUP BY company_id ORDER BY company_id; COMMIT;" \
        | { grep -v -E '^(BEGIN|COMMIT|on)?$' || true; } >> "$out"
    else
      local exists
      exists="$("${conn[@]}" -At -c "SELECT to_regclass('public.$table') IS NOT NULL")"
      if [[ "$exists" == "t" ]]; then
        "${conn[@]}" -At -F $'\t' -c "BEGIN READ ONLY; SELECT set_config('app.company_scope_maintenance','on',true);
          SELECT '$table', '-', count(*), coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)),'') FROM $table t; COMMIT;" \
          | { grep -v -E '^(BEGIN|COMMIT|on)?$' || true; } >> "$out"
      fi
    fi
  done
  local has_debit
  has_debit="$("${conn[@]}" -At -c "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='voucher_entries' AND column_name IN ('debit','credit','company_id')")"
  if [[ "$has_debit" == "3" ]]; then
    "${conn[@]}" -At -F $'\t' -c "BEGIN READ ONLY; SELECT set_config('app.company_scope_maintenance','on',true);
      SELECT 'voucher_entry_totals', company_id, sum(debit)::text, sum(credit)::text FROM voucher_entries GROUP BY company_id ORDER BY company_id; COMMIT;" \
      | { grep -v -E '^(BEGIN|COMMIT|on)?$' || true; } >> "$out"
  fi
  sort -o "$out" "$out"
}

# Fail loudly instead of exiting silently when a step returns non-zero.
trap 'echo "FAIL  unexpected error at line $LINENO" | tee -a "$OUT/result.log" >&2' ERR

# ── 2. Backup and verified restore ──────────────────────────────────────────
snapshot STAGING "$OUT/baseline.tsv"
[[ -s "$OUT/baseline.tsv" ]] || fail "baseline snapshot is empty"
pass "baseline snapshot: $(wc -l < "$OUT/baseline.tsv") table/company rows recorded"

pg_dump -Fc --no-owner --no-privileges -f "$OUT/staging-backup.dump" "$STAGING_DATABASE_URL" || fail "pg_dump failed"
sha256sum "$OUT/staging-backup.dump" > "$OUT/staging-backup.dump.sha256"
pg_restore --no-owner --no-privileges --exit-on-error -d "$SCRATCH_DATABASE_URL" "$OUT/staging-backup.dump" \
  > "$OUT/restore.log" 2>&1 || fail "backup could not be restored into SCRATCH (see restore.log)"
snapshot SCRATCH "$OUT/restored.tsv"
diff -u "$OUT/baseline.tsv" "$OUT/restored.tsv" > "$OUT/restore.diff" || fail "restored backup differs from staging (see restore.diff)"
pass "backup restored into SCRATCH and matches staging exactly (sha256 $(cut -c1-16 "$OUT/staging-backup.dump.sha256"))"

# ── 3/4. Apply the reviewed additive migrations ─────────────────────────────
scope_fn="$("${STAGING[@]}" -At -c "SELECT count(*) FROM pg_proc WHERE proname='erp_company_scope_matches'")"
[[ "$scope_fn" != "0" ]] || fail "erp_company_scope_matches() is missing; apply migrations/0016 first"
"${STAGING[@]}" -f "$SHADOW_SQL" > "$OUT/migration-shadow.log" 2>&1 || fail "shadow migration failed (rolled back; see migration-shadow.log)"
"${STAGING[@]}" -f "$MODE_SQL" > "$OUT/migration-mode-audit.log" 2>&1 || fail "policy mode audit migration failed (see migration-mode-audit.log)"
pass "applied 20261024_001 and 20261107_001"

# ── 5. Structure, RLS and audit protection ──────────────────────────────────
q() { "${STAGING[@]}" -At -c "$1"; }
[[ "$(q "SELECT count(*) FROM pg_tables WHERE tablename IN ('access_role_templates','access_role_rules','access_user_overrides','access_policy_versions','access_policy_change_audit')")" == "5" ]] \
  || fail "expected the five access_* tables"
[[ "$(q "SELECT count(*) FROM pg_class WHERE relname LIKE 'access\_%' AND relkind='r' AND relrowsecurity AND relforcerowsecurity")" == "5" ]] \
  || fail "FORCE row-level security is not on all five access_* tables"
[[ "$(q "SELECT count(*) FROM pg_policies WHERE policyname='access_company_scope'")" == "5" ]] || fail "company-scope policy missing"
[[ "$(q "SELECT count(*) FROM pg_trigger WHERE tgname IN ('access_override_company_guard_trg','access_policy_audit_append_only_trg')")" == "2" ]] \
  || fail "override or append-only audit trigger missing"
q "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='access_policy_change_audit_subject_type_check'" | grep -q "policy_mode" \
  || fail "audit subject_type check does not accept policy_mode"
pass "five access_* tables with FORCE RLS, company-scope policies, both triggers and the policy_mode audit check"

if [[ -n "${STAGING_APP_ROLE:-}" ]]; then
  # Probe rows are inserted inside transactions that always ROLL BACK, so
  # staging keeps no policy rows from this check.
  probe_insert="INSERT INTO access_policy_versions(company_id, revision, mode) SELECT id, 0, 'shadow' FROM companies ORDER BY id LIMIT 2 ON CONFLICT (company_id) DO NOTHING;"
  probe_companies="$(q "SELECT count(*) FROM (SELECT id FROM companies ORDER BY id LIMIT 2) c")"
  [[ "$probe_companies" -ge 1 ]] || fail "no companies to probe row-level security with"
  unscoped="$("${STAGING[@]}" -At -c "BEGIN; $probe_insert SET LOCAL ROLE \"$STAGING_APP_ROLE\"; SELECT 'visible=' || count(*) FROM access_policy_versions; ROLLBACK;" 2>&1 || true)"
  if grep -q '^visible=' <<<"$unscoped" && ! grep -q '^visible=0$' <<<"$unscoped"; then
    fail "the service role read policy rows without a company scope ($unscoped)"
  fi
  first_company="$(q "SELECT min(id) FROM companies")"
  scoped="$("${STAGING[@]}" -At -c "BEGIN; $probe_insert SET LOCAL ROLE \"$STAGING_APP_ROLE\"; SELECT set_config('app.current_company_id','$first_company',true); SELECT 'own=' || count(*) FILTER (WHERE company_id = $first_company) || ' other=' || count(*) FILTER (WHERE company_id <> $first_company) FROM access_policy_versions; ROLLBACK;" 2>&1 || true)"
  grep -q "^own=1 other=0$" <<<"$scoped" || fail "service role company scope wrong ($scoped)"
  leftover="$(q "SELECT count(*) FROM access_policy_versions WHERE revision = 0 AND updated_by IS NULL")"
  pass "RLS as service role '$STAGING_APP_ROLE': unscoped sees no rows, a scoped session sees only its own company (probes rolled back, $leftover left)"
else
  note "STAGING_APP_ROLE not set: RLS isolation as the service role NOT verified on staging"
fi

# ── 6. Business and permission data unchanged ───────────────────────────────
snapshot STAGING "$OUT/after.tsv"
diff -u "$OUT/baseline.tsv" "$OUT/after.tsv" > "$OUT/after.diff" || fail "business or permission data changed (see after.diff)"
pass "business balances, stock, containers, payroll, rentals and existing permissions unchanged"

# ── 7. Rollback drill on the disposable SCRATCH copy ────────────────────────
"${SCRATCH[@]}" -f "$SHADOW_SQL" >/dev/null 2>&1 || fail "shadow migration failed on SCRATCH"
"${SCRATCH[@]}" -f "$MODE_SQL" >/dev/null 2>&1 || fail "mode audit migration failed on SCRATCH"
drill_company="$("${SCRATCH[@]}" -At -c "SELECT min(id) FROM companies")"
drill_actor="$("${SCRATCH[@]}" -At -c "SELECT user_id FROM user_company_roles WHERE company_id=$drill_company AND role IN ('Admin','Developer') ORDER BY id LIMIT 1")"
[[ -n "$drill_company" && -n "$drill_actor" ]] || fail "no company administrator available for the rollback drill"
"${SCRATCH[@]}" > "$OUT/rollback-drill.log" 2>&1 <<SQL || fail "rollback drill failed (see rollback-drill.log)"
BEGIN;
SELECT set_config('app.current_company_id', '$drill_company', true);
INSERT INTO access_policy_versions(company_id, revision, mode, updated_by) VALUES ($drill_company, 0, 'shadow', '$drill_actor')
  ON CONFLICT (company_id) DO NOTHING;
UPDATE access_policy_versions SET mode='active', revision=revision+1, updated_by='$drill_actor' WHERE company_id=$drill_company;
INSERT INTO access_policy_change_audit(company_id, revision, actor_id, subject_type, subject_key, before_rules, after_rules, reason)
  SELECT $drill_company, revision, '$drill_actor', 'policy_mode', 'active',
         '[{"resource":"policy","action":"mode","decision":"shadow"}]', '[{"resource":"policy","action":"mode","decision":"active"}]',
         'Staging rollback drill: activate' FROM access_policy_versions WHERE company_id=$drill_company;
UPDATE access_policy_versions SET mode='rolled_back', revision=revision+1, updated_by='$drill_actor' WHERE company_id=$drill_company;
INSERT INTO access_policy_change_audit(company_id, revision, actor_id, subject_type, subject_key, before_rules, after_rules, reason)
  SELECT $drill_company, revision, '$drill_actor', 'policy_mode', 'rolled_back',
         '[{"resource":"policy","action":"mode","decision":"active"}]', '[{"resource":"policy","action":"mode","decision":"rolled_back"}]',
         'Staging rollback drill: roll back' FROM access_policy_versions WHERE company_id=$drill_company;
COMMIT;
SQL
mode_now="$("${SCRATCH[@]}" -At -c "BEGIN; SELECT set_config('app.current_company_id','$drill_company',true); SELECT mode FROM access_policy_versions WHERE company_id=$drill_company; COMMIT;" | grep -E '^(shadow|active|rolled_back)$')"
[[ "$mode_now" == "rolled_back" ]] || fail "drill company is not rolled back ($mode_now)"
if "${SCRATCH[@]}" -c "BEGIN; SELECT set_config('app.current_company_id','$drill_company',true); DELETE FROM access_policy_change_audit WHERE company_id=$drill_company; COMMIT;" >/dev/null 2>&1; then
  fail "audit rows could be deleted during the rollback drill"
fi
snapshot SCRATCH "$OUT/drill-after.tsv"
diff -u "$OUT/baseline.tsv" "$OUT/drill-after.tsv" > "$OUT/drill.diff" || fail "rollback drill changed business data (see drill.diff)"
pass "rollback drill on SCRATCH: activate then roll back, audit preserved and append-only, business data unchanged"

"${SCRATCH[@]}" -c "SET client_min_messages = warning; DROP SCHEMA public CASCADE; CREATE SCHEMA public;" >/dev/null
pg_restore --no-owner --no-privileges --exit-on-error -d "$SCRATCH_DATABASE_URL" "$OUT/staging-backup.dump" >/dev/null 2>&1 \
  || fail "second restore into SCRATCH failed"
snapshot SCRATCH "$OUT/restored-again.tsv"
diff -u "$OUT/baseline.tsv" "$OUT/restored-again.tsv" > "$OUT/restored-again.diff" || fail "second restore differs from the baseline"
pass "database restore drill: SCRATCH restored from the backup again and matches the baseline"

note "staging keeps the additive migrations applied (approved target state); no V2 company is active"
echo "finished_utc=$(date -u +%Y%m%dT%H%M%SZ)" >> "$OUT/context.txt"
echo "Evidence written to $OUT"
