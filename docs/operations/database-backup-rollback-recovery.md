# Database Backup, Rollback, and Recovery Runbook

This runbook is the current database-safety procedure for ETSHADI ERP deployments.

It does not authorize a production restore, destructive migration, or manual data rewrite. Those actions require explicit owner approval, a current backup, and a separately verified target database.

## Core rules

1. Never apply a non-trivial production migration without a fresh backup.
2. Never test a restore by overwriting the production database.
3. Restore into a new disposable database first.
4. Keep the pre-incident database unchanged until the restored database is verified.
5. A code rollback does not automatically roll back database changes.
6. Prefer additive, backward-compatible migrations so old and new application versions can both run during rollback.
7. Never run an unreviewed SQL repair copied from logs or chat directly against production.

## Repository rehearsal objectives

The repository continuously proves the mechanics needed for recovery without touching production data:

- every push to `main` runs a disposable backup/restore rehearsal as part of exact-main certification;
- the dedicated resilience workflow also runs a weekly disposable restore rehearsal so recovery does not depend on recent application changes;
- each rehearsal creates a PostgreSQL custom-format dump, verifies the catalog and backup signature, restores into a fresh database, and re-runs schema checks;
- a critical-row fingerprint is captured before backup and after restore for `companies`, `vouchers`, `voucher_entries`, `inventory`, and `ledger_accounts`, and the rehearsal fails if the counts differ;
- restore duration is measured against a five-minute rehearsal recovery-time budget (`DR_REHEARSAL_RTO_SECONDS=300` by default in CI);
- structured evidence containing the commit, run identity, backup checksum, count fingerprints, and measured durations is retained by the dedicated resilience workflow for at least 30 days;
- schedulers remain disabled throughout the rehearsal and scheduler overlap/failure isolation is re-tested afterward.

The five-minute limit is a **CI rehearsal budget**, not a production recovery-time commitment. A disposable CI database is much smaller and simpler than the live production database.

### Production RPO and RTO

Production Recovery Point Objective (RPO) and Recovery Time Objective (RTO) depend on the hosting provider's actual backup cadence, retention, database size, restore throughput, operator availability, and the business owner's accepted data-loss window. Repository CI can prove that the recovery procedure remains executable, but it cannot certify the production backup frequency, retained restore points, or real production restore duration.

Before claiming a production RPO or RTO, an authorized operator must record the provider's backup schedule/retention and complete a timed restore rehearsal using a production-sized, non-production copy. The approved objectives and evidence location belong in the private operations record, not in repository secrets or public logs.

### Automated live-backup verification

The disposable rehearsals above prove the *mechanics* of dump/restore. The
`Maintenance - Backup Restore Verification` workflow proves the *live path*:
every Sunday at 03:11 UTC (and on manual dispatch) it dumps the real
production database, restores into an isolated scratch PostgreSQL, and fails
unless the restore preserves every row of `companies`, `vouchers`,
`voucher_entries`, `inventory`, and `ledger_accounts` and contains the `users`
and `migrations_log` tables. Each run publishes backup size, SHA-256, restore
duration, and the row-count fingerprint to its job summary.

Setup (one time, by an authorized operator):

1. In the Render dashboard, copy the production database's **External**
   connection string (GitHub Actions connects over the public internet, so
   the internal URL will not work).
2. Store it as the repository secret `BACKUP_DATABASE_URL`
   (Settings → Secrets and variables → Actions → New repository secret).
3. Run the workflow once via `workflow_dispatch` and confirm it goes green.

The workflow only ever reads production (`pg_dump` plus aggregate row
counts); it can never write to it. If the secret is missing or invalid the
run fails loudly with setup instructions — a red run means live restores are
unproven and must be treated as an open ops incident, not muted. Only
aggregate counts leave the database; no row data, credentials, or hashes
appear in logs or summaries.

## Migration risk classes

