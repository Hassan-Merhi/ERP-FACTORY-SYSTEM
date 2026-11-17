# Financial Close and Production Migrations

## Financial close controls

- A posting date is blocked when it falls inside a `CLOSED` row in `financial_periods`.
- Closing and reopening require an authenticated actor and a non-empty reason.
- Reopening only succeeds from `CLOSED` status.
- Every close or reopen appends a SHA-256 chained event to `immutable_financial_audit_events`.
- Database triggers reject updates and deletes against immutable audit events.
- Financial corrections should be posted as new adjusting or reversing vouchers; existing audit events are never rewritten.

## Production migration rules

1. Add migrations under `migrations/` using `YYYYMMDD_NNN_description.sql`.
2. Never edit a migration after it has been applied to any shared environment.
3. Run `MIGRATION_CONFIRMATION=APPLY_SCHEMA_MIGRATIONS npm run db:migrate` with `DATABASE_URL` set before starting the new application version, then `npm run db:verify` (see database-migrations.md).
4. The runner obtains a PostgreSQL advisory lock so only one deploy can migrate at a time.
5. Each migration runs inside its own transaction.
6. The SHA-256 checksum and execution metadata are stored in `schema_migration_history`.
7. A checksum mismatch stops deployment. Repair by adding a new forward migration; do not alter history.
8. A migration present in the database but missing from the repository stops deployment.

## Pre-deployment validation

- Back up the production database.
- Confirm the application version is compatible with both the pre-migration and post-migration schema during rolling deployment.
- Run the migration runner against a restored production snapshot.
- Confirm free disk space, active locks, and long-running transactions.

## Failure and forward repair

- A failed migration is rolled back automatically.
- Correct the issue in a new migration when the failed migration was already applied elsewhere.
- Do not delete migration-history rows or bypass checksum verification.
- Keep the application on the prior compatible release until the forward repair succeeds.
