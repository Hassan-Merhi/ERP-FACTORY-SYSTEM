# Phase 7 — Backup and disaster recovery verification

## Scope implemented on the database-hardening branch

The repository **already** has:
- `scripts/verify-database-backup.mjs` (file age, format and SHA-256 check);
- `.github/workflows/resilience-rehearsal.yml` (scheduled disposable PostgreSQL backup/restore, fingerprint parity and recovery duration);
- `.github/workflows/backup-restore-verification.yml` (scheduled backup from the configured production **read-only** role, isolated restore and count checks);
- `docs/operations/database-backup-rollback-recovery.md` (recovery runbook).

This phase strengthens the **destination safety boundary** rather than duplicating the backup system:

- `scripts/verify-restore-target.mjs` / `npm run db:restore:preflight` validate a declared isolated, empty restore database **before** `pg_restore`.
- The guard requires `SOURCE_DATABASE_URL` (or `BACKUP_DATABASE_URL`) for comparison, `RESTORE_DATABASE_URL` for an independently provisioned scratch database, and exact `RESTORE_TARGET_CONFIRMATION=ISOLATED_EMPTY_RESTORE`.
- It fails if source/target resolve to the same endpoint, the target is not named as a restore database, or any public relations/sequences already exist. It checks catalog state inside `BEGIN READ ONLY` and never connects to the source database.
- The disposable resilience workflow invokes the guard after `createdb` and before `pg_restore`.
- Node regression tests cover source=target, confirmation, nonempty destination, alias collisions, and safe empty destination.

## Caveats: not production certification

- The suffix and endpoint checks are defense in depth, **not proof that the destination is isolated from production systems**. Confirm the target's host/cluster and network isolation separately; do not restore onto the production PostgreSQL cluster by mistake.
- The preflight is a point-in-time check, not a substitute for separate credentials, exclusive ownership of scratch databases, and a guarded restore orchestration.
- The live-backup workflow currently captures source counts *before* `pg_dump`; legitimate concurrent inserts/deletes can make strict row-count comparisons misleading. The disposable resilience workflow uses a stable local source and checks exact parity. For production-size assurance, use a shared consistent PostgreSQL snapshot or an application quiescence window with approved controls before asserting exact cross-snapshot row equality.
- A dump's SHA-256 and catalog listing prove its format and integrity as a file, not that all accounting records can be read and restored. Test a real restore and all critical business workflows.
- A GitHub Actions workflow definition is **not** evidence that the weekly workflow has actually run, that secrets are configured, or that backup retention meets business requirements.
- No live backup, restore, switch-over or production data modification has been performed in this phase.

## Recovery verification checklist

1. Confirm immutable off-site/provider backups, retention, encryption, RLS-compatible backup role and last successful production backup timestamp.
2. Capture source server version and extensions and use a compatible `pg_dump`/`pg_restore` client version.
3. Verify dump signature, checksum, catalog, expected size and age.
4. Provision a **new, empty, isolated** target database; independently verify DNS/cluster/database identity.
5. Run `npm run db:restore:preflight` with exact approval environment variables. Never use the production URL for `RESTORE_DATABASE_URL`.
6. Restore with `pg_restore --exit-on-error --no-owner --no-acl` into that target only.
7. Run schema readiness, RLS and trigger checks, controlled migration history/drift audit, row-count parity on a consistent snapshot, and accounting/Factory/Properties/Inventory reconciliations.
8. Verify there are no outgoing integrations/schedulers enabled in the isolated restored application.
9. Measure backup creation time, restore time, readiness-to-service time (actual RTO), and the recoverable transaction timestamp (actual RPO).
10. Record signed-off evidence; do not claim a target RPO/RTO without real measurements.
11. Retain the prior database and require separate owner approval before any real application connection switch.

## Phase 7 production exit criteria

- A recent production backup is confirmed available in the provider, with a successful cryptographic integrity check.
- At least one *real* production-sized backup is restored and tested in isolated staging.
- A qualified restore exercise proves tenant RLS, journal integrity, cash balances, rental reports, Factory scan evidence, and stock totals.
- RPO/RTO are agreed by the business and empirically measured within those goals.
- The weekly live-backup workflow is observed green and alerting is operational.
- Rollback/switchover drill and owner approval are recorded.

Only the **code and workflow guard** are implemented here; those operational exit criteria are still unverified.
