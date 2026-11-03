#!/usr/bin/env bash
# Phase 7 disposable PostgreSQL integration contract; never touch live databases.
set -euo pipefail
container="erp-phase7-fence-test-$$"
trap 'docker rm -f "$container" >/dev/null 2>&1 || true' EXIT
docker run -d --name "$container" \
  -e POSTGRES_PASSWORD=only-a-disposable-ci-password postgres:17-bookworm >/dev/null

ready=0
for _ in $(seq 1 35); do
  if docker exec "$container" pg_isready -U postgres -d postgres >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [[ "$ready" != 1 ]]; then echo 'PostgreSQL did not start' >&2; exit 1; fi

admin() {
  docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres "$@"
}
app() {
  local epoch="${1}"
  local sql="${2}"
  docker exec -e PGPASSWORD=phase7-test-app-password \
    -e "PGOPTIONS=-c phase7_writer.mode=cloud-primary -c phase7_writer.site_id=cloud -c phase7_writer.epoch=$epoch" \
    "$container" psql -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -U phase7_app -d postgres -c "$sql"
}
reject_app() {
  local epoch="$1" query="$2"
  if app "$epoch" "$query" >/dev/null 2>&1; then
    echo "WRITER FENCE BYPASSED: query succeeded while blocked" >&2
    exit 1
  fi
}

admin <<'SQL'
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE ROLE phase7_app LOGIN PASSWORD 'phase7-test-app-password';
GRANT CONNECT ON DATABASE postgres TO phase7_app;
GRANT USAGE ON SCHEMA public TO phase7_app;
CREATE TABLE public.phase7_test_business(id integer PRIMARY KEY);
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON public.phase7_test_business TO phase7_app;
SQL

docker cp deploy/lan/phase7-install-writer-fence.sql "$container":/tmp/phase7.sql
docker exec "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres -f /tmp/phase7.sql >/dev/null
admin <<'SQL'
GRANT USAGE ON SCHEMA phase7_writer TO phase7_app;
GRANT SELECT ON phase7_writer.state TO phase7_app;
SQL

# DBA-only role preparation must fail without an installed FENCED write guard.
# The role starts NOLOGIN: even after grants, it cannot be used until a DBA
# deliberately provisions a separate secret and completes startup-DDL migration.
docker cp deploy/lan/phase7-prepare-restricted-role.sql "$container":/tmp/phase7-role.sql
admin -f /tmp/phase7-role.sql >/dev/null
[[ "$(admin -At -c "SELECT rolcanlogin FROM pg_roles WHERE rolname='erp_edge_runtime'")" == f ]]
# Idempotence in the same fenced rehearsal.
admin -f /tmp/phase7-role.sql >/dev/null
admin -c "ALTER ROLE erp_edge_runtime LOGIN PASSWORD 'phase7-test-runtime-password'" >/dev/null
runtime() {
  local epoch="$1" sql="$2"
  docker exec -e PGPASSWORD=phase7-test-runtime-password \
    -e "PGOPTIONS=-c phase7_writer.mode=cloud-primary -c phase7_writer.site_id=cloud -c phase7_writer.epoch=$epoch" \
    "$container" psql -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -U erp_edge_runtime -d postgres -c "$sql"
}
reject_runtime() {
  if runtime "$1" "$2" >/dev/null 2>&1; then
    echo "PHASE7_RESTRICTED_RUNTIME_BYPASS: $2" >&2
    exit 1
  fi
}
runtime 1 'SELECT id FROM public.phase7_test_business' >/dev/null
reject_runtime 1 'INSERT INTO public.phase7_test_business(id) VALUES (6)'
reject_runtime 1 'CREATE TABLE public.phase7_rogue(id integer)'
reject_runtime 1 'ALTER TABLE public.phase7_test_business DISABLE TRIGGER phase7_writer_fence'
reject_runtime 1 "UPDATE phase7_writer.state SET mode='cloud-primary' WHERE singleton"
reject_runtime 1 'TRUNCATE public.phase7_test_business'