| Class | Examples | Deployment expectation | Rollback expectation |
|---|---|---|---|
| Additive | New nullable column, new table, new non-unique index | Usually compatible with old code | Roll back application code; leave additive schema in place |
| Backfill | Populate historical currency metadata, repair projected balances | Dry-run and row-count review required | Restore or execute an explicitly reviewed inverse operation |
| Constraint | Unique index, foreign key, `NOT NULL` | Audit duplicates/orphans first; prefer staged validation | Remove or relax only with a reviewed rollback migration |
| Destructive | Drop/rename column, delete or rewrite historical rows | Maintenance window and tested restore required | Restore from backup or use a tested reverse migration |

Every migration PR must state its class and rollback plan.

## Before every production deployment

Record these values in the deployment ticket or PR:

- Git commit being deployed
- Current production commit
- Render deployment identifier
- Database host/database name, without credentials
- Backup filename
- Backup timestamp
- Backup size
- Backup SHA-256
- Person approving the deployment
- Expected migration class
- Expected readiness response

### Create a PostgreSQL custom-format backup

Use a secure shell or approved database administration environment. Do not place credentials in the command history or repository.

```bash
export SOURCE_DATABASE_URL='postgresql://...'
export BACKUP_FILE="erp-$(date -u +%Y%m%dT%H%M%SZ).dump"

pg_dump \
  --format=custom \
  --no-owner \
  --no-acl \
  --file="$BACKUP_FILE" \
  "$SOURCE_DATABASE_URL"
```

A custom-format dump is preferred because `pg_restore` can list and selectively restore its contents.

### Verify the backup file without restoring it

```bash
node scripts/verify-database-backup.mjs "$BACKUP_FILE" --max-age-hours=24
```

For machine-readable evidence:

```bash
node scripts/verify-database-backup.mjs "$BACKUP_FILE" --max-age-hours=24 --json
```

This verification checks:

- File exists and is non-empty
- PostgreSQL custom or plain-SQL signature
- File age
- File size warning
- SHA-256 checksum

It does not prove that every object can be restored. A restore rehearsal is still required for destructive or high-risk work.

### Optional custom-dump catalog check

```bash
pg_restore --list "$BACKUP_FILE" > "${BACKUP_FILE}.toc.txt"
test -s "${BACKUP_FILE}.toc.txt"
```

Review the catalog for core objects such as `companies`, `vouchers`, `voucher_entries`, `inventory`, and `ledger_accounts`.

## Restore rehearsal on a disposable database

Set `RESTORE_DATABASE_URL` to a new empty database. Never point it at production.

```bash
export RESTORE_DATABASE_URL='postgresql://.../erp_restore_rehearsal'

pg_restore \
  --exit-on-error \
  --no-owner \
  --no-acl \
  --dbname="$RESTORE_DATABASE_URL" \
  "$BACKUP_FILE"
```

After restoration:

1. Point an isolated application instance at `RESTORE_DATABASE_URL`.
2. Disable schedulers with `ENABLE_SCHEDULERS=false`.
3. Do not enable automatic production tracking, WhatsApp, email, or carrier integrations.
4. Confirm `GET /api/health/ready` returns HTTP 200.
5. Confirm login with a dedicated test account or approved restored account.
6. Check representative record counts and financial totals.
7. Record the backup and restore durations and any warnings.
8. Compare the critical-row fingerprint from the source and restored databases before accepting the rehearsal.
9. Destroy the disposable database after evidence is retained.

Suggested read-only count checks:

```sql
SELECT COUNT(*) FROM companies;
SELECT COUNT(*) FROM vouchers WHERE deleted_at IS NULL;
SELECT COUNT(*) FROM voucher_entries;
SELECT COUNT(*) FROM inventory;
SELECT COUNT(*) FROM ledger_accounts WHERE deleted_at IS NULL;
```

Counts are evidence of completeness, not proof of accounting correctness. Compare them with the source snapshot taken at backup time.

## Deployment with versioned migrations

Review the migration registry first:

```bash
node scripts/verify-migration-registry.mjs --json
```

