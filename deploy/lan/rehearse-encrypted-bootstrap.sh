#!/usr/bin/env bash
# Non-destructive factory bootstrap rehearsal, NOT production promotion.
# Requires a complete, signed encrypted PostgreSQL + uploads checkpoint.
# Restores PostgreSQL to a new isolated DB in the existing private LAN server
# instance. It does not modify erp_edge, uploads, cloud DB, or write flags.
set -euo pipefail
umask 077

if [[ $# -ne 2 ]]; then
  echo "Usage: bash deploy/lan/rehearse-encrypted-bootstrap.sh /secure/edge-checkpoint-TIMESTAMP.json /secure/age-identity.txt" >&2
  exit 2
fi
if [[ "${EDGE_RESTORE_ACK:-}" != "DISPOSABLE_DATABASE_ONLY" ]]; then
  echo "EDGE_RESTORE_REHEARSAL_ACK_REQUIRED" >&2
  exit 1
fi
if [[ -z "${EDGE_SYNC_SITE_ID:-}" || -z "${EDGE_SYNC_SIGNING_KEY:-}" ]]; then
  echo "EDGE_RESTORE_MANIFEST_AUTH_MISSING" >&2
  exit 1
fi

for command in node docker age; do
  command -v "$command" >/dev/null || { echo "EDGE_RESTORE_TOOL_MISSING: $command" >&2; exit 1; }
done

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
env_file="$root/deploy/lan/.env"
compose_file="$root/deploy/lan/compose.yaml"
manifest="$(realpath -- "$1")"
identity="$(realpath -- "$2")"
if [[ ! -f "$manifest" || ! -f "$identity" || ! -f "$env_file" ]]; then
  echo "EDGE_RESTORE_REQUIRED_FILE_MISSING" >&2
  exit 1
fi
if [[ $(( $(stat -c '%a' "$identity") % 100 )) -ne 0 ]]; then
  echo "EDGE_RESTORE_IDENTITY_PERMISSIONS_UNSAFE" >&2
  exit 1
fi
if [[ $(stat -c '%a' "$env_file") != 600 ]]; then
  echo "EDGE_RESTORE_ENV_PERMISSIONS_UNSAFE" >&2
  exit 1
fi

node "$root/scripts/edge/verify-encrypted-checkpoint.mjs" "$manifest"
backup_name="$(basename -- "$manifest")"
if [[ ! "$backup_name" =~ ^edge-checkpoint-([0-9]{8}T[0-9]{6}Z)\.json$ ]]; then
  echo "EDGE_RESTORE_MANIFEST_NAME_INVALID" >&2
  exit 1
fi
backup_id="${BASH_REMATCH[1]}"
ciphertext="$(dirname -- "$manifest")/edge-db-${backup_id}.dump.age"

compose() {
  docker compose --env-file "$env_file" -f "$compose_file" "$@"
}
# Restore is always to a new database name. Never run an in-place destructive restore
# or point at the active erp_edge database.
target="erp_edge_rehearsal_$(date -u +%Y%m%d%H%M%S)_$RANDOM"
compose exec -T postgres createdb --username=erp_edge --template=template0 "$target"
printf 'Isolated restore database created: %s\n' "$target"
if ! age --decrypt --identity "$identity" "$ciphertext" |
  compose exec -T postgres pg_restore \
    --username=erp_edge --dbname="$target" \
    --no-owner --no-acl --single-transaction --exit-on-error
then
  echo "EDGE_RESTORE_REHEARSAL_FAILED. Review the isolated database; do not promote it." >&2
  exit 1
fi
compose exec -T postgres psql --username=erp_edge --dbname="$target" \
  --no-psqlrc --set=ON_ERROR_STOP=1 --tuples-only \
  --command="SELECT 'users=' || count(*) FROM public.users"
compose exec -T postgres psql --username=erp_edge --dbname="$target" \
  --no-psqlrc --set=ON_ERROR_STOP=1 --tuples-only \
  --command="SELECT 'companies=' || count(*) FROM public.companies"
echo "EDGE_RESTORE_REHEARSAL_OK: database $target is isolated and NOT active."
echo "Still required: upload-file recovery, permissions review, journal/stock reconciliation, user approval and explicit cutover."
