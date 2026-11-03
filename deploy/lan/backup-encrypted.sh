#!/usr/bin/env bash
# Encrypted, streaming factory edge backup (local PostgreSQL + uploads).
set -euo pipefail
umask 077
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
envfile="$root/deploy/lan/.env"
composefile="$root/deploy/lan/compose.yaml"
output="$root/deploy/lan/backups"
for tool in age docker node; do command -v "$tool" >/dev/null || { echo "EDGE_TOOL_MISSING: $tool" >&2; exit 1; }; done
node "$root/scripts/edge/verify-edge-configuration.mjs" "$envfile"
recipient="$(grep '^EDGE_BACKUP_AGE_RECIPIENT=' "$envfile" | cut -d= -f2- || true)"
if [[ ! "$recipient" =~ ^age1[a-z0-9]{58}$ ]]; then echo EDGE_BACKUP_RECIPIENT_INVALID >&2; exit 1; fi
mkdir -p "$output"
chmod 700 "$output"
now="$(date -u +%Y%m%dT%H%M%SZ)"
dbfile="$output/edge-db-$now.dump.age"
uploadsfile="$output/edge-uploads-$now.tar.age"
trap 'rm -f "$dbfile.partial" "$uploadsfile.partial"' EXIT
compose() { docker compose --env-file "$envfile" -f "$composefile" "$@"; }
compose exec -T postgres pg_dump -U erp_edge -d erp_edge -Fc --no-owner --no-acl |
  age -r "$recipient" -o "$dbfile.partial"
compose exec -T app tar -C /app -cf - uploads |
  age -r "$recipient" -o "$uploadsfile.partial"
test -s "$dbfile.partial"
test -s "$uploadsfile.partial"
mv "$dbfile.partial" "$dbfile"
mv "$uploadsfile.partial" "$uploadsfile"
printf 'Encrypted archives created:\n%s\n%s\n' "$dbfile" "$uploadsfile"
printf 'Do NOT consider backups verified until independent isolated restore succeeds.\n'