Apply registered migrations only after backup and approval:

```bash
MIGRATION_CONFIRMATION=APPLY_VERSIONED_MIGRATIONS \
  node scripts/run-versioned-migrations.mjs --apply
```

The runner uses an advisory lock and refuses to execute without both confirmations. It must not be added to an unattended production startup command until migration rehearsals are consistently successful.

## Post-deployment verification

Immediately after deployment:

1. Confirm Render marks the new instance healthy through `/api/health/ready`.
2. Confirm the response reports no missing critical tables, columns, or indexes.
3. Confirm login and company selection.
4. Open Accounts, Inventory, Daybook, POS, and the Factory dashboard.
5. Confirm no migration, readiness, pool-timeout, or repeated restart errors in logs.
6. Verify one approved non-destructive read from each major company type.
7. Do not create a test financial transaction in production unless the business owner explicitly approves it and a reversal procedure is prepared.

## Code rollback

Use code rollback when application behavior is wrong but the database remains structurally compatible.

1. Stop further deployment changes.
2. Record the failed commit and symptoms.
3. Roll Render back to the previous known-good deployment or commit.
4. Keep additive database changes in place unless they actively harm the old application.
5. Verify `/api/health/ready`, login, and the affected workflow.
6. Open a corrective branch rather than editing production manually.

Do not roll application code backward when the new schema removed or renamed something the old version requires. Restore compatibility first.

## Failed migration or readiness 503

When the new deployment returns 503 from `/api/health/ready`:

1. Keep the previous healthy Render deployment serving traffic.
2. Read the readiness response and record exact missing objects.
3. Do not bypass readiness by changing the health path back to `/api/health`.
4. Determine whether the missing object has a registered migration.
5. Review the backup and migration registry.
6. Rehearse the migration against a disposable restored database.
7. Apply the reviewed correction and redeploy.

A readiness failure is a deployment protection, not a reason to disable the guard.

## Data-corruption or historical-repair incident

1. Freeze affected writes if continued use can worsen the problem.
2. Take a second backup of the current incident state before changing anything.
3. Record affected companies, dates, modules, vouchers, accounts, and inventory rows.
4. Build a dry-run diagnostic that reports exact before/after values.
5. Review the diagnostic with the business owner.
6. Apply the repair in one transaction with an advisory lock and audit evidence.
7. Re-run reconciliation and retain the result.
8. Restore from backup only when an in-place guarded repair is unsafe or cannot be proven.

Never restore the whole database to fix a small isolated row set without first assessing newer valid transactions that would be lost.

## Full database recovery

A full recovery should normally restore into a new database and switch the application only after verification.

1. Disable writes or take the application into maintenance mode.
2. Back up the current database, even if damaged.
3. Create a new empty recovery database.
4. Restore the selected known-good backup into the new database.
5. Run readiness and read-only business verification.
6. Compare source and restored timestamps to determine the data-loss window.
7. Obtain explicit approval for the recovery point.
8. Switch `DATABASE_URL` to the verified recovered database.
9. Deploy the known-good application commit.
10. Keep the previous database available but read-only until the recovery is signed off.

## Recovery evidence checklist

- [ ] Backup file retained securely
- [ ] SHA-256 recorded
- [ ] Backup age accepted
- [ ] `pg_restore --list` completed for custom dump
- [ ] Disposable restore completed
- [ ] Source/restored critical-row fingerprint matches
- [ ] Rehearsal restore duration recorded against the recovery-time budget
- [ ] `/api/health/ready` returned 200 on restored database
- [ ] Critical table counts compared
- [ ] Financial reconciliation reviewed where applicable
- [ ] Recovery point and possible data-loss window approved
- [ ] Code commit and database target recorded
- [ ] Post-recovery logs reviewed
- [ ] Old database retained until sign-off

## Ownership and approval

The repository tooling can verify files and schema readiness, but it cannot decide whether losing transactions after a backup timestamp is acceptable. The business owner must approve the recovery point and any historical financial change.