# Initial installation fences rather than silently enabling old cloud writers.
reject_app 1 'INSERT INTO public.phase7_test_business(id) VALUES (1)'
admin -c "UPDATE phase7_writer.state SET mode='cloud-primary', site_id='cloud', epoch=1, baseline_sha256=repeat('a',64) WHERE singleton" >/dev/null
app 1 'INSERT INTO public.phase7_test_business(id) VALUES (1)' >/dev/null
runtime 1 'INSERT INTO public.phase7_test_business(id) VALUES (6)' >/dev/null
reject_runtime 2 'INSERT INTO public.phase7_test_business(id) VALUES (7)'
# Exercise the ACTUAL verifier catalog SQL using the unprivileged runtime role.
# A mocked JS row cannot catch missing catalog functions or role grants.
authority_file="$(mktemp)"
trap 'rm -f "$authority_file"; docker rm -f "$container" >/dev/null 2>&1 || true' EXIT
node --input-type=module -e 'import { PHASE7_AUTHORITY_SQL } from "./server/edge/phase7WriterGate.mjs"; process.stdout.write(PHASE7_AUTHORITY_SQL)' > "$authority_file"
docker cp "$authority_file" "$container":/tmp/phase7-authority.sql
proof="$(docker exec -e PGPASSWORD=phase7-test-app-password "$container" psql -X -At -v ON_ERROR_STOP=1 -h 127.0.0.1 -U phase7_app -d postgres -f /tmp/phase7-authority.sql)"
if [[ "$proof" != *"cloud-primary|1|"* || "$proof" != *"|t|0" ]]; then
  echo "PHASE7_AUTHORITY_CATALOG_PROOF_FAILED: $proof" >&2
  exit 1
fi
reject_app 2 'INSERT INTO public.phase7_test_business(id) VALUES (2)'
reject_app 1 "UPDATE phase7_writer.state SET mode='fenced' WHERE singleton"

# Handoff cannot overtake the last transaction from the old writer. The
# statement-level trigger takes a SHARED row lock held until COMMIT, while the
# DBA transition needs an exclusive row lock. A short-lock-timeout transition
# must fail while an old-epoch transaction is still in flight.
app 1 'BEGIN; INSERT INTO public.phase7_test_business(id) VALUES (5); SELECT pg_sleep(2); COMMIT;' >/dev/null &
writer_pid=$!
sleep 0.5
if admin -c "BEGIN; SET LOCAL lock_timeout = '200ms'; UPDATE phase7_writer.state SET mode='fenced' WHERE singleton; COMMIT;" >/dev/null 2>&1; then
  echo "PHASE7_INFLIGHT_WRITER_NOT_FENCED" >&2
  exit 1
fi
wait "$writer_pid"

# DBA freeze blocks the cloud even though the app still announces primary.
admin -c "UPDATE phase7_writer.state SET mode='fenced' WHERE singleton" >/dev/null
reject_app 1 'INSERT INTO public.phase7_test_business(id) VALUES (3)'

# DDL event trigger guards newly created tables before their creation commits.
admin <<'SQL'
CREATE TABLE public.phase7_test_new_table(id integer PRIMARY KEY);
GRANT SELECT, INSERT ON public.phase7_test_new_table TO phase7_app;
SQL
[[ "$(admin -At -c "SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relname='phase7_test_new_table' AND t.tgname='phase7_writer_fence' AND t.tgenabled='O'")" == 1 ]]
reject_app 1 'INSERT INTO public.phase7_test_new_table(id) VALUES (1)'

# Fencing and re-opening to a newer epoch invalidate all stale writers.
admin -c "UPDATE phase7_writer.state SET mode='cloud-primary', epoch=2 WHERE singleton" >/dev/null
reject_app 1 'INSERT INTO public.phase7_test_business(id) VALUES (4)'
app 2 'INSERT INTO public.phase7_test_business(id) VALUES (4)' >/dev/null
[[ "$(admin -At -c 'SELECT count(*) FROM public.phase7_test_business')" == 4 ]]
echo "PHASE7_POSTGRES_FENCE_OK: initial fence, authority transfer, role denial and DDL coverage"